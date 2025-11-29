import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MulterModule } from '@nestjs/platform-express';
import { AuditModule } from '../audit/audit.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { StaffJwtAuthGuard } from './guards/staff-jwt-auth.guard';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => AuditModule), // Use forwardRef to resolve circular dependency
    MulterModule.register({
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET') || 'your-secret-key-change-in-production',
        signOptions: {
          expiresIn: '8h', // Access token expires in 8 hours
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [StaffController],
  providers: [StaffService, PermissionsGuard, StaffJwtAuthGuard],
  exports: [
    StaffService, 
    PermissionsGuard, 
    StaffJwtAuthGuard,
    JwtModule, // Export JwtModule for other modules
    ConfigModule,
  ],
})
export class StaffModule {}
