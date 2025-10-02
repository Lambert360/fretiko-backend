# Fretiko Notification System Setup

## Backend Dependencies

Run these commands in the fretiko-backend directory:

```bash
npm install expo-server-sdk socket.io @nestjs/websockets
```

These packages provide:
- `expo-server-sdk`: Official Expo SDK for sending push notifications from the server
- `socket.io`: WebSocket library for real-time notifications
- `@nestjs/websockets`: NestJS WebSocket support

## Features Implemented

### 1. Real-time WebSocket Notifications
- WebSocket gateway at `/notifications` namespace
- JWT token authentication for WebSocket connections
- Real-time events: `notification:new`, `notification:stats`, `notification:markAsRead`
- User room management for targeted message delivery

### 2. Push Notifications
- Expo push notification service with token management
- Automatic invalid token cleanup
- User preference filtering (quiet hours, notification types)
- Notification formatting based on type and priority

### 3. Database Schema
- Complete notification tables with RLS policies
- Notification settings with push token storage
- Performance-optimized indexes and cleanup functions

### 4. API Endpoints
- Full CRUD operations for notifications
- Push token registration: `POST /notifications/push-token`
- Push token removal: `DELETE /notifications/push-token`
- Real-time statistics and filtering

## Mobile App Integration

The mobile app notification service has been updated to:
- Register/unregister push tokens via new API endpoints
- Connect to WebSocket for real-time updates
- Handle notification stats and real-time events

## Environment Variables Required

Add to your `.env` file:
```
SUPABASE_JWT_SECRET=your_supabase_jwt_secret
```

## Usage

1. Users receive notifications via WebSocket when online
2. Push notifications sent automatically when users are offline or app is backgrounded
3. Notification preferences control which types of notifications are sent
4. Invalid push tokens are automatically cleaned up