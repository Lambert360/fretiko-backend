# Fretiko Backend Setup Guide

## What We Just Built 🏗️

A NestJS microservices backend for Fretiko with:
- **Authentication Service**: User signup/signin with Supabase
- **JWT Tokens**: Secure user sessions
- **Microservices Architecture**: Ready to add more services (products, chat, etc.)
- **Input Validation**: All user data is checked before processing

## Quick Start (Copy & Paste Ready!)

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Up Supabase
1. Go to [supabase.com](https://supabase.com) and create account
2. Create new project named "fretiko"
3. Go to **Settings → API** in your dashboard
4. Copy URL and anon key to `.env` file:

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_KEY=your-anon-public-key-from-dashboard
JWT_SECRET=7f3e4d2a8b9c6e1f4a7d3b8e5c2f9a6b3d8e1f4a7b2c5e8f1a4d7b3e6c9f2a5d8
PORT=3000
```

### 3. Start the Server
```bash
npm run start:dev
```

### 4. Test It Works
```bash
node test-auth.js
```

You should see:
```
🚀 Testing Fretiko Auth Service...
✅ Server is running!
✅ User signup successful!
✅ User signin successful!
🎉 All tests passed!
```

## API Endpoints

### POST `/auth/signup`
Create a new user account.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "firstName": "John",
  "lastName": "Doe"
}
```

**Response:**
```json
{
  "user": {
    "id": "uuid-here",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe"
  },
  "accessToken": "jwt-token-here",
  "refreshToken": "refresh-token-here"
}
```

### POST `/auth/signin`
Sign in an existing user.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:** Same as signup

## Project Structure Explained

```
src/
├── shared/                 # Code used by multiple services
│   ├── supabase.client.ts # Supabase connection setup
│   └── dto/               # Data shapes for API requests/responses
│       └── auth.dto.ts    # Login/signup form validation
├── auth/                  # Authentication microservice
│   ├── auth.controller.ts # API endpoints (/auth/signup, /auth/signin)
│   ├── auth.service.ts    # Business logic (talks to Supabase)
│   └── auth.module.ts     # Service configuration
└── main.ts               # App startup and microservice setup
```

## What's Next?

Now you can add more microservices for:
- **Products Service**: Create/list/search products
- **Chat Service**: Real-time messaging
- **Payments Service**: Handle transactions
- **Logistics Service**: Courier tracking

Each service follows the same pattern:
1. Create folder in `src/`
2. Add controller (API endpoints)
3. Add service (business logic)
4. Add module (configuration)
5. Update `app.module.ts` to include it

## Troubleshooting

**"Supabase credentials not found"**: Update your `.env` file with real values from supabase.com

**"ECONNREFUSED"**: Make sure server is running with `npm run start:dev`

**"Invalid email or password"**: User doesn't exist yet, try signup first

**Port already in use**: Change `PORT=3001` in `.env` file