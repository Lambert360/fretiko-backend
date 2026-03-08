import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { SocialAuthService } from './social-auth.service';
import { EmailService } from './email.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1h' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [AuthService, JwtAuthGuard, OptionalJwtAuthGuard, SocialAuthService, EmailService],
  controllers: [AuthController],
  exports: [AuthService, JwtModule, JwtAuthGuard, OptionalJwtAuthGuard, SocialAuthService, EmailService],
})
export class AuthModule {}