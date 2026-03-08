import { Injectable, UnauthorizedException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { SignUpDto, SignInDto, AuthResponse } from '../shared/dto/auth.dto';

@Injectable()
export class AuthService {
  private supabase;
  private serviceSupabase;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async signUp(signUpDto: SignUpDto): Promise<AuthResponse> {
    const { email, password, firstName, lastName, dateOfBirth, gender, hasAcceptedTerms } = signUpDto;

    // Enhanced validation
    if (!hasAcceptedTerms) {
      throw new ConflictException('You must accept the terms and conditions to create an account');
    }

    if (!email || !email.includes('@')) {
      throw new ConflictException('Valid email address is required');
    }

    if (!password || password.length < 6) {
      throw new ConflictException('Password must be at least 6 characters long');
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
      // Create user in Supabase Auth
      const { data, error } = await this.supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            date_of_birth: dateOfBirth,
            gender,
          },
        },
      });

      if (error) {
        this.logger.error(`Supabase signup failed: ${error.message}`);
        
        // Handle specific error cases
        if (error.message.includes('User already registered')) {
          throw new ConflictException('An account with this email already exists');
        }
        if (error.message.includes('Password should be at least')) {
          throw new ConflictException('Password does not meet requirements');
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
        
        // Create profile immediately even if email not verified
        await this.ensureUserProfile(data.user.id, firstName.trim(), lastName.trim(), dateOfBirth, gender);
        
        // Return user data without tokens, indicating verification needed
        const userData = {
          id: data.user.id,
          email: data.user.email,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          username: undefined,
          avatar_url: undefined,
          user_role: 'citizen',
          is_seller: false,
          is_rider: false,
          is_verified: false,
        };

        return {
          user: userData,
          accessToken: '', // Empty token indicates verification needed
          refreshToken: '',
          requiresEmailVerification: true,
        };
      }

      // Set the session for profile creation
      await this.supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      // Ensure user profile exists
      await this.ensureUserProfile(data.user.id, firstName.trim(), lastName.trim(), dateOfBirth, gender);

      // Fetch complete user profile
      const profileData = await this.getUserProfile(data.user.id);

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

  private async ensureUserProfile(
    userId: string,
    firstName: string,
    lastName: string,
    dateOfBirth?: string,
    gender?: string
  ): Promise<void> {
    try {
      // Check if profile already exists
      const { data: existingProfile } = await this.serviceSupabase
        .from('user_profiles')
        .select('id')
        .eq('id', userId)
        .single();

      if (existingProfile) {
        return; // Profile already exists
      }

      // Create profile using service role
      const { error: profileError } = await this.serviceSupabase
        .from('user_profiles')
        .insert({
          id: userId,
          user_role: 'citizen',
          is_seller: false,
          is_rider: false,
          is_verified: false,
          preferences: {
            fullName: `${firstName} ${lastName}`.trim(),
            dateOfBirth,
            gender,
            termsAcceptedAt: new Date().toISOString(),
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (profileError) {
        this.logger.error(`Failed to create user profile for ${userId}: ${profileError.message}`);
        throw new ConflictException('Failed to create user profile');
      }

      // Initialize user stats
      await this.initializeUserStats(userId);

      this.logger.log(`Created user profile for: ${userId}`);
    } catch (error) {
      this.logger.error(`Profile creation error for ${userId}:`, error);
      throw error;
    }
  }

  private async initializeUserStats(userId: string): Promise<void> {
    try {
      // Initialize user stats
      await this.serviceSupabase
        .from('user_stats')
        .insert({ id: userId })
        .onConflict('id')
        .ignore();

      // Initialize wallet
      await this.serviceSupabase
        .from('wallets')
        .insert({ user_id: userId })
        .onConflict('user_id')
        .ignore();

      // Initialize trust score
      await this.serviceSupabase
        .from('trust_scores')
        .insert({ user_id: userId })
        .onConflict('user_id')
        .ignore();
    } catch (error) {
      this.logger.error(`Failed to initialize user stats for ${userId}:`, error);
      // Don't throw error - user profile is more important
    }
  }

  private async getUserProfile(userId: string) {
    try {
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
          preferences
        `)
        .eq('id', userId)
        .single();

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
      // Sign in with Supabase Auth
      const { data, error } = await this.supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (error) {
        this.logger.error(`Signin failed for ${email}: ${error.message}`);

        // Check for legacy user
        if (error.message.includes('Invalid login credentials')) {
          const legacyUser = await this.checkLegacyUser(email);
          if (legacyUser) {
            throw new UnauthorizedException('LEGACY_USER_MIGRATION_NEEDED');
          }
        }

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

      // Fetch complete user profile
      const profileData = await this.getUserProfile(data.user.id);

      if (!profileData) {
        this.logger.error(`Profile not found for user: ${data.user.id}`);
        throw new UnauthorizedException('User profile not found');
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

      // Ensure profile exists
      await this.ensureUserProfile(
        signInData.user.id,
        legacyUser.first_name,
        legacyUser.last_name
      );

      // Fetch complete profile
      const profileData = await this.getUserProfile(signInData.user.id);

      const userData = {
        id: signInData.user.id,
        email: signInData.user.email,
        firstName: legacyUser.first_name,
        lastName: legacyUser.last_name,
        username: profileData?.username,
        avatar_url: profileData?.avatar_url,
        user_role: profileData?.user_role,
        is_seller: profileData?.is_seller,
        is_rider: profileData?.is_rider,
        is_verified: profileData?.is_verified,
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
}
