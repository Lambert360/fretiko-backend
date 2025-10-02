# 🛍️ Fretiko Backend

A social commerce platform backend built with NestJS microservices and Supabase.

## 🚀 Features

- **Authentication**: Signup/signin with Supabase Auth + JWT tokens
- **Microservices Architecture**: Scalable service-based design
- **Real-time Ready**: Built for chat, notifications, live streaming
- **Security**: Input validation, JWT guards, environment variables
- **Social Commerce**: E-commerce + social features + logistics

## 🏗️ Current Architecture

```
fretiko-backend/
├── src/
│   ├── auth/           # Authentication microservice
│   ├── shared/         # Shared utilities (Supabase client, DTOs)
│   ├── main.ts         # Gateway server (port 3000)
│   └── app.module.ts   # Root module
├── test-auth.js        # Test auth endpoints
├── test-simple.js      # Simple signup test
└── .env               # Environment variables
```

## ⚡ Quick Start

### 1. Install Dependencies (if not already done)
```bash
npm install
```

### 2. Set Up Environment
Your `.env` file should contain:
```env
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_anon_key
JWT_SECRET=your_jwt_secret
PORT=3000
```

### 3. Start the Server
```bash
# Development mode (recommended)
npm run start:dev

# Production mode
npm run start:prod
```

### 4. Test Your Setup
```bash
# Test just signup
node test-simple.js

# Test full auth flow (signup + signin)
node test-auth.js
```

## 📡 Available Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| POST | `/auth/signup` | Create new user account |
| POST | `/auth/signin` | Login existing user |

### Example: Signup Request
```bash
curl -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "securepass123",
    "firstName": "John",
    "lastName": "Doe"
  }'
```

## 🛠️ Development Commands

```bash
# Start development server
npm run start:dev

# Run tests
npm run test

# Lint code
npm run lint

# Build for production
npm run build
```

## 🔧 Project Structure Explained

- **Gateway (main.ts)**: Routes incoming requests to appropriate microservices
- **Auth Service**: Handles user authentication via Supabase
- **Shared Module**: Common utilities like Supabase client and DTOs
- **Microservices**: TCP communication between services (port 3001+)

## 🔒 Security Features

- ✅ Input validation with class-validator
- ✅ JWT token authentication
- ✅ Environment variables for secrets
- ✅ Supabase Auth integration
- ✅ Password hashing ready (bcrypt)

## 🎯 Next Steps for Development

1. **Add more microservices**: products, users, chat, payments
2. **Set up database tables** in Supabase for products, orders, etc.
3. **Add authentication guards** for protected routes
4. **Implement file upload** for product images
5. **Add real-time features** with Supabase subscriptions

## 🐛 Troubleshooting

**Server won't start?**
- Check if port 3000 is available
- Verify your `.env` file has correct Supabase credentials

**Authentication failing?**
- Test your Supabase connection
- Check if email confirmation is disabled in Supabase settings

**Dependencies issues?**
```bash
rm -rf node_modules package-lock.json
npm install
```

## 📚 Learn More

- [NestJS Documentation](https://docs.nestjs.com)
- [Supabase Documentation](https://supabase.com/docs)
- [Microservices with NestJS](https://docs.nestjs.com/microservices/basics)

---

**Built with ❤️ for social commerce**