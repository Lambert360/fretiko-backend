import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createSupabaseClient } from '../shared/supabase.client';
import { SignUpDto, SignInDto, AuthResponse } from '../shared/dto/auth.dto';

@Injectable()
export class AuthService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async signUp(signUpDto: SignUpDto): Promise<AuthResponse> {
    const { email, password, firstName, lastName, dateOfBirth, gender } = signUpDto;

    console.log('🔍 SignUp attempt:', {
      email,
      hasPassword: !!password,
      passwordLength: password?.length,
      firstName,
      lastName,
      dateOfBirth,
      gender,
    });

    // Create user in Supabase Auth
    const { data, error } = await this.supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
          date_of_birth: dateOfBirth,
          gender,
        },
      },
    });

    console.log('🔍 Supabase signup response:', {
      hasData: !!data,
      hasUser: !!data?.user,
      hasSession: !!data?.session,
      hasError: !!error,
      errorMessage: error?.message,
      errorStatus: error?.status,
      errorCode: error?.code
    });

    if (error) {
      console.log('❌ Full Supabase error:', JSON.stringify(error, null, 2));
      throw new ConflictException(error.message);
    }

    // Debug: Check what Supabase returns
    console.log('Signup result - user:', !!data.user, 'session:', !!data.session);

    if (!data.session) {
      console.log('⚠️ No session returned - email confirmation might be required');
      throw new ConflictException(
        'Account created but email confirmation required. Please check your email and click the confirmation link, then try signing in.'
      );
    }

    // Fetch complete user profile from user_profiles table (for new signups this might be empty initially)
    const { data: profileData, error: profileError } = await this.supabase
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
      .eq('id', data.user.id)
      .single();

    const userData = {
      id: data.user.id,
      email: data.user.email,
      firstName: profileData?.first_name || data.user.user_metadata?.first_name,
      lastName: profileData?.last_name || data.user.user_metadata?.last_name,
      username: profileData?.username,
      avatar_url: profileData?.avatar_url,
      user_role: profileData?.user_role || 'citizen', // Default for new users
      is_seller: profileData?.is_seller || false,
      is_rider: profileData?.is_rider || false,
      is_verified: profileData?.is_verified || false,
    };

    // Return Supabase session tokens with complete user profile
    return {
      user: userData,
      accessToken: data.session?.access_token || '',
      refreshToken: data.session?.refresh_token || '',
    };
  }

  async signIn(signInDto: SignInDto): Promise<AuthResponse> {
    const { email, password } = signInDto;

    console.log('🔍 SignIn attempt:', {
      email,
      hasPassword: !!password,
      passwordLength: password?.length
    });

    // Sign in with Supabase Auth
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password,
    });

    console.log('🔍 Supabase signin response:', {
      hasData: !!data,
      hasUser: !!data?.user,
      hasSession: !!data?.session,
      hasError: !!error,
      errorMessage: error?.message,
      errorStatus: error?.status,
      errorCode: error?.code
    });

    if (error) {
      console.log('❌ Supabase signin failed:', error.message);

      // Check if this might be a legacy user
      if (error.message.includes('Invalid login credentials')) {
        console.log('🔍 Checking for legacy user in user_profiles table...');

        // Check if user exists in user_profiles table (legacy user)
        const { data: profileData, error: profileError } = await this.supabase
          .from('user_profiles')
          .select('id, email, first_name, last_name')
          .eq('email', email)
          .single();

        if (profileData && !profileError) {
          console.log('🔍 Found legacy user, needs migration');
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

    console.log('✅ Signin successful - fetching complete user profile');

    // Fetch complete user profile from user_profiles table
    const { data: profileData, error: profileError } = await this.supabase
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
      .eq('id', data.user.id)
      .single();

    const userData = {
      id: data.user.id,
      email: data.user.email,
      firstName: profileData?.first_name || data.user.user_metadata?.first_name,
      lastName: profileData?.last_name || data.user.user_metadata?.last_name,
      username: profileData?.username,
      avatar_url: profileData?.avatar_url,
      user_role: profileData?.user_role,
      is_seller: profileData?.is_seller,
      is_rider: profileData?.is_rider,
      is_verified: profileData?.is_verified,
    };

    console.log('👤 Complete user profile loaded:', {
      user_role: userData.user_role,
      is_seller: userData.is_seller,
      is_rider: userData.is_rider,
      profileFound: !!profileData,
      profileError: profileError?.message
    });

    // Return Supabase session tokens with complete user profile
    return {
      user: userData,
      accessToken: data.session?.access_token || '',
      refreshToken: data.session?.refresh_token || '',
    };
  }

  async migrateAccount(email: string, newPassword: string): Promise<AuthResponse> {
    console.log('🔄 Account migration attempt:', { email });

    // First, check if user exists in user_profiles (legacy user)
    const { data: profileData, error: profileError } = await this.supabase
      .from('user_profiles')
      .select('id, email, first_name, last_name')
      .eq('email', email)
      .single();

    if (profileError || !profileData) {
      throw new UnauthorizedException('No legacy account found for this email');
    }

    // Check if already migrated (exists in Supabase Auth)
    const { data: existingUser } = await this.supabase.auth.admin.getUserByEmail(email);
    if (existingUser.user) {
      throw new ConflictException('Account already migrated. Please use regular login.');
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
      console.error('❌ Migration failed:', error);
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

    console.log('✅ Account migration successful - fetching complete profile');

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
}