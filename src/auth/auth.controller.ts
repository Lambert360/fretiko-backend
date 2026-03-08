import { 
  Controller, 
  Post, 
  Body, 
  Get, 
  Req, 
  Res, 
  HttpStatus,
  ValidationPipe,
  HttpCode,
  Header,
  UseGuards
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { MessagePattern } from '@nestjs/microservices';
import { AuthService } from './auth.service';
import type { SignUpDto, SignInDto, MigrateAccountDto } from '../shared/dto/auth.dto';
import type { 
  SocialAuthDto, 
  SocialAuthResponse, 
  LinkSocialAccountDto, 
  UnlinkSocialAccountDto 
} from './dto/social-auth.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
import type { VerifyTokenDto, ResendTokenDto } from './dto/verify-token.dto';
import { SocialAuthService } from './social-auth.service';
import { createSupabaseClient } from '../shared/supabase.client';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

@Controller('auth')
export class AuthController {
  private supabase;

  constructor(
    private readonly authService: AuthService,
    private readonly socialAuthService: SocialAuthService,
    private readonly configService: ConfigService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
  }

  @MessagePattern('ping')
  ping() {
    return 'Auth microservice is alive!';
  }

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async signUp(@Req() req: Request) {
    // Debug logging to see raw request body
    console.log(' Raw request headers:', req.headers);
    console.log(' Raw request body:', req.body);
    
    // Manual DTO parsing
    const signUpDto = {
      email: req.body?.email,
      password: req.body?.password,
      firstName: req.body?.firstName,
      lastName: req.body?.lastName,
      dateOfBirth: req.body?.dateOfBirth || null, // Handle undefined
      gender: req.body?.gender || null, // Handle undefined
      hasAcceptedTerms: req.body?.hasAcceptedTerms
    };
    
    console.log(' Manual parsed DTO:', signUpDto);
    console.log(' hasAcceptedTerms from manual parse:', signUpDto.hasAcceptedTerms, 'type:', typeof signUpDto.hasAcceptedTerms);
    
    try {
      const result = await this.authService.signUp(signUpDto as any);

      return {
        success: true,
        message: result.requiresEmailVerification
          ? 'Account created successfully. Please check your email to verify your account.'
          : 'Account created successfully',
        requiresEmailVerification: result.requiresEmailVerification,
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    } catch (error) {
      throw error; // Let the error filter handle the response format
    }
  }

  @Post('signin')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60 } }) // 5 attempts per minute
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async signIn(@Body(new ValidationPipe()) signInDto: SignInDto) {
    return this.authService.signIn(signInDto);
  }

  @Post('migrate')
  @HttpCode(HttpStatus.OK)
  async migrateAccount(@Body(new ValidationPipe()) migrateDto: MigrateAccountDto) {
    return this.authService.migrateAccount(migrateDto.email, migrateDto.newPassword);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body(new ValidationPipe()) resetDto: { email: string }) {
    try {
      const result = await this.authService.resetPassword(resetDto.email);

      return {
        success: result.success,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to process password reset request',
      };
    }
  }

  @Get('check-email-availability')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-cache')
  async checkEmailAvailability(@Req() req: Request) {
    const email = req.query.email as string;
    
    if (!email) {
      return {
        success: false,
        message: 'Email is required',
      };
    }

    try {
      const isAvailable = await this.authService.checkEmailAvailability(email);
      
      return {
        success: true,
        available: isAvailable,
        message: isAvailable ? 'Email is available' : 'Email is already registered',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to check email availability',
      };
    }
  }

  // =====================================================
  // SOCIAL AUTHENTICATION ENDPOINTS
  // =====================================================

  @Post('social/signin')
  async socialSignIn(@Body() socialAuthDto: SocialAuthDto, @Req() req: Request) {
    return this.socialAuthService.authenticateWithSocialProvider(
      socialAuthDto,
      req.ip,
      req.get('User-Agent')
    );
  }

  @Post('social/link')
  async linkSocialAccount(@Body() linkDto: LinkSocialAccountDto, @Req() req: Request) {
    // This endpoint requires authentication - get user ID from token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        success: false,
        message: 'Authentication required',
      };
    }

    const token = authHeader.split(' ')[1];
    try {
      // Verify token and get user ID
      const { data } = await this.supabase.auth.getUser(token);
      if (!data.user) {
        return {
          success: false,
          message: 'Invalid authentication token',
        };
      }

      return this.socialAuthService.linkSocialAccount(data.user.id, linkDto);
    } catch (error) {
      return {
        success: false,
        message: 'Authentication failed',
      };
    }
  }

  @Post('social/unlink')
  async unlinkSocialAccount(@Body() unlinkDto: UnlinkSocialAccountDto, @Req() req: Request) {
    // This endpoint requires authentication - get user ID from token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        success: false,
        message: 'Authentication required',
      };
    }

    const token = authHeader.split(' ')[1];
    try {
      // Verify token and get user ID
      const { data } = await this.supabase.auth.getUser(token);
      if (!data.user) {
        return {
          success: false,
          message: 'Invalid authentication token',
        };
      }

      return this.socialAuthService.unlinkSocialAccount(data.user.id, unlinkDto.provider);
    } catch (error) {
      return {
        success: false,
        message: 'Authentication failed',
      };
    }
  }

  // Microservice message patterns (for inter-service communication)
  @MessagePattern('auth.signup')
  async handleSignUp(data: SignUpDto) {
    return this.authService.signUp(data);
  }

  @MessagePattern('auth.signin')
  async handleSignIn(data: SignInDto) {
    return this.authService.signIn(data);
  }

  // =====================================================
  // EMAIL VERIFICATION ENDPOINTS
  // =====================================================

  @Post('verify-email-token')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } }) // 10 attempts per minute
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async verifyEmailToken(@Body(new ValidationPipe()) verifyTokenDto: VerifyTokenDto, @Req() req: Request) {
    try {
      const result = await this.authService.verifyEmailToken(
        verifyTokenDto.token,
        verifyTokenDto.email,
        verifyTokenDto.ipAddress || req.ip,
        verifyTokenDto.userAgent || req.get('User-Agent')
      );

      return {
        success: true,
        message: 'Email verified successfully',
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Email verification failed',
      };
    }
  }

  @Post('resend-verification-token')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 300 } }) // 3 attempts per 5 minutes
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async resendVerificationToken(@Body(new ValidationPipe()) resendTokenDto: ResendTokenDto, @Req() req: Request) {
    try {
      const result = await this.authService.resendVerificationToken(
        resendTokenDto.email,
        resendTokenDto.ipAddress || req.ip,
        resendTokenDto.userAgent || req.get('User-Agent')
      );

      return {
        success: true,
        message: result.message,
        token: result.token, // For testing purposes
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to resend verification token',
      };
    }
  }
}