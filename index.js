// ================================
// COMPLETE BACKEND CODE - Node.js Express Anonymous Chat Server
// ================================

// server/index.ts - Main Server Entry Point
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Static file serving for production
if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(__dirname, 'public')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeUsers: storage.getActiveUserCount()
  });
});

// ================================
// WebSocket Server Implementation
// ================================

interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

interface ChatMessage {
  type: 'message' | 'system' | 'typing' | 'stop_typing' | 'match_found' | 'partner_disconnected' | 'active_users' | 'video_call_request' | 'video_call_response' | 'video_call_end' | 'webrtc_offer' | 'webrtc_answer' | 'webrtc_ice_candidate';
  data?: any;
  message?: string;
  senderId?: string;
  timestamp?: string;
}

interface ChatUser {
  id: string;
  nickname: string;
  gender: string;
  lookingFor: string;
  partnerId?: string;
  isActive: boolean;
  lastSeen: Date;
}

interface ChatMessage {
  id: number;
  senderId: string;
  recipientId: string;
  message: string;
  timestamp: Date;
}

// ================================
// In-Memory Storage Implementation
// ================================

class MemStorage {
  private users: Map<number, any> = new Map();
  private chatUsers: Map<string, ChatUser> = new Map();
  private chatMessages: Map<number, ChatMessage> = new Map();
  private currentUserId: number = 1;
  private currentMessageId: number = 1;

  constructor() {
    // Initialize with empty maps
  }

  // User methods (for compatibility)
  async getUser(id: number): Promise<any | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<any | undefined> {
    for (const user of this.users.values()) {
      if (user.username === username) {
        return user;
      }
    }
    return undefined;
  }

  async createUser(insertUser: any): Promise<any> {
    const id = this.currentUserId++;
    const user = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  // Chat user methods
  async createChatUser(user: Omit<ChatUser, 'id'> & { id: string }): Promise<ChatUser> {
    const chatUser: ChatUser = {
      id: user.id,
      nickname: user.nickname,
      gender: user.gender,
      lookingFor: user.lookingFor,
      partnerId: user.partnerId,
      isActive: true,
      lastSeen: new Date()
    };
    
    this.chatUsers.set(user.id, chatUser);
    return chatUser;
  }

  async getChatUser(id: string): Promise<ChatUser | undefined> {
    return this.chatUsers.get(id);
  }

  async updateChatUser(id: string, updates: Partial<ChatUser>): Promise<ChatUser | undefined> {
    const user = this.chatUsers.get(id);
    if (!user) return undefined;

    const updatedUser = { ...user, ...updates };
    this.chatUsers.set(id, updatedUser);
    return updatedUser;
  }

  async deleteChatUser(id: string): Promise<boolean> {
    return this.chatUsers.delete(id);
  }

  async getUnmatchedUsers(excludeId: string, lookingFor?: string): Promise<ChatUser[]> {
    const users = Array.from(this.chatUsers.values());
    return users.filter(user => 
      user.id !== excludeId && 
      user.isActive && 
      !user.partnerId &&
      (lookingFor === 'anyone' || lookingFor === user.gender || user.lookingFor === 'anyone')
    );
  }

  async getActiveUserCount(): Promise<number> {
    return Array.from(this.chatUsers.values()).filter(user => user.isActive).length;
  }

  // Chat message methods
  async createChatMessage(message: Omit<ChatMessage, 'id'>): Promise<ChatMessage> {
    const id = this.currentMessageId++;
    const chatMessage: ChatMessage = {
      id,
      senderId: message.senderId,
      recipientId: message.recipientId,
      message: message.message,
      timestamp: new Date()
    };
    
    this.chatMessages.set(id, chatMessage);
    return chatMessage;
  }

  async getChatMessages(userId1: string, userId2: string): Promise<ChatMessage[]> {
    const messages = Array.from(this.chatMessages.values());
    return messages.filter(msg => 
      (msg.senderId === userId1 && msg.recipientId === userId2) ||
      (msg.senderId === userId2 && msg.recipientId === userId1)
    );
  }
}

const storage = new MemStorage();

// ================================
// WebSocket Server Setup
// ================================

const wss = new WebSocketServer({ 
  server: httpServer, 
  path: '/ws',
  perMessageDeflate: false
});

// User connections map
const userConnections = new Map<string, ExtendedWebSocket>();

// Broadcast active user count to all clients
const broadcastActiveUsers = async () => {
  const count = await storage.getActiveUserCount();
  const message: ChatMessage = {
    type: 'active_users',
    data: { count }
  };
  
  wss.clients.forEach((ws: ExtendedWebSocket) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
};

// Find and match users
const findMatch = async (userId: string) => {
  const user = await storage.getChatUser(userId);
  if (!user) return null;

  const availableUsers = await storage.getUnmatchedUsers(userId, user.lookingFor);
  
  if (availableUsers.length === 0) return null;

  // Find best match based on preferences
  let bestMatch = availableUsers.find(u => 
    u.lookingFor === user.gender || u.lookingFor === 'anyone'
  );

  if (!bestMatch) {
    bestMatch = availableUsers[0]; // Fallback to first available
  }

  return bestMatch;
};

// WebSocket connection handling
wss.on('connection', (ws: ExtendedWebSocket) => {
  console.log('New WebSocket connection');
  
  ws.isAlive = true;
  
  // Send initial active users count
  broadcastActiveUsers();

  ws.on('message', async (message: Buffer) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'join':
          // User joining the chat
          const { userId, nickname, gender, lookingFor } = data.data;
          
          ws.userId = userId;
          userConnections.set(userId, ws);
          
          // Create/update user in storage
          await storage.createChatUser({
            id: userId,
            nickname,
            gender,
            lookingFor,
            isActive: true,
            lastSeen: new Date()
          });
          
          // Broadcast updated user count
          broadcastActiveUsers();
          
          // Try to find a match
          const match = await findMatch(userId);
          if (match) {
            // Update both users with partner info
            await storage.updateChatUser(userId, { partnerId: match.id });
            await storage.updateChatUser(match.id, { partnerId: userId });
            
            // Send match notification to both users
            const userWs = userConnections.get(userId);
            const matchWs = userConnections.get(match.id);
            
            if (userWs && userWs.readyState === WebSocket.OPEN) {
              const matchMessage: ChatMessage = {
                type: 'match_found',
                data: {
                  partnerId: match.id,
                  partnerName: match.nickname
                }
              };
              userWs.send(JSON.stringify(matchMessage));
            }
            
            if (matchWs && matchWs.readyState === WebSocket.OPEN) {
              const partnerMatchMessage: ChatMessage = {
                type: 'match_found',
                data: {
                  partnerId: userId,
                  partnerName: nickname
                }
              };
              matchWs.send(JSON.stringify(partnerMatchMessage));
            }
          }
          break;

        case 'message':
          // Chat message
          if (ws.userId) {
            const sender = await storage.getChatUser(ws.userId);
            if (sender && sender.partnerId) {
              const recipientWs = userConnections.get(sender.partnerId);
              
              if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                const messageData: ChatMessage = {
                  type: 'message',
                  message: data.message,
                  senderId: ws.userId,
                  timestamp: data.timestamp
                };
                recipientWs.send(JSON.stringify(messageData));
              }
              
              // Store message in database
              await storage.createChatMessage({
                senderId: ws.userId,
                recipientId: sender.partnerId,
                message: data.message,
                timestamp: new Date()
              });
            }
          }
          break;

        case 'typing':
          // Typing indicator
          if (ws.userId) {
            const sender = await storage.getChatUser(ws.userId);
            if (sender && sender.partnerId) {
              const recipientWs = userConnections.get(sender.partnerId);
              
              if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                recipientWs.send(JSON.stringify({ type: 'typing' }));
              }
            }
          }
          break;

        case 'stop_typing':
          // Stop typing indicator
          if (ws.userId) {
            const sender = await storage.getChatUser(ws.userId);
            if (sender && sender.partnerId) {
              const recipientWs = userConnections.get(sender.partnerId);
              
              if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                recipientWs.send(JSON.stringify({ type: 'stop_typing' }));
              }
            }
          }
          break;

        case 'next_chat':
          // Find next chat partner
          if (ws.userId) {
            const user = await storage.getChatUser(ws.userId);
            if (user && user.partnerId) {
              // Notify current partner about disconnection
              const partnerWs = userConnections.get(user.partnerId);
              if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
                partnerWs.send(JSON.stringify({ type: 'partner_disconnected' }));
              }
              
              // Clear partner for both users
              await storage.updateChatUser(user.partnerId, { partnerId: undefined });
              await storage.updateChatUser(ws.userId, { partnerId: undefined });
            }
            
            // Try to find new match
            const newMatch = await findMatch(ws.userId);
            if (newMatch) {
              await storage.updateChatUser(ws.userId, { partnerId: newMatch.id });
              await storage.updateChatUser(newMatch.id, { partnerId: ws.userId });
              
              const userWs = userConnections.get(ws.userId);
              const matchWs = userConnections.get(newMatch.id);
              
              if (userWs && userWs.readyState === WebSocket.OPEN) {
                const matchMessage: ChatMessage = {
                  type: 'match_found',
                  data: {
                    partnerId: newMatch.id,
                    partnerName: newMatch.nickname
                  }
                };
                userWs.send(JSON.stringify(matchMessage));
              }
              
              if (matchWs && matchWs.readyState === WebSocket.OPEN) {
                const user = await storage.getChatUser(ws.userId);
                const partnerMatchMessage: ChatMessage = {
                  type: 'match_found',
                  data: {
                    partnerId: ws.userId,
                    partnerName: user?.nickname || 'Anonymous'
                  }
                };
                matchWs.send(JSON.stringify(partnerMatchMessage));
              }
            }
          }
          break;

        case 'video_call_request':
          // Video call request
          if (ws.userId) {
            const recipientWs = userConnections.get(data.data.to);
            if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
              recipientWs.send(JSON.stringify({
                type: 'video_call_request',
                data: {
                  from: data.data.from
                }
              }));
            }
          }
          break;

        case 'video_call_response':
          // Video call response
          if (ws.userId) {
            const callerWs = userConnections.get(data.data.to);
            if (callerWs && callerWs.readyState === WebSocket.OPEN) {
              callerWs.send(JSON.stringify({
                type: 'video_call_response',
                data: {
                  accepted: data.data.accepted
                }
              }));
            }
          }
          break;

        case 'video_call_end':
          // Video call end
          if (ws.userId) {
            const recipientWs = userConnections.get(data.data.to);
            if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
              recipientWs.send(JSON.stringify({
                type: 'video_call_end'
              }));
            }
          }
          break;

        case 'webrtc_offer':
          // WebRTC offer
          if (ws.userId) {
            const sender = await storage.getChatUser(ws.userId);
            if (sender && sender.partnerId) {
              const recipientWs = userConnections.get(sender.partnerId);
              if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                recipientWs.send(JSON.stringify({
                  type: 'webrtc_offer',
                  data: data.data
                }));
              }
            }
          }
          break;

        case 'webrtc_answer':
          // WebRTC answer
          if (ws.userId) {
            const sender = await storage.getChatUser(ws.userId);
            if (sender && sender.partnerId) {
              const recipientWs = userConnections.get(sender.partnerId);
              if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                recipientWs.send(JSON.stringify({
                  type: 'webrtc_answer',
                  data: data.data
                }));
              }
            }
          }
          break;

        case 'webrtc_ice_candidate':
          // WebRTC ICE candidate
          if (ws.userId) {
            const sender = await storage.getChatUser(ws.userId);
            if (sender && sender.partnerId) {
              const recipientWs = userConnections.get(sender.partnerId);
              if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                recipientWs.send(JSON.stringify({
                  type: 'webrtc_ice_candidate',
                  data: data.data
                }));
              }
            }
          }
          break;
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });

  ws.on('close', async () => {
    console.log('WebSocket connection closed');
    
    if (ws.userId) {
      const user = await storage.getChatUser(ws.userId);
      if (user) {
        // Notify partner about disconnection
        if (user.partnerId) {
          const partnerWs = userConnections.get(user.partnerId);
          if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
            partnerWs.send(JSON.stringify({ type: 'partner_disconnected' }));
          }
          
          // Clear partner relationship
          await storage.updateChatUser(user.partnerId, { partnerId: undefined });
        }
        
        // Remove user from storage
        await storage.deleteChatUser(ws.userId);
        userConnections.delete(ws.userId);
        
        // Broadcast updated user count
        broadcastActiveUsers();
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Heartbeat mechanism
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// Heartbeat interval
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws: ExtendedWebSocket) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000); // 30 seconds

// Cleanup on server shutdown
process.on('SIGTERM', () => {
  clearInterval(heartbeatInterval);
  wss.close();
  httpServer.close();
});

// ================================
// Database Schema (for reference)
// ================================

/*
// shared/schema.ts - Database Schema

export interface User {
  id: number;
  username: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatUser {
  id: string;
  nickname: string;
  gender: string;
  lookingFor: string;
  partnerId?: string;
  isActive: boolean;
  lastSeen: Date;
}

export interface ChatMessage {
  id: number;
  senderId: string;
  recipientId: string;
  message: string;
  timestamp: Date;
}

export type InsertUser = Omit<User, 'id' | 'createdAt' | 'updatedAt'>;
export type InsertChatUser = Omit<ChatUser, 'lastSeen'>;
export type InsertChatMessage = Omit<ChatMessage, 'id' | 'timestamp'>;
*/

// ================================
// Error Handling Middleware
// ================================

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ================================
// Server Startup
// ================================

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toLocaleTimeString()}] [express] serving on port ${PORT}`);
});

// ================================
// Graceful Shutdown
// ================================

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  clearInterval(heartbeatInterval);
  wss.close(() => {
    console.log('WebSocket server closed');
    httpServer.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });
});

// ================================
// Development Helper Functions
// ================================

const logInfo = (message: string) => {
  console.log(`[${new Date().toLocaleTimeString()}] [info] ${message}`);
};

const logError = (message: string, error?: any) => {
  console.error(`[${new Date().toLocaleTimeString()}] [error] ${message}`, error || '');
};

// Export for testing
export { app, httpServer, wss, storage };

// ================================
// Package.json Configuration
// ================================

/*
{
  "name": "anonymous-chat-backend",
  "version": "1.0.0",
  "type": "module",
  "license": "MIT",
  "scripts": {
    "dev": "NODE_ENV=development tsx server/index.ts",
    "build": "esbuild server/index.ts --platform=node --packages=external --bundle --format=esm --outdir=dist",
    "start": "NODE_ENV=production node dist/index.js",
    "check": "tsc"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.14.2",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.4",
    "@types/ws": "^8.5.9",
    "@types/uuid": "^9.0.7",
    "esbuild": "^0.19.8",
    "tsx": "^4.6.0",
    "typescript": "^5.3.3"
  }
}
*/

// ================================
// Environment Variables
// ================================

/*
// .env.example
NODE_ENV=development
PORT=5000

// .env.production
NODE_ENV=production
PORT=5000
*/

// ================================
// Deployment Configuration
// ================================

/*
// railway.json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm install && npm run build"
  },
  "deploy": {
    "startCommand": "node dist/index.js",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}

// render.yaml
services:
  - type: web
    name: anonymous-chat-backend
    env: node
    buildCommand: npm install && npm run build
    startCommand: node dist/index.js
    envVars:
      - key: NODE_ENV
        value: production
    autoDeploy: false
*/
