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
import { TokenService } from './token.service';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

@Controller('auth')
export class AuthController {
  private supabase;

  constructor(
    private readonly authService: AuthService,
    private readonly socialAuthService: SocialAuthService,
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
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
  async signIn(@Req() req: Request) {
    // Debug logging to see raw request body
    console.log(' Raw request headers:', req.headers);
    console.log(' Raw request body:', req.body);
    
    // Manual DTO parsing
    const signInDto = {
      email: req.body?.email,
      password: req.body?.password,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    };
    
    console.log(' Manual parsed DTO:', signInDto);
    
    try {
      const result = await this.authService.signIn(signInDto as any);

      return {
        success: true,
        message: 'Signed in successfully',
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    } catch (error) {
      throw error; // Let the error filter handle the response format
    }
  }

  @Post('send-verification-email')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async sendVerificationEmail(@Req() req: Request) {
    try {
      // Debug: Log raw request body
      console.log(' Raw request body:', req.body);
      
      // Manual DTO parsing (same as signup endpoint)
      const signUpDto = {
        email: req.body?.email,
        password: req.body?.password,
        firstName: req.body?.firstName,
        lastName: req.body?.lastName,
        dateOfBirth: req.body?.dateOfBirth || null,
        gender: req.body?.gender || null,
        hasAcceptedTerms: req.body?.hasAcceptedTerms
      };
      
      console.log(' Manual parsed DTO:', signUpDto);
      console.log(' Email from manual parse:', signUpDto.email);
      
      // Use the new signup method which handles verification email sending
      const result = await this.authService.signUp(signUpDto as any);

      return {
        success: true,
        message: 'Verification email sent successfully. Please check your email.',
        email: signUpDto.email,
        requiresEmailVerification: result.requiresEmailVerification,
      };
    } catch (error) {
      throw error; // Let the error filter handle the response format
    }
  }

  @Post('create-verified-user')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async createVerifiedUser(@Req() req: Request) {
    try {
      // Manual DTO parsing
      const signUpDto = {
        email: req.body?.email,
        password: req.body?.password,
        firstName: req.body?.firstName,
        lastName: req.body?.lastName,
        dateOfBirth: req.body?.dateOfBirth || null,
        gender: req.body?.gender || null,
        hasAcceptedTerms: req.body?.hasAcceptedTerms,
        user_role: req.body?.user_role,
        is_seller: req.body?.is_seller,
        is_rider: req.body?.is_rider,
        ipAddress: req.body?.ipAddress,
        userAgent: req.body?.userAgent,
      };
      
      const result = await this.authService.createVerifiedUser(signUpDto as any);

      return {
        success: true,
        message: 'Account created successfully! Welcome to Fretiko.',
        user: result.user,
      };
    } catch (error) {
      throw error; // Let the error filter handle the response format
    }
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

  @Post('verify-reset-token')
  @HttpCode(HttpStatus.OK)
  async verifyResetToken(@Body(new ValidationPipe()) verifyDto: { email: string; token: string }) {
    try {
      const result = await this.authService.verifyResetToken(verifyDto.email, verifyDto.token);

      return {
        valid: result.valid,
        message: result.message,
      };
    } catch (error) {
      return {
        valid: false,
        message: error.message || 'Failed to verify reset token',
      };
    }
  }

  @Post('confirm-reset-password')
  @HttpCode(HttpStatus.OK)
  async confirmResetPassword(@Body(new ValidationPipe()) confirmDto: { 
    email: string; 
    token: string; 
    newPassword: string 
  }) {
    try {
      const result = await this.authService.confirmResetPassword(
        confirmDto.email, 
        confirmDto.token, 
        confirmDto.newPassword
      );

      return {
        success: result.success,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to reset password',
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
  async verifyEmailToken(@Req() req: Request) {
    // Enhanced logging for production debugging
    console.log('🔍 [PROD DEBUG] Email verification request received');
    console.log('🔍 [PROD DEBUG] Request headers:', req.headers);
    console.log('🔍 [PROD DEBUG] Request body:', req.body);
    console.log('🔍 [PROD DEBUG] Client IP:', req.ip);
    console.log('🔍 [PROD DEBUG] User-Agent:', req.get('User-Agent'));
    console.log('🔍 [PROD DEBUG] Request timestamp:', new Date().toISOString());
    
    // Manual DTO parsing (same as signup endpoint)
    const verifyTokenDto = {
      token: req.body?.token,
      email: req.body?.email,
      ipAddress: req.body?.ipAddress,
      userAgent: req.body?.userAgent,
    };

    console.log('🔍 [PROD DEBUG] Manual parsed verification DTO:', verifyTokenDto);
    console.log('🔍 [PROD DEBUG] Token length:', verifyTokenDto.token?.length);
    console.log('🔍 [PROD DEBUG] Email domain:', verifyTokenDto.email?.split('@')[1]);

    try {
      console.log('🚀 [PROD DEBUG] Calling authService.verifyEmailToken');
      const result = await this.authService.verifyEmailToken(
        verifyTokenDto.token,
        verifyTokenDto.email,
        verifyTokenDto.ipAddress || req.ip,
        verifyTokenDto.userAgent || req.get('User-Agent')
      );

      console.log('✅ [PROD DEBUG] Verification successful');
      console.log('✅ [PROD DEBUG] User ID:', result.user?.id);
      console.log('✅ [PROD DEBUG] User email:', result.user?.email);

      return {
        success: true,
        message: 'Email verified successfully',
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    } catch (error) {
      console.error('❌ [PROD DEBUG] Verification failed:');
      console.error('❌ [PROD DEBUG] Error message:', error.message);
      console.error('❌ [PROD DEBUG] Error stack:', error.stack);
      console.error('❌ [PROD DEBUG] Error name:', error.name);
      console.error('❌ [PROD DEBUG] Full error:', error);
      
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
    // Enhanced logging for production debugging
    console.log('🔍 [PROD DEBUG] Resend verification token request received');
    console.log('🔍 [PROD DEBUG] Request headers:', req.headers);
    console.log('🔍 [PROD DEBUG] Request body:', req.body);
    console.log('🔍 [PROD DEBUG] Client IP:', req.ip);
    console.log('🔍 [PROD DEBUG] User-Agent:', req.get('User-Agent'));
    console.log('🔍 [PROD DEBUG] Request timestamp:', new Date().toISOString());
    console.log('🔍 [PROD DEBUG] Email to resend:', resendTokenDto.email);
    
    try {
      console.log('🚀 [PROD DEBUG] Calling authService.resendVerificationToken');
      const result = await this.authService.resendVerificationToken(
        resendTokenDto.email,
        resendTokenDto.ipAddress || req.ip,
        resendTokenDto.userAgent || req.get('User-Agent')
      );

      console.log('✅ [PROD DEBUG] Resend successful');
      console.log('✅ [PROD DEBUG] Result message:', result.message);

      return {
        success: true,
        message: result.message,
      };
    } catch (error) {
      console.error('❌ [PROD DEBUG] Resend failed:');
      console.error('❌ [PROD DEBUG] Error message:', error.message);
      console.error('❌ [PROD DEBUG] Error stack:', error.stack);
      console.error('❌ [PROD DEBUG] Error name:', error.name);
      console.error('❌ [PROD DEBUG] Full error:', error);
      
      return {
        success: false,
        message: error.message || 'Failed to resend verification token',
      };
    }
  }

  @Post('refresh')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } }) // 10 attempts per minute
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async refreshToken(@Body() body: { refreshToken: string }, @Req() req: Request) {
    console.log('🔄 Token refresh request received');
    console.log('🔄 Client IP:', req.ip);
    console.log('🔄 User-Agent:', req.get('User-Agent'));
    
    try {
      const deviceInfo = {
        userAgent: req.get('User-Agent'),
        platform: req.get('Sec-Ch-Ua-Platform') || 'unknown',
      };

      const result = await this.tokenService.refreshAccessToken(
        body.refreshToken,
        deviceInfo,
        req.ip
      );

      console.log('✅ Token refreshed successfully for user:', result.userId);

      return {
        success: true,
        message: 'Token refreshed successfully',
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        userId: result.userId,
      };
    } catch (error) {
      console.error('❌ Token refresh failed:', error.message);
      
      return {
        success: false,
        message: error.message || 'Failed to refresh token',
      };
    }
  }

  @Post('logout')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } }) // 10 attempts per minute
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async logout(@Body() body: { refreshToken?: string }, @Req() req: Request) {
    console.log('🔒 Logout request received');
    console.log('🔒 Client IP:', req.ip);
    console.log('🔒 User-Agent:', req.get('User-Agent'));
    
    try {
      if (body.refreshToken) {
        // Revoke the specific refresh token
        const success = await this.tokenService.revokeRefreshToken(body.refreshToken);
        
        if (success) {
          console.log('✅ Refresh token revoked successfully');
        } else {
          console.log('⚠️ Failed to revoke refresh token (may not exist)');
        }
      }

      // Note: In a real implementation, you might want to get the user ID from the JWT
      // and revoke all their tokens, or implement token blacklisting
      
      return {
        success: true,
        message: 'Logged out successfully',
      };
    } catch (error) {
      console.error('❌ Logout failed:', error.message);
      
      return {
        success: false,
        message: error.message || 'Failed to logout',
      };
    }
  }

  @Post('logout-all')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 300 } }) // 5 attempts per 5 minutes
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async logoutAll(@Body() body: { userId: string }, @Req() req: Request) {
    console.log('🔒 Logout all devices request received for user:', body.userId);
    console.log('🔒 Client IP:', req.ip);
    
    try {
      const success = await this.tokenService.revokeAllUserTokens(body.userId);
      
      if (success) {
        console.log('✅ All user tokens revoked successfully');
        
        // Log the security event
        await this.tokenService.logUserActivity(body.userId, 'logout', {
          type: 'logout_all_devices',
          ip_address: req.ip,
          user_agent: req.get('User-Agent'),
        });
      } else {
        console.log('⚠️ Failed to revoke all user tokens');
      }

      return {
        success: true,
        message: 'Logged out from all devices successfully',
      };
    } catch (error) {
      console.error('❌ Logout all failed:', error.message);
      
      return {
        success: false,
        message: error.message || 'Failed to logout from all devices',
      };
    }
  }
}