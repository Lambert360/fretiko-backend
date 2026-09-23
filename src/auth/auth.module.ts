import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { MfaService } from './mfa.service';
import { MfaController } from './mfa.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { SocialAuthService } from './social-auth.service';
import { EmailService } from './email.service';
import { TokenService } from './token.service';
import { SupabaseClientManager } from './supabase-client-manager.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    AuthService, 
    MfaService,
    JwtAuthGuard, 
    OptionalJwtAuthGuard, 
    SocialAuthService, 
    EmailService, 
    TokenService,
    SupabaseClientManager
  ],
  controllers: [AuthController, MfaController],
  exports: [
    AuthService, 
    MfaService,
    JwtModule, 
    JwtAuthGuard, 
    OptionalJwtAuthGuard, 
    SocialAuthService, 
    EmailService, 
    TokenService,
    SupabaseClientManager,
  ],
})
export class AuthModule {}