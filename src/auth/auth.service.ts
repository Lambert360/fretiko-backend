import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { SignUpDto, SignInDto, AuthResponse } from '../shared/dto/auth.dto';

@Injectable()
export class AuthService {
  private supabase;
  private serviceSupabase; // Service role client to bypass RLS

  constructor(
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
    
    // Debug: Check if service role key is available
    const serviceRoleKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_KEY');
    
    console.log('🔍 Supabase Config:', {
      hasUrl: !!supabaseUrl,
      hasServiceKey: !!serviceRoleKey,
      hasRegularKey: !!supabaseKey,
      serviceKeyLength: serviceRoleKey?.length,
      regularKeyLength: supabaseKey?.length,
      urlPrefix: supabaseUrl?.substring(0, 20) + '...',
      serviceKeyPrefix: serviceRoleKey?.substring(0, 10) + '...',
      regularKeyPrefix: supabaseKey?.substring(0, 10) + '...'
    });
  }

  async createVerifiedUser(signUpDto: SignUpDto): Promise<AuthResponse> {
    const { email, user_role, is_seller, is_rider } = signUpDto;

    // Find verification data in email_verification_logs
    const { data: verificationRecord, error: verificationError } = await this.serviceSupabase
      .from('email_verification_logs')
      .select('id, metadata, created_at')
      .eq('email', email)
      .eq('action', 'verified')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (verificationError || !verificationRecord) {
      throw new UnauthorizedException('Email not found or verification expired');
    }

    const metadata = verificationRecord.metadata;
    
    // Check if verification is still valid (within reasonable time)
    const verificationTime = new Date(verificationRecord.created_at);
    const now = new Date();
    const hoursSinceVerification = (now.getTime() - verificationTime.getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceVerification > 24) { // 24 hour limit for account creation after verification
      throw new UnauthorizedException('Verification expired. Please verify your email again.');
    }

    // Use stored signup data or provided data
    const signupData = metadata.signupData || {
      firstName: signUpDto.firstName,
      lastName: signUpDto.lastName,
      dateOfBirth: signUpDto.dateOfBirth,
      gender: signUpDto.gender,
      password: signUpDto.password,
    };

    // Create user in Supabase Auth (email already verified)
    const displayName = `${signupData.firstName} ${signupData.lastName}`.trim();
    const { data, error } = await this.serviceSupabase.auth.admin.createUser({
      email,
      password: signupData.password,
      email_confirm: true, // Skip email confirmation since already verified
      user_metadata: {
        display_name: displayName,
        first_name: signupData.firstName,
        last_name: signupData.lastName,
      },
    });

    if (error) {
      console.error('❌ Supabase Auth Error creating verified user:', error);
      throw new ConflictException(error.message);
    }

    console.log('✅ Verified user created successfully:', {
      userId: data.user?.id,
      email: email,
    });

    // Create or update user profile record with user ID, role, and verification data
    const { error: updateError } = await this.serviceSupabase
      .from('user_profiles')
      .upsert({
        id: data.user.id, // Required for upsert
        email_confirmed: true,
        email_confirmation_token: metadata.token, // Store the token used
        email_confirmation_expires_at: metadata.expiresAt, // Store expiry
        user_role: user_role || 'citizen',
        is_seller: is_seller || false,
        is_rider: is_rider || false,
        date_of_birth: signupData.dateOfBirth,
      })
      .eq('id', data.user.id);

    if (updateError) {
      console.error('❌ Failed to update user profile:', updateError);
      // Don't throw error - user created successfully in auth
    }

    // Update verification log with user_id
    await this.serviceSupabase
      .from('email_verification_logs')
      .update({
        user_id: data.user.id,
      })
      .eq('email', email)
      .eq('action', 'verified');

    // Log successful account creation
    await this.serviceSupabase
      .from('email_verification_logs')
      .insert({
        user_id: data.user.id,
        email: email,
        action: 'account_created',
      });

    // Fetch complete user profile
    const { data: completeProfileData } = await this.serviceSupabase
      .from('user_profiles')
      .select(`
        username,
        avatar_url,
        user_role,
        is_seller,
        is_rider,
        is_verified
      `)
      .eq('id', data.user.id)
      .single();

    const userData = {
      id: data.user.id,
      email: data.user.email,
      firstName: data.user.user_metadata?.first_name || '',
      lastName: data.user.user_metadata?.last_name || '',
      username: completeProfileData?.username,
      avatar_url: completeProfileData?.avatar_url,
      user_role: completeProfileData?.user_role || 'citizen',
      is_seller: completeProfileData?.is_seller || false,
      is_rider: completeProfileData?.is_rider || false,
      is_verified: completeProfileData?.is_verified || false,
    };

    return {
      user: userData,
      accessToken: '', // No session - user needs to sign in
      refreshToken: '', // No session - user needs to sign in
    };
  }

  async signUp(signUpDto: SignUpDto): Promise<AuthResponse> {
    const { email, password, firstName, lastName, dateOfBirth, gender } = signUpDto;

    // Check if user already exists in Supabase Auth
    console.log('🔍 Checking if user already exists...');
    try {
      const { data: existingUser } = await this.supabase.auth.signInWithPassword({
        email,
        password: 'dummy-password-for-check-only',
      });
      
      if (existingUser?.user) {
        console.log('❌ User already exists:', existingUser.user.email);
        throw new ConflictException('User with this email already exists');
      }
    } catch (error) {
      console.log('✅ User does not exist, proceeding with verification email...');
    }

    // Generate 6-digit NUMERIC verification token and send email
    const token = Math.floor(100000 + Math.random() * 900000).toString(); // Numbers only: 123456-999999
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15); // 15 minutes

    // Store verification data as metadata in email_verification_logs (industry standard)
    const verificationMetadata = {
      token,
      expiresAt: expiresAt.toISOString(),
      signupData: {
        firstName,
        lastName,
        dateOfBirth,
        gender,
        password,
      }
    };

    console.log('🔍 Storing verification metadata:', { email, token, expiresAt: verificationMetadata.expiresAt });

    // Insert verification record with metadata (no user_id yet since user doesn't exist)
    try {
      const { error: insertError } = await this.serviceSupabase
        .from('email_verification_logs')
        .insert({
          user_id: null, // No user created yet
          email: email,
          action: 'signup_pending',
          metadata: verificationMetadata,
          ip_address: null,
          user_agent: null,
        });

      if (insertError) {
        console.log('❌ Failed to store verification metadata:', insertError);
        throw new Error('Failed to store verification data');
      }
    } catch (error) {
      console.log('❌ Failed to store verification metadata:', error);
      throw new Error('Failed to store verification data');
    }

    // Send verification email
    console.log('🔍 Initializing email service...');
    const emailService = new (require('./email.service').EmailService)(this.configService);
    
    console.log('🔍 Attempting to send verification email...');
    const emailSent = await emailService.sendVerificationEmail(email, token);
    
    console.log('🔍 Email service result:', { emailSent, email, tokenLength: token.length });

    if (!emailSent) {
      console.error('❌ Email service returned false');
      throw new Error('Failed to send verification email');
    }

    console.log('✅ Verification email sent successfully');

    // Return success without user data (no user created yet)
    return {
      user: undefined,
      accessToken: '',
      refreshToken: '',
      requiresEmailVerification: true,
    };
  }

  async signIn(signInDto: SignInDto): Promise<AuthResponse> {
    const { email, password } = signInDto;

    console.log('🔍 SignIn Debug:', {
      email,
      passwordLength: password?.length,
      hasSupabaseClient: !!this.supabase,
      hasServiceClient: !!this.serviceSupabase,
      supabaseUrl: this.configService.get<string>('SUPABASE_URL')?.substring(0, 20) + '...'
    });

    // Sign in with Supabase Auth
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password,
    });

    console.log('🔍 Supabase Signin Result:', {
      data,
      error,
      hasSession: !!data?.session,
      errorMessage: error?.message,
      errorDetails: error
    });

    if (error) {
      
      // Check if this might be a legacy user
      if (error.message.includes('Invalid login credentials')) {
        
        // Check if user exists in user_profiles table (legacy user)
        const { data: profileData, error: profileError } = await this.supabase
          .from('user_profiles')
          .select('id, email, first_name, last_name')
          .eq('email', email)
          .single();

        if (profileData && !profileError) {
          throw new UnauthorizedException(
            'LEGACY_USER_MIGRATION_NEEDED'
          );
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

    // Set the session on the client so RLS policies allow the user to read their own profile
    if (data.session) {
      await this.supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    }

    // Fetch complete user profile from user_profiles table
    // Using authenticated client so RLS allows user to read their own profile
    // Note: email, first_name, last_name are stored in auth.users, not user_profiles
    const { data: profileData, error: profileError } = await this.supabase
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
      .eq('id', data.user.id)
      .single();

    if (profileError || !profileData) {
      throw new UnauthorizedException('User profile not found');
    }

    // Check if account is deleted (stored in preferences)
    const preferences = profileData.preferences || {};
    if (preferences.isDeleted === true || preferences.deletedAt) {
      throw new UnauthorizedException('This account has been deleted');
    }

    // Check if account is suspended (stored in preferences)
    // Industry standard: Allow suspended users to authenticate but mark them as suspended
    const isSuspended = preferences.isSuspended === true;

    // Extract name from user_metadata or preferences
    const firstName = data.user.user_metadata?.first_name || profileData?.preferences?.fullName?.split(' ')[0] || '';
    const lastName = data.user.user_metadata?.last_name || profileData?.preferences?.fullName?.split(' ').slice(1).join(' ') || '';

    const userData = {
      id: data.user.id,
      email: data.user.email,
      firstName: firstName,
      lastName: lastName,
      username: profileData?.username,
      avatar_url: profileData?.avatar_url,
      user_role: profileData?.user_role,
      is_seller: profileData?.is_seller,
      is_rider: profileData?.is_rider,
      is_verified: profileData?.is_verified,
    };

    // Return Supabase session tokens with complete user profile
    // Industry standard: Allow suspended users to authenticate but mark them
    return {
      user: userData,
      accessToken: data.session?.access_token || '',
      refreshToken: data.session?.refresh_token || '',
      isSuspended: isSuspended, // Suspended users can authenticate but have limited access
    };
  }

  async verifyEmailToken(
    token: string,
    email: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<AuthResponse> {
    console.log('🔍 Verifying token:', { email, token });

    // Find verification data in email_verification_logs metadata
    const { data: verificationRecord, error: verificationError } = await this.serviceSupabase
      .from('email_verification_logs')
      .select('id, metadata, created_at')
      .eq('email', email)
      .eq('action', 'signup_pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (verificationError || !verificationRecord?.metadata) {
      console.log('❌ Verification record not found:', { verificationError });
      throw new UnauthorizedException('Invalid email or verification token');
    }

    const metadata = verificationRecord.metadata;

    // Check token
    if (metadata.token !== token) {
      console.log('❌ Invalid token:', { expected: metadata.token, received: token });
      
      // Log failed attempt
      await this.serviceSupabase
        .from('email_verification_logs')
        .insert({
          user_id: null,
          email: email,
          action: 'failed',
          error_message: 'Invalid token provided',
          ip_address: ipAddress,
          user_agent: userAgent,
        });
      
      throw new UnauthorizedException('Invalid verification token');
    }
    
    // Check token expiration
    if (metadata.expiresAt && new Date() > new Date(metadata.expiresAt)) {
      console.log('❌ Token expired:', { expiresAt: metadata.expiresAt });
      
      // Log failed attempt
      await this.serviceSupabase
        .from('email_verification_logs')
        .insert({
          user_id: null,
          email: email,
          action: 'failed',
          error_message: 'Token expired',
          ip_address: ipAddress,
          user_agent: userAgent,
        });
      
      throw new UnauthorizedException('Verification token expired');
    }

    console.log('✅ Token valid, email verified successfully');

    // Update verification record to 'verified' status
    await this.serviceSupabase
      .from('email_verification_logs')
      .update({
        action: 'verified',
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .eq('id', verificationRecord.id);

    // Log successful verification (already done by the update above)
    // The redundant insert was causing createVerifiedUser to find a record with null metadata

    // Return success - user creation will be handled by createVerifiedUser
    return {
      user: undefined,
      accessToken: '',
      refreshToken: '',
      requiresEmailVerification: false,
    };
  }

  async checkEmailAvailability(email: string): Promise<boolean> {
    try {
      // Check if user exists in Supabase Auth
      const { data: existingUser } = await this.supabase.auth.admin.getUserByEmail(email);
      
      if (existingUser?.user) {
        return false; // Email is taken
      }

      // Check if user exists in user_profiles (legacy check)
      const { data: profileData } = await this.supabase
        .from('user_profiles')
        .select('email')
        .eq('email', email)
        .single();

      return !profileData; // Return true if no profile found
    } catch (error) {
      // If error occurs, assume email is not available (safer approach)
      return false;
    }
  }

  async resendVerificationToken(
    email: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ success: boolean; message: string }> {
    // Find user by email
    const { data: profileData, error: profileError } = await this.supabase
      .from('user_profiles')
      .select(`
        id,
        email_confirmed
      `)
      .eq('email', email)
      .single();

    if (profileError || !profileData) {
      throw new UnauthorizedException('Email not found');
    }

    // Check if already verified
    if (profileData.email_confirmed) {
      throw new ConflictException('Email already verified');
    }

    // Generate new token
    const token = Math.random().toString(36).substring(2, 8).toUpperCase();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours

    // Update user profile with new token
    const { error: updateError } = await this.supabase
      .from('user_profiles')
      .update({
        email_confirmation_token: token,
        email_confirmation_expires_at: expiresAt.toISOString(),
      })
      .eq('id', profileData.id);

    if (updateError) {
      throw new Error('Failed to generate verification token: ' + updateError.message);
    }

    // Send verification email
    const emailService = new (require('./email.service').EmailService)(this.configService);
    const emailSent = await emailService.sendVerificationEmail(email, token);

    if (!emailSent) {
      throw new Error('Failed to send verification email');
    }

    // Log resend action
    await this.supabase
      .from('email_verification_logs')
      .insert({
        user_id: profileData.id,
        email: email,
        action: 'resent',
        ip_address: ipAddress,
        user_agent: userAgent,
      });

    return { 
      success: true,
      message: 'Verification email sent successfully' 
    };
  }

  async migrateAccount(email: string, newPassword: string): Promise<AuthResponse> {
    try {
      // Check if user exists in user_profiles table (legacy user)
      const { data: profileData, error: profileError } = await this.supabase
        .from('user_profiles')
        .select('id, email, first_name, last_name')
        .eq('email', email)
        .single();

      if (profileData && !profileError) {
        // Check if user already exists in Supabase Auth
        console.log('🔍 Checking if user already exists in Supabase Auth...');
        try {
          const { data: existingUser } = await this.supabase.auth.signInWithPassword({
            email,
            password: 'dummy-password-for-check-only',
          });
          
          if (existingUser?.user) {
            console.log('❌ User already exists:', existingUser.user.email);
            throw new ConflictException('Account already migrated. Please use regular login.');
          }
        } catch (error) {
          console.log('✅ User does not exist in Supabase Auth, proceeding with migration...');
        }

        // Create new Supabase Auth user with admin API (no email confirmation needed)
        const { data, error } = await this.supabase.auth.admin.createUser({
          email,
          password: newPassword,
          user_metadata: {
            first_name: profileData.first_name,
            last_name: profileData.last_name,
          },
          email_confirm: true, // Skip email confirmation
        });

        if (error) {
            throw new ConflictException('Failed to migrate account: ' + error.message);
        }

        // Now sign them in immediately
        const { data: signInData, error: signInError } = await this.supabase.auth.signInWithPassword({
          email,
          password: newPassword,
        });

        if (signInError) {
          throw new UnauthorizedException('Migration succeeded but login failed. Please try logging in normally.');
        }

        
        // Fetch complete user profile from user_profiles table
        const { data: migratedProfileData, error: migratedProfileError } = await this.supabase
          .from('user_profiles')
          .select(`
            id,
            email,
            first_name,
            last_name,
            username,
            avatar_url,
            user_role,
            is_seller,
            is_rider,
            is_verified
          `)
          .eq('id', signInData.user.id)
          .single();

        const migratedUserData = {
          id: signInData.user.id,
          email: signInData.user.email,
          firstName: migratedProfileData?.first_name || signInData.user.user_metadata?.first_name,
          lastName: migratedProfileData?.last_name || signInData.user.user_metadata?.last_name,
          username: migratedProfileData?.username,
          avatar_url: migratedProfileData?.avatar_url,
          user_role: migratedProfileData?.user_role,
          is_seller: migratedProfileData?.is_seller,
          is_rider: migratedProfileData?.is_rider,
          is_verified: migratedProfileData?.is_verified,
        };

        return {
          user: migratedUserData,
          accessToken: signInData.session?.access_token || '',
          refreshToken: signInData.session?.refresh_token || '',
        };
      }

      throw new UnauthorizedException('Email not found in user profiles');
    } catch (error) {
      throw new UnauthorizedException('Migration failed: ' + error.message);
    }
  }

  async resetPassword(email: string): Promise<{ success: boolean; message: string }> {
    try {
      // Check if user exists
      const { data: userData, error: userError } = await this.supabase.auth.admin.getUserByEmail(email);
      
      if (userError || !userData.user) {
        return {
          success: false,
          message: 'If an account with this email exists, a password reset link has been sent.',
        };
      }

      // Generate reset token
      const token = Math.random().toString(36).substring(2, 8).toUpperCase();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour expiry

      // Store reset token in user_profiles
      const { error: updateError } = await this.supabase
        .from('user_profiles')
        .update({
          reset_token: token,
          reset_token_expires_at: expiresAt.toISOString(),
        })
        .eq('id', userData.user.id);

      if (updateError) {
        throw new Error('Failed to generate reset token');
      }

      // Send reset email
      const emailService = new (require('./email.service').EmailService)(this.configService);
      const emailSent = await emailService.sendPasswordResetEmail(email, token);

      if (!emailSent) {
        throw new Error('Failed to send reset email');
      }

      return {
        success: true,
        message: 'If an account with this email exists, a password reset link has been sent.',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to send password reset link',
      };
    }
  }
}
