import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClientManager } from './supabase-client-manager.service';
import { SignUpDto, SignInDto, AuthResponse } from '../shared/dto/auth.dto';
import { EmailService } from './email.service';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  private supabase;
  private serviceSupabase; // Service role client to bypass RLS

  constructor(
    private configService: ConfigService,
    private clientManager: SupabaseClientManager,
    private jwtService: JwtService,
    private emailService: EmailService,
    private tokenService: TokenService,
  ) {
    this.supabase = this.clientManager.getUserClient();
    this.serviceSupabase = this.clientManager.getServiceClient();
  }

  async createVerifiedUser(signUpDto: SignUpDto): Promise<AuthResponse> {
    const { email, user_role, is_seller, is_rider } = signUpDto;

    // Debug logging to track incoming data
    console.log('🔍 createVerifiedUser received data:', {
      email,
      firstName: signUpDto.firstName,
      lastName: signUpDto.lastName,
      dateOfBirth: signUpDto.dateOfBirth,
      gender: signUpDto.gender,
      hasAcceptedTerms: signUpDto.hasAcceptedTerms,
      user_role,
      is_seller,
      is_rider,
      ipAddress: signUpDto.ipAddress,
      userAgent: signUpDto.userAgent,
    });

    // Debug: Check what fields are actually present in signUpDto
    console.log('🔍 signUpDto object keys:', Object.keys(signUpDto));
    console.log('🔍 signUpDto full object:', signUpDto);
    console.log('🔍 signUpDto.ipAddress type:', typeof signUpDto.ipAddress);
    console.log('🔍 signUpDto.userAgent type:', typeof signUpDto.userAgent);

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
    
    // Extract terms acceptance data - prefer provided data, fallback to metadata
    const hasAcceptedTerms = signUpDto.hasAcceptedTerms || metadata.hasAcceptedTerms || false;
    const ipAddress = signUpDto.ipAddress || metadata.ipAddress || null;
    const userAgent = signUpDto.userAgent || metadata.userAgent || null;
    const originalTermsAcceptedAt = metadata.termsAcceptedAt || new Date().toISOString();
    
    // Check if verification is still valid (within reasonable time)
    const verificationTime = new Date(verificationRecord.created_at);
    const now = new Date();
    const hoursSinceVerification = (now.getTime() - verificationTime.getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceVerification > 24) { // 24 hour limit for account creation after verification
      throw new UnauthorizedException('Verification expired. Please verify your email again.');
    }

    // Use provided data first, fallback to stored metadata
    const signupData = {
      firstName: signUpDto.firstName || metadata.signupData?.firstName,
      lastName: signUpDto.lastName || metadata.signupData?.lastName,
      dateOfBirth: signUpDto.dateOfBirth || metadata.signupData?.dateOfBirth,
      gender: signUpDto.gender || metadata.signupData?.gender,
      password: signUpDto.password || metadata.signupData?.password,
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
    const profileData = {
      id: data.user.id, // Required for upsert
      email_confirmed: true,
      email_confirmation_token: metadata.token, // Store the token used
      email_confirmation_expires_at: metadata.expiresAt, // Store expiry
      user_role: user_role || 'citizen',
      is_seller: is_seller || false,
      is_rider: is_rider || false,
      date_of_birth: signupData.dateOfBirth,
      gender: signupData.gender, // Add gender field
      // Add terms acceptance tracking (using existing columns and original data)
      terms_accepted_at: originalTermsAcceptedAt, // Use original timestamp from signup
      terms_accepted_ip: ipAddress || null,
      terms_accepted_user_agent: userAgent || null,
    };

    console.log('🔍 Updating user profile with data:', {
      userId: data.user.id,
      gender: profileData.gender,
      terms_accepted_at: profileData.terms_accepted_at,
      terms_accepted_ip: profileData.terms_accepted_ip,
      terms_accepted_user_agent: profileData.terms_accepted_user_agent,
    });

    const { error: updateError } = await this.serviceSupabase
      .from('user_profiles')
      .upsert(profileData)
      .eq('id', data.user.id);

    if (updateError) {
      console.error('❌ Failed to update user profile:', updateError);
      throw new BadRequestException('Failed to create user profile');
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
        metadata: {
          hasAcceptedTerms,
          termsAcceptedAt: originalTermsAcceptedAt, // Use original timestamp from signup
          ipAddress,
          userAgent,
        },
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

    // Return user data only - tokens will be created by signin in WelcomeScreen
    return {
      user: userData,
    };
  }

  async signUp(signUpDto: SignUpDto): Promise<AuthResponse> {
    const { email, password, firstName, lastName, dateOfBirth, gender, hasAcceptedTerms, ipAddress, userAgent } = signUpDto;

    // Validate age requirement (18+)
    if (!signUpDto.dateOfBirth) {
      throw new BadRequestException('Date of birth is required');
    }

    const birthDate = new Date(signUpDto.dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDifference = today.getMonth() - birthDate.getMonth();
    
    // Adjust age if birthday hasn't occurred yet this year
    const actualAge = monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate()) ? age - 1 : age;
    
    if (actualAge < 13) {
      throw new BadRequestException('You must be at least 13 years old to create an account');
    }

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
      if (error instanceof ConflictException) throw error;
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
        hasAcceptedTerms,
      },
      // Track terms acceptance at signup stage
      hasAcceptedTerms,
      termsAcceptedAt: hasAcceptedTerms ? new Date().toISOString() : null,
      ipAddress,
      userAgent,
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
          ip_address: ipAddress || null,
          user_agent: userAgent || null,
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
    console.log('🔍 Attempting to send verification email...');
    const emailSent = await this.emailService.sendVerificationEmail(email, token, firstName, lastName);
    
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

  async signIn(signInDto: SignInDto, ipAddress?: string, userAgent?: string): Promise<AuthResponse> {
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

    // Generate our custom token pair (7-day access + 30-day refresh)
    const deviceInfo = {
      userAgent: userAgent || 'signin_request',
      platform: 'unknown',
    };
    
    const tokenPair = await this.tokenService.generateTokenPair(
      data.user.id,
      deviceInfo,
      ipAddress || 'unknown'
    );

    // Return our custom tokens with complete user profile
    // Industry standard: Allow suspended users to authenticate but mark them
    return {
      user: userData,
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
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

  async checkUsernameAvailability(username: string): Promise<boolean> {
    try {
      const normalized = username.toLowerCase().trim();
      const { data } = await this.serviceSupabase
        .from('user_profiles')
        .select('id')
        .ilike('username', normalized)
        .single();
      return !data; // true = available
    } catch {
      return true; // no row found → available
    }
  }

  async checkEmailAvailability(email: string): Promise<boolean> {
    try {
      // Check if user exists in Supabase Auth using serviceSupabase
      const { data: existingUser } = await this.serviceSupabase.auth.admin.getUserByEmail(email);
      
      if (existingUser?.user) {
        return false; // Email is taken
      }

      // Check if user exists in user_profiles (legacy check) using serviceSupabase
      const { data: profileData } = await this.serviceSupabase
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
        email_confirmed,
        first_name,
        last_name
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

    // Extract name from profile data
    const firstName = profileData.first_name || '';
    const lastName = profileData.last_name || '';

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
    const emailSent = await this.emailService.sendVerificationEmail(email, token, firstName, lastName);

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
        const { data, error } = await this.serviceSupabase.auth.admin.createUser({
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

        // Generate token pair for the migrated user
        const deviceInfo = {
          userAgent: 'account_migration',
          platform: 'unknown',
        };
        
        const tokenPair = await this.tokenService.generateTokenPair(
          signInData.user.id,
          deviceInfo,
          'migration_ip'
        );

        return {
          user: migratedUserData,
          accessToken: tokenPair.accessToken,
          refreshToken: tokenPair.refreshToken,
        };
      }

      throw new UnauthorizedException('Email not found in user profiles');
    } catch (error) {
      throw new UnauthorizedException('Migration failed: ' + error.message);
    }
  }

  async resetPassword(email: string): Promise<{ success: boolean; message: string }> {
    console.log(`Password reset request for: ${email}`);

    try {
      // Generate custom 6-digit token
      const { data: tokenData, error: tokenError } = await this.serviceSupabase
        .rpc('generate_password_reset_token');

      if (tokenError || !tokenData) {
        console.error(`Failed to generate reset token for ${email}:`, tokenError);
        return {
          success: false,
          message: 'Failed to process password reset request',
        };
      }

      const resetToken = tokenData; // tokenData is now a TEXT string, not an array
      
      // Save the reset token to user profile
      console.log('💾 Saving reset token to user profile...');
      const { data: saveResult, error: saveError } = await this.serviceSupabase
        .rpc('save_reset_token', {
          p_user_email: email.toLowerCase(),
          p_token: resetToken,
          p_expires_hours: 1
        });

      if (saveError) {
        console.error(`Failed to save reset token for ${email}:`, saveError);
        return {
          success: false,
          message: 'Failed to process password reset request',
        };
      }

      if (!saveResult?.success) {
        console.error(`Failed to save reset token for ${email}:`, saveResult?.message);
        return {
          success: false,
          message: 'Failed to process password reset request',
        };
      }

      console.log(`Reset token generated for: ${email}, token: ${resetToken}`);

      // Send custom email with 6-digit token via Resend
      console.log('🔍 Initializing password reset email service...');
      const emailSent = await this.emailService.sendPasswordResetEmail(email, resetToken);

      console.log('🔍 Password reset email service result:', { 
        emailSent, 
        email, 
        tokenLength: resetToken.length,
        token: resetToken
      });

      if (!emailSent) {
        console.error(`Failed to send password reset email to ${email}`);
        return {
          success: false,
          message: 'Failed to send password reset email',
        };
      }

      console.log(`✅ Password reset email sent to: ${email}`);

      return {
        success: true,
        message: 'If an account with this email exists, you will receive a password reset code.',
      };
    } catch (error) {
      console.error(`Password reset error for ${email}:`, error);
      return {
        success: true, // Return success for security - don't reveal if email exists
        message: 'If an account with this email exists, you will receive a password reset code.',
      };
    }
  }

  async checkResetStatus(email: string): Promise<{ canReset: boolean; nextAttemptTime: string | null; message: string }> {
    try {
      console.log('🔍 Checking reset status for email:', email);
      
      // Check if there's a recent token (within last 24 hours)
      const { data: existingTokens, error: tokenCheckError } = await this.serviceSupabase
        .from('user_profiles')
        .select('reset_token, reset_token_expires_at')
        .not('reset_token', 'is', null)
        .order('reset_token_expires_at', 'desc')
        .limit(1);

      if (tokenCheckError) {
        console.error('❌ Error checking reset status:', tokenCheckError);
        return {
          canReset: true,
          nextAttemptTime: null,
          message: 'Unable to check reset status',
        };
      }

      if (!existingTokens || existingTokens.length === 0) {
        // No tokens found - user can reset
        return {
          canReset: true,
          nextAttemptTime: null,
          message: 'Password reset available',
        };
      }

      const latestToken = existingTokens[0];
      const tokenExpiry = new Date(latestToken.reset_token_expires_at);
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      if (tokenExpiry > twentyFourHoursAgo) {
        // Token still valid - user must wait
        const nextAttemptTime = new Date(tokenExpiry.getTime() + 60 * 60 * 1000);
        
        return {
          canReset: false,
          nextAttemptTime: nextAttemptTime.toISOString(),
          message: `Password reset email already sent. Please check your email or try again after ${nextAttemptTime.toLocaleString()}.`,
        };
      } else {
        // Token expired - user can reset again
        return {
          canReset: true,
          nextAttemptTime: null,
          message: 'Password reset available',
        };
      }
    } catch (error) {
      console.error('❌ Check reset status error:', error);
      return {
        canReset: false,
        nextAttemptTime: null,
        message: 'Failed to check reset status',
      };
    }
  }

  async verifyResetToken(email: string, token: string): Promise<{ valid: boolean; message: string }> {
    try {
      console.log('🔍 Verifying reset token with database function...');
      console.log('- Email:', email);
      console.log('- Token:', token);
      
      // Use database function to verify token
      const { data: result, error: rpcError } = await this.serviceSupabase
        .rpc('verify_reset_token_func', {
          p_email: email.toLowerCase(),
          p_token: token
        });

      if (rpcError) {
        console.error('❌ Database function error:', rpcError);
        return {
          valid: false,
          message: 'Failed to verify reset token',
        };
      }

      console.log('🔍 Database function result:', result);

      if (result?.valid) {
        console.log('✅ Token is valid!');
        return {
          valid: true,
          message: result?.message || 'Token is valid',
        };
      } else {
        console.log('❌ Token validation failed:', result?.message);
        return {
          valid: false,
          message: result?.message || 'Invalid or expired reset token',
        };
      }
    } catch (error) {
      console.error('❌ Token verification error:', error);
      return {
        valid: false,
        message: 'Failed to verify reset token',
      };
    }
  }

  async confirmResetPassword(email: string, token: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    try {
      console.log('🔍 Confirming password reset...');
      console.log('- Email:', email);
      console.log('- Token:', token);
      
      // First verify the token using database function
      const { data: verification, error: verifyError } = await this.serviceSupabase
        .rpc('verify_reset_token_func', {
          p_email: email.toLowerCase(),
          p_token: token
        });

      if (verifyError) {
        console.error('❌ Token verification error:', verifyError);
        return {
          success: false,
          message: 'Failed to verify reset token',
        };
      }

      if (!verification?.valid) {
        console.log('❌ Token validation failed:', verification?.message);
        return {
          success: false,
          message: verification?.message || 'Invalid or expired reset token',
        };
      }

      console.log('✅ Token verified, updating password...');
      
      // Update password using database function that integrates with Supabase Auth
      const { data: result, error: updateError } = await this.serviceSupabase
        .rpc('update_user_password', {
          p_user_email: email.toLowerCase(),
          p_new_password: newPassword
        });

      if (updateError) {
        console.error('❌ Password update error:', updateError);
        return {
          success: false,
          message: 'Failed to update password',
        };
      }

      console.log('🔍 Password update result:', result);

      if (!result?.success) {
        return {
          success: false,
          message: result?.message || 'Failed to update password',
        };
      }

      // Clear the reset token (optional but good practice)
      console.log('🧹 Clearing reset token...');
      const { data: clearResult, error: clearError } = await this.serviceSupabase
        .rpc('clear_reset_token', { p_profile_id: verification.user_id });

      if (clearError) {
        console.warn('⚠️ Warning: Failed to clear reset token:', clearError);
      } else {
        console.log('✅ Reset token cleared');
      }

      console.log('✅ Password reset completed successfully!');
      return {
        success: true,
        message: 'Password has been reset successfully',
      };
    } catch (error) {
      console.error('❌ Confirm reset password error:', error);
      return {
        success: false,
        message: 'Failed to reset password',
      };
    }
  }
}
