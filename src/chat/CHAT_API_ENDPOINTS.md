# Chat API Endpoints

This document describes the new endpoints added for conversation management, real-time features, and user status tracking.

## Conversation Management

### Mark Conversation as Read
```
PUT /chat/conversations/:conversationId/read
```
Marks all messages in a conversation as read for the current user.

### Archive Conversation
```
PUT /chat/conversations/:conversationId/archive
```
Archives a conversation for the current user (hides from main conversation list).

### Unarchive Conversation
```
PUT /chat/conversations/:conversationId/unarchive
```
Restores an archived conversation to the main conversation list.

### Pin/Unpin Conversation
```
PUT /chat/conversations/:conversationId/pin
Body: { "isPinned": boolean }
```
Toggles pin status for a conversation (pinned conversations appear at top).

### Mute/Unmute Conversation
```
PUT /chat/conversations/:conversationId/mute
Body: { "isMuted": boolean }
```
Toggles mute status for a conversation (muted conversations don't send notifications).

## Typing Indicators

### Update Typing Status
```
POST /chat/conversations/:conversationId/typing
Body: { "isTyping": boolean }
```
Updates typing status for the current user in a conversation. This triggers real-time events to other participants.

## User Status

### Get User Status
```
GET /chat/users/:userId/status
```
Returns online status and last seen time for a specific user.

Response:
```json
{
  "success": true,
  "data": {
    "userId": "string",
    "isOnline": boolean,
    "lastSeen": "ISO_8601_timestamp"
  }
}
```

### Update User Status
```
PUT /chat/users/status
Body: { "isOnline": boolean }
```
Updates the current user's online status.

## Conversation Filtering

The existing `GET /chat/conversations` endpoint now supports additional query parameters:

- `chatType`: Filter by conversation type (ai, vendor, rider, support)
- `search`: Search in conversation names and descriptions
- `includeArchived`: Include archived conversations in results
- `archivedOnly`: Show only archived conversations
- `page`: Page number for pagination
- `limit`: Number of conversations per page

Example:
```
GET /chat/conversations?chatType=vendor&search=electronics&page=1&limit=10
```

## Real-time Features

The application now includes WebSocket support for real-time updates:

### WebSocket Connection
Connect to: `ws://your-backend-url/chat`

### Authentication
Include the JWT token in the connection:
```javascript
const socket = io('/chat', {
  auth: {
    token: 'your-jwt-token'
  }
});
```

### Events

#### Client to Server:
- `join_conversation` - Join a conversation room
- `leave_conversation` - Leave a conversation room
- `typing_start` - Start typing in a conversation
- `typing_stop` - Stop typing in a conversation
- `message_read` - Mark a message as read

#### Server to Client:
- `chat_message` - New message received
- `chat_typing` - Typing indicator update
- `user_status` - User online/offline status change
- `message_status` - Message read receipt
- `conversation_update` - Conversation metadata update

## Authentication

All endpoints require JWT authentication via the `Authorization` header:
```
Authorization: Bearer <your-jwt-token>
```

## Error Responses

All endpoints return consistent error responses:
```json
{
  "success": false,
  "message": "Error description",
  "statusCode": 400
}
```

## Installation Requirements

To use the WebSocket features, install the following dependencies:

```bash
npm install @nestjs/websockets @nestjs/platform-socket.io socket.io
```

## Database Schema Updates

The following database columns are expected in your Supabase schema:

### chat_participants table:
- `is_archived` (boolean, default: false)
- `archived_at` (timestamp, nullable)
- `pinned_at` (timestamp, nullable)
- `muted_at` (timestamp, nullable)

### user_profiles table:
- `is_online` (boolean, default: false)
- `last_seen` (timestamp)

Make sure to add these columns to your Supabase database for full functionality.