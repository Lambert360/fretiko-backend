import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

export class SocketIoAdapter extends IoAdapter {
  async connectToRedis(): Promise<void> {
    // No Redis needed for now - using memory adapter
    console.log('📡 Socket.IO adapter initialized (memory-based)');
  }

  createIOServer(port: number, options?: ServerOptions): any {
    console.log('🚀 CustomAdapter.createIOServer called with port:', port);
    console.log('📋 Options:', options);

    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      allowEIO3: true,
    });

    console.log('🔌 Socket.IO server created with custom adapter');
    console.log('🏠 Server.sockets exists:', !!server.sockets);
    console.log('🏠 Server.sockets.adapter exists:', !!server.sockets?.adapter);

    // Force adapter check after brief delay and store reference globally
    setTimeout(() => {
      console.log('🕐 Delayed adapter check:');
      console.log('   - server.sockets:', !!server.sockets);
      console.log('   - server.sockets.adapter:', !!server.sockets?.adapter);
      console.log('   - adapter type:', server.sockets?.adapter?.constructor.name);

      // Store the working server instance globally for gateway access
      (global as any).socketIOServer = server;
      console.log('🌐 Stored working Socket.IO server globally');
    }, 1000);

    // Log adapter initialization
    server.on('connection', (socket) => {
      console.log(`🔗 Socket connected: ${socket.id}`);
      console.log(`🏠 Adapter type: ${server.sockets.adapter.constructor.name}`);
    });

    return server;
  }
}