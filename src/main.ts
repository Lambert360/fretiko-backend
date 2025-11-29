import { config } from 'dotenv';
config(); // Load environment variables first

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { SocketIoAdapter } from './realtime/socket-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Enable CORS for frontend
  app.enableCors({
    origin: ['http://localhost:3001', 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Configure custom Socket.IO adapter
  console.log('🔧 Configuring Socket.IO adapter...');
  const socketAdapter = new SocketIoAdapter(app);
  await socketAdapter.connectToRedis(); // Initialize adapter (currently no-op)
  app.useWebSocketAdapter(socketAdapter);
  console.log('✅ Socket.IO adapter configured');

  // Global validation for inputs
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Connect to auth microservice (temporarily disabled for debugging)
  // app.connectMicroservice<MicroserviceOptions>({
  //   transport: Transport.TCP,
  //   options: { port: 3003 },
  // });

  // await app.startAllMicroservices();
  const port = configService.get<number>('PORT') || 3000;
  // Listen on 0.0.0.0 to accept connections from mobile devices/emulators
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Server is running on http://0.0.0.0:${port}`);
  console.log(`📱 Mobile devices can connect via your network IP on port ${port}`);
}
bootstrap();