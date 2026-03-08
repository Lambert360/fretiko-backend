import { Injectable, Logger, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { 
  createClient, 
  SupabaseClient, 
  AuthResponse as SupabaseAuthResponse 
} from '@supabase/supabase-js';
import type { SignUpDto, SignInDto, AuthResponse } from '../shared/dto/auth.dto';
import { EmailService } from './email.service';
import { JwtService } from '@nestjs/jwt';
import { createSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class AuthService {
  private supabase;
  private serviceSupabase;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private configService: ConfigService,
    private jwtService: JwtService,
    private emailService: EmailService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async signUp(signUpDto: SignUpDto): Promise<AuthResponse> {
    const { email, password, firstName, lastName, dateOfBirth, gender, hasAcceptedTerms } = signUpDto;

    // Debug logging for terms acceptance
    this.logger.log(`🔍 Signup data received:`, {
      email,
      firstName,
      lastName,
      hasAcceptedTerms,
      hasAcceptedTermsType: typeof hasAcceptedTerms,
      dateOfBirth,
      gender
    });

    // Enhanced validation
    if (!hasAcceptedTerms) {
      this.logger.error(`❌ Terms not accepted. hasAcceptedTerms: ${hasAcceptedTerms} (type: ${typeof hasAcceptedTerms})`);
      throw new ConflictException('You must accept the terms and conditions to create an account');
    }

    this.logger.log(`✅ Terms accepted: ${hasAcceptedTerms}`);

    if (!email || !email.includes('@')) {
      throw new ConflictException('Valid email address is required');
    }

    if (!password || password.length < 8) {
      throw new ConflictException('Password must be at least 8 characters long');
    }

    // Password complexity validation
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);

    if (!hasUpperCase || !hasLowerCase || !hasNumbers) {
      throw new ConflictException('Password must contain uppercase, lowercase, and numbers');
    }

    if (!firstName || !firstName.trim()) {
      throw new ConflictException('First name is required');
    }

    if (!lastName || !lastName.trim()) {
      throw new ConflictException('Last name is required');
    }

    // Log signup attempt (without sensitive data)
    this.logger.log(`Signup attempt for email: ${email}`);

    try {
      console.log('🔍 Attempting Supabase signup with:', {
        email: email.trim().toLowerCase(),
        passwordLength: password.length,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        dateOfBirth,
        gender,
        hasAcceptedTerms
      });

      // Create user in Supabase Auth
      const { data, error } = await this.supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            // Try without optional fields to isolate the issue
          },
        },
      });

      console.log('🔍 Supabase signup result:', { data, error });

      if (error) {
        this.logger.error(`Supabase signup failed: ${error.message}`);
        this.logger.error(`Full Supabase error:`, JSON.stringify(error, null, 2));
        
        // Handle specific error cases
        if (error.message.includes('User already registered')) {
          throw new ConflictException('An account with this email already exists');
        }
        if (error.message.includes('Password should be at least')) {
          throw new ConflictException('Password does not meet requirements');
        }
        if (error.message.includes('Database error saving new user')) {
          throw new ConflictException('Database constraint violation. Please check your data.');
        }
        throw new ConflictException('Failed to create account. Please try again.');
      }

      if (!data.user) {
        this.logger.error('No user data returned from Supabase');
        throw new ConflictException('Failed to create account. Please try again.');
      }

      // Handle email verification requirement
      if (!data.session) {
        this.logger.log(`Email verification required for: ${email}`);
        
        // Profile is created automatically by Supabase trigger
        // Fetch the created profile
        const profileData = await this.getUserProfile(data.user.id);
        
        // Return user data without tokens, indicating verification needed
        const userData = {
          id: data.user.id,
          email: data.user.email,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          username: profileData?.username,
          avatar_url: profileData?.avatar_url,
          user_role: profileData?.user_role || 'citizen',
          is_seller: profileData?.is_seller || false,
          is_rider: profileData?.is_rider || false,
          is_verified: profileData?.is_verified || false,
        };

        return {
          user: userData,
          accessToken: '', // Empty token indicates verification needed
          refreshToken: '',
          requiresEmailVerification: true,
        };
      }

      // Set the session for profile access
      await this.supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      // Profile is created automatically by Supabase trigger
      // Fetch the created profile
      const profileData = await this.getUserProfile(data.user.id);

      if (!profileData) {
        this.logger.error(`Profile not found for user: ${data.user.id}`);
        throw new UnauthorizedException('User profile not found');
      }

      const userData = {
        id: data.user.id,
        email: data.user.email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        username: profileData.username,
        avatar_url: profileData.avatar_url,
        user_role: profileData.user_role || 'citizen',
        is_seller: profileData.is_seller || false,
        is_rider: profileData.is_rider || false,
        is_verified: profileData.is_verified || false,
      };

      this.logger.log(`Successfully created account for: ${email}`);

      return {
        user: userData,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      };
    } catch (error) {
      this.logger.error(`Signup error for ${email}:`, error);
      throw error;
    }
  }

  private async getUserProfile(userId: string) {
    try {
      console.log(`🔍 Fetching profile for userId: ${userId}`);
      const { data, error } = await this.serviceSupabase
        .from('user_profiles')
        .select(`
          id,
          username,
          avatar_url,
          user_role,
          is_seller,
          is_rider,
          is_verified,
          email_confirmed,
          preferences
        `)
        .eq('id', userId)
        .single();

      console.log(`🔍 Profile fetch result:`, { data, error });
      
      if (error) {
        this.logger.warn(`Profile fetch error for ${userId}: ${error.message}`);
        return null;
      }

      return data;
    } catch (error) {
      this.logger.error(`Error fetching profile for ${userId}:`, error);
      return null;
    }
  }

  private async getUserProfileWithRetry(userId: string, maxRetries = 3): Promise<any> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const profileData = await this.getUserProfile(userId);
      if (profileData) {
        this.logger.log(`Profile found for ${userId} on attempt ${attempt}`);
        return profileData;
      }
      
      if (attempt < maxRetries) {
        const delay = 500 * attempt; // Exponential backoff: 500ms, 1000ms, 1500ms
        this.logger.warn(`Profile not found for ${userId}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    this.logger.error(`Profile not found for ${userId} after ${maxRetries} attempts`);
    return null;
  }

  async signIn(signInDto: SignInDto): Promise<AuthResponse> {
    const { email, password } = signInDto;

    // Enhanced validation
    if (!email || !email.includes('@')) {
      throw new UnauthorizedException('Valid email address is required');
    }

    if (!password) {
      throw new UnauthorizedException('Password is required');
    }

    this.logger.log(`Signin attempt for email: ${email}`);

    try {
      // Check for legacy user BEFORE attempting authentication
      const legacyUser = await this.checkLegacyUser(email);
      if (legacyUser) {
        this.logger.warn(`Legacy user detected for: ${email}`);
        throw new UnauthorizedException('LEGACY_USER_MIGRATION_NEEDED');
      }

      // Sign in with Supabase Auth
      const { data, error } = await this.supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (error) {
        this.logger.error(`Signin failed for ${email}: ${error.message}`);

        // Handle specific Supabase errors
        if (error.message.includes('Email not confirmed')) {
          throw new UnauthorizedException('Please confirm your email before signing in');
        }

        throw new UnauthorizedException('Invalid email or password');
      }

      if (!data.session) {
        throw new UnauthorizedException('Authentication failed - no session created');
      }

      // Set the session
      await this.supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      // Fetch complete user profile with retry mechanism
      const profileData = await this.getUserProfileWithRetry(data.user.id);

      if (!profileData) {
        this.logger.error(`Profile not found for user: ${data.user.id}`);
        throw new UnauthorizedException('User profile not found');
      }

      // Check email verification status
      if (!profileData.email_confirmed) {
        this.logger.warn(`Login attempt for unverified email: ${email}`);
        throw new UnauthorizedException('Please confirm your email before signing in');
      }

      // Check account status
      const preferences = profileData.preferences || {};
      if (preferences.isDeleted === true || preferences.deletedAt) {
        this.logger.warn(`Login attempt for deleted account: ${email}`);
        throw new UnauthorizedException('This account has been deleted');
      }

      const isSuspended = preferences.isSuspended === true;

      const userData = {
        id: data.user.id,
        email: data.user.email,
        firstName: data.user.user_metadata?.first_name || preferences.fullName?.split(' ')[0] || '',
        lastName: data.user.user_metadata?.last_name || preferences.fullName?.split(' ').slice(1).join(' ') || '',
        username: profileData.username,
        avatar_url: profileData.avatar_url,
        user_role: profileData.user_role,
        is_seller: profileData.is_seller,
        is_rider: profileData.is_rider,
        is_verified: profileData.is_verified,
      };

      this.logger.log(`Successful signin for: ${email}`);

      return {
        user: userData,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        isSuspended,
      };
    } catch (error) {
      this.logger.error(`Signin error for ${email}:`, error);
      throw error;
    }
  }

  private async checkLegacyUser(email: string) {
    try {
      const { data } = await this.supabase
        .from('user_profiles')
        .select('id, email, first_name, last_name')
        .eq('email', email)
        .single();

      return data;
    } catch (error) {
      return null;
    }
  }

  async resetPassword(email: string): Promise<{ success: boolean; message: string }> {
    this.logger.log(`Password reset request for: ${email}`);

    try {
      // Check if user exists
      const { data: userData, error: userError } = await this.supabase.auth.admin.getUserByEmail(email);

      if (userError || !userData) {
        this.logger.warn(`Password reset requested for non-existent email: ${email}`);
        return {
          success: false,
          message: 'If an account with this email exists, you will receive a password reset link.',
        };
      }

      // Generate reset token
      const { data: resetData, error: resetError } = await this.supabase.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: {
          redirectTo: `${this.configService.get<string>('FRONTEND_URL')}/reset-password`,
        },
      });

      if (resetError) {
        this.logger.error(`Failed to generate reset link for ${email}: ${resetError.message}`);
        return {
          success: false,
          message: 'Failed to generate password reset link. Please try again.',
        };
      }

      this.logger.log(`Password reset link generated for: ${email}`);
      
      return {
        success: true,
        message: 'If an account with this email exists, you will receive a password reset link.',
      };
    } catch (error) {
      this.logger.error(`Password reset error for ${email}:`, error);
      return {
        success: false,
        message: 'Failed to process password reset request. Please try again.',
      };
    }
  }

  async migrateAccount(email: string, newPassword: string): Promise<AuthResponse> {
    this.logger.log(`Account migration attempt for: ${email}`);

    // Check legacy user exists
    const legacyUser = await this.checkLegacyUser(email);
    if (!legacyUser) {
      throw new UnauthorizedException('No legacy account found for this email');
    }

    // Check if already migrated
    const { data: existingUser } = await this.supabase.auth.admin.getUserByEmail(email);
    if (existingUser.user) {
      throw new ConflictException('Account already migrated. Please use regular login.');
    }

    try {
      // Create new Supabase Auth user
      const { data, error } = await this.supabase.auth.admin.createUser({
        email,
        password: newPassword,
        user_metadata: {
          first_name: legacyUser.first_name,
          last_name: legacyUser.last_name,
        },
        email_confirm: true,
      });

      if (error) {
        this.logger.error(`Migration failed for ${email}: ${error.message}`);
        throw new ConflictException('Failed to migrate account: ' + error.message);
      }

      // Sign in immediately
      const { data: signInData, error: signInError } = await this.supabase.auth.signInWithPassword({
        email,
        password: newPassword,
      });

      if (signInError) {
        throw new UnauthorizedException('Migration succeeded but login failed. Please try logging in normally.');
      }

      // Profile is created automatically by Supabase trigger
      // Fetch the created profile with retry mechanism
      const profileData = await this.getUserProfileWithRetry(signInData.user.id);

      if (!profileData) {
        this.logger.error(`Profile not found for migrated user: ${signInData.user.id}`);
        throw new UnauthorizedException('User profile not found after migration');
      }

      const userData = {
        id: signInData.user.id,
        email: signInData.user.email,
        firstName: legacyUser.first_name,
        lastName: legacyUser.last_name,
        username: profileData.username,
        avatar_url: profileData.avatar_url,
        user_role: profileData.user_role,
        is_seller: profileData.is_seller,
        is_rider: profileData.is_rider,
        is_verified: profileData.is_verified,
      };

      this.logger.log(`Account migration successful for: ${email}`);

      return {
        user: userData,
        accessToken: signInData.session.access_token,
        refreshToken: signInData.session.refresh_token,
      };
    } catch (error) {
      this.logger.error(`Migration error for ${email}:`, error);
      throw error;
    }
  }

  async checkEmailAvailability(email: string): Promise<boolean> {
    try {
      const { data, error } = await this.supabase.auth.admin.getUserByEmail(email);

      if (error) {
        if (error.message.includes('User not found') || error.message.includes('not found')) {
          return true;
        }
        return false; // Assume taken on error
      }

      return !data.user; // Return false if user exists
    } catch (error) {
      this.logger.error(`Email availability check error for ${email}:`, error);
      return false; // Assume taken on error
    }
  }

  // =====================================================
  // TOKEN VERIFICATION METHODS
  // =====================================================

  async verifyEmailToken(token: string, email: string, ipAddress?: string, userAgent?: string): Promise<AuthResponse> {
    try {
      this.logger.log(`🔍 Verifying email token for: ${email}`);

      // Find user by email and token
      const { data: profileData, error } = await this.serviceSupabase
        .from('user_profiles')
        .select(`
          id,
          email_confirmation_token,
          email_confirmation_expires_at,
          email_confirmed,
          username,
          user_role,
          is_seller,
          is_rider,
          is_verified
        `)
        .eq('email', email)
        .single();

      if (error) {
        this.logger.error(`Profile lookup failed for ${email}:`, error);
        throw new UnauthorizedException('Invalid email or token');
      }

      if (!profileData) {
        this.logger.error(`No profile found for email: ${email}`);
        throw new UnauthorizedException('Invalid email or token');
      }

      // Check if already verified
      if (profileData.email_confirmed) {
        this.logger.log(`Email already verified for: ${email}`);
        // Return existing user session
        const { data: userData } = await this.supabase.auth.signInWithPassword({
          email,
          password: '', // This will fail, but we need session
        });
        
        if (userData.user) {
          return {
            user: {
              id: userData.user.id,
              email: userData.user.email,
              firstName: userData.user.user_metadata?.first_name,
              lastName: userData.user.user_metadata?.last_name,
              username: profileData.username,
              avatar_url: profileData.avatar_url,
              user_role: profileData.user_role,
              is_seller: profileData.is_seller,
              is_rider: profileData.is_rider,
              is_verified: profileData.is_verified,
            },
            accessToken: userData.session?.access_token || '',
            refreshToken: userData.session?.refresh_token || '',
          };
        }
      }

      // Verify token matches
      if (profileData.email_confirmation_token !== token) {
        this.logger.error(`Invalid token for ${email}: expected ${profileData.email_confirmation_token}, got ${token}`);
        
        // Log failed attempt
        await this.logVerificationActivity(profileData.id, email, 'failed', 'Invalid verification token', ipAddress, userAgent);
        
        throw new UnauthorizedException('Invalid verification token');
      }

      // Check token expiration
      if (new Date() > new Date(profileData.email_confirmation_expires_at)) {
        this.logger.error(`Expired token for ${email}: expired at ${profileData.email_confirmation_expires_at}`);
        
        // Log failed attempt
        await this.logVerificationActivity(profileData.id, email, 'failed', 'Token expired', ipAddress, userAgent);
        
        throw new UnauthorizedException('Verification token has expired');
      }

      // Mark email as confirmed
      const { error: updateError } = await this.serviceSupabase
        .from('user_profiles')
        .update({
          email_confirmed: true,
          email_confirmation_token: null,
          email_confirmation_expires_at: null,
          is_verified: true,
        })
        .eq('id', profileData.id);

      if (updateError) {
        this.logger.error(`Failed to mark email as confirmed for ${email}:`, updateError);
        throw new ConflictException('Failed to verify email. Please try again.');
      }

      // Log successful verification
      await this.logVerificationActivity(profileData.id, email, 'verified', undefined, ipAddress, userAgent);

      this.logger.log(`✅ Email verified successfully for: ${email}`);

      // Create session for verified user
      const { data: signInData, error: signInError } = await this.supabase.auth.signInWithPassword({
        email,
        password: '', // We need to get session, but user should set password
      });

      // Since we can't sign in without password, return user data without session
      // Frontend will handle sign in with stored credentials
      return {
        user: {
          id: profileData.id,
          email: email,
          firstName: '', // Will be populated from registration context
          lastName: '',
          username: profileData.username,
          avatar_url: profileData.avatar_url,
          user_role: profileData.user_role,
          is_seller: profileData.is_seller,
          is_rider: profileData.is_rider,
          is_verified: true,
        },
        accessToken: '', // Frontend will handle sign in
        refreshToken: '',
      };

    } catch (error) {
      this.logger.error(`Token verification error for ${email}:`, error);
      throw error;
    }
  }

  async resendVerificationToken(email: string, ipAddress?: string, userAgent?: string): Promise<{ message: string; token?: string }> {
    try {
      this.logger.log(`🔄 Resending verification token for: ${email}`);

      // Check if user exists
      const { data: profileData, error } = await this.serviceSupabase
        .from('user_profiles')
        .select('id, email_confirmed')
        .eq('email', email)
        .single();

      if (error) {
        this.logger.error(`Profile lookup failed for ${email}:`, error);
        throw new BadRequestException('Invalid email address');
      }

      if (!profileData) {
        this.logger.error(`No profile found for email: ${email}`);
        throw new BadRequestException('Email address not found');
      }

      if (profileData.email_confirmed) {
        this.logger.log(`Email already verified for: ${email}`);
        return { message: 'Email is already verified' };
      }

      // Generate new token
      const newToken = Math.floor(100000 + Math.random() * 900000).toString().padStart(6, '0');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Update token in database
      const { error: updateError } = await this.serviceSupabase
        .from('user_profiles')
        .update({
          email_confirmation_token: newToken,
          email_confirmation_expires_at: expiresAt.toISOString(),
        })
        .eq('id', profileData.id);

      if (updateError) {
        this.logger.error(`Failed to update verification token for ${email}:`, updateError);
        throw new ConflictException('Failed to generate new verification token');
      }

      // Log resend activity
      await this.logVerificationActivity(profileData.id, email, 'resent', undefined, ipAddress, userAgent);

      // Send new token via email
      const emailSent = await this.emailService.sendResendTokenEmail(email, newToken);
      
      if (!emailSent) {
        this.logger.error(`Failed to send resend email to ${email}`);
        // Don't throw - token is still generated and stored
      }

      this.logger.log(`✅ New verification token generated for ${email}: ${newToken}`);

      return { 
        message: 'Verification token has been sent to your email',
        token: newToken // For testing purposes
      };

    } catch (error) {
      this.logger.error(`Resend token error for ${email}:`, error);
      throw error;
    }
  }

  private async logVerificationActivity(
    userId: string, 
    email: string, 
    action: 'sent' | 'verified' | 'resent' | 'failed',
    errorMessage?: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    try {
      await this.serviceSupabase
        .from('email_verification_logs')
        .insert({
          user_id: userId,
          email: email,
          action,
          error_message: errorMessage,
          ip_address: ipAddress,
          user_agent: userAgent,
        });
    } catch (error) {
      this.logger.error(`Failed to log verification activity:`, error);
      // Don't throw - logging is non-critical
    }
  }
}
