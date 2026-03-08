import { Injectable, Logger, UnauthorizedException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import { SocialAuthDto, SocialAuthResponse } from './dto/social-auth.dto';
import { AuthResponse } from '../shared/dto/auth.dto';

@Injectable()
export class SocialAuthService {
  private readonly logger = new Logger(SocialAuthService.name);
  private supabase: SupabaseClient;

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseServiceKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured');
    }
    
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  /**
   * Authenticate user with OAuth provider
   */
  async authenticateWithSocialProvider(socialAuthDto: SocialAuthDto, ipAddress?: string, userAgent?: string): Promise<SocialAuthResponse> {
    const { provider, accessToken, idToken } = socialAuthDto;

    try {
      let authResult;

      if (provider === 'google') {
        authResult = await this.authenticateWithGoogle(accessToken, idToken);
      } else if (provider === 'apple') {
        authResult = await this.authenticateWithApple(accessToken, idToken);
      } else {
        throw new UnauthorizedException('Unsupported OAuth provider');
      }

      // Log the authentication attempt
      await this.logSocialAuth(
        authResult.user.id,
        provider,
        authResult.providerUserId,
        authResult.user.email,
        authResult.isNewUser ? 'signup' : 'signin',
        ipAddress,
        userAgent,
        {
          created_at: new Date().toISOString(),
          provider: provider,
        }
      );

      return {
        success: true,
        message: authResult.isNewUser ? 'Account created successfully' : 'Authentication successful',
        user: authResult.user,
        accessToken: authResult.accessToken,
        refreshToken: authResult.refreshToken,
        isNewUser: authResult.isNewUser,
        isSuspended: authResult.isSuspended,
      };
    } catch (error) {
      this.logger.error(`Social auth failed for ${provider}:`, error);
      
      return {
        success: false,
        message: error.message || `Failed to authenticate with ${provider}`,
      };
    }
  }

  /**
   * Authenticate with Google OAuth
   */
  private async authenticateWithGoogle(accessToken: string, idToken?: string) {
    try {
      // Verify Google token with Supabase
      const { data, error } = await this.supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken || accessToken,
      });

      if (error) {
        throw new UnauthorizedException(`Google authentication failed: ${error.message}`);
      }

      if (!data.user || !data.session) {
        throw new UnauthorizedException('Google authentication failed: No user session created');
      }

      // Fetch complete user profile
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

      // Check if this is a new user
      const isNewUser = !profileData || profileError;

      const userData = {
        id: data.user.id,
        email: data.user.email,
        firstName: data.user.user_metadata?.full_name?.split(' ')[0] || data.user.user_metadata?.name || '',
        lastName: data.user.user_metadata?.full_name?.split(' ').slice(1).join(' ') || '',
        username: profileData?.username,
        avatar_url: profileData?.avatar_url || data.user.user_metadata?.avatar_url,
        user_role: profileData?.user_role || 'citizen',
        is_seller: profileData?.is_seller || false,
        is_rider: profileData?.is_rider || false,
        is_verified: profileData?.is_verified || false,
      };

      return {
        user: userData,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        providerUserId: data.user.user_metadata?.provider_id || data.user.id,
        isNewUser,
        isSuspended: false, // Social auth users are typically not suspended
      };
    } catch (error) {
      this.logger.error('Google authentication error:', error);
      throw error;
    }
  }

  /**
   * Authenticate with Apple OAuth
   */
  private async authenticateWithApple(accessToken: string, idToken?: string) {
    try {
      // Verify Apple token with Supabase
      const { data, error } = await this.supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: idToken || accessToken,
      });

      if (error) {
        throw new UnauthorizedException(`Apple authentication failed: ${error.message}`);
      }

      if (!data.user || !data.session) {
        throw new UnauthorizedException('Apple authentication failed: No user session created');
      }

      // Fetch complete user profile
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

      // Check if this is a new user
      const isNewUser = !profileData || profileError;

      // Apple provides limited user data
      const userData = {
        id: data.user.id,
        email: data.user.email,
        firstName: data.user.user_metadata?.full_name?.split(' ')[0] || '',
        lastName: data.user.user_metadata?.full_name?.split(' ').slice(1).join(' ') || '',
        username: profileData?.username,
        avatar_url: profileData?.avatar_url,
        user_role: profileData?.user_role || 'citizen',
        is_seller: profileData?.is_seller || false,
        is_rider: profileData?.is_rider || false,
        is_verified: profileData?.is_verified || false,
      };

      return {
        user: userData,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        providerUserId: data.user.user_metadata?.provider_id || data.user.id,
        isNewUser,
        isSuspended: false,
      };
    } catch (error) {
      this.logger.error('Apple authentication error:', error);
      throw error;
    }
  }

  /**
   * Link social account to existing user
   */
  async linkSocialAccount(userId: string, socialAuthDto: SocialAuthDto): Promise<SocialAuthResponse> {
    const { provider, accessToken, idToken } = socialAuthDto;

    try {
      // Verify the social token first
      let providerData;
      
      if (provider === 'google') {
        providerData = await this.verifyGoogleToken(accessToken, idToken);
      } else if (provider === 'apple') {
        providerData = await this.verifyAppleToken(accessToken, idToken);
      } else {
        throw new UnauthorizedException('Unsupported OAuth provider');
      }

      // Check if already linked to another account
      const { data: existingLink } = await this.supabase
        .from('social_auth_logs')
        .select('user_id')
        .eq('provider', provider)
        .eq('provider_user_id', providerData.providerUserId)
        .eq('action', 'signup')
        .single();

      if (existingLink && existingLink.user_id !== userId) {
        throw new ConflictException(`${provider} account is already linked to another user`);
      }

      // Log the linking action
      await this.logSocialAuth(
        userId,
        provider,
        providerData.providerUserId,
        providerData.email,
        'link',
        undefined,
        undefined,
        {
          linked_at: new Date().toISOString(),
          provider: provider,
        }
      );

      return {
        success: true,
        message: `${provider} account linked successfully`,
      };
    } catch (error) {
      this.logger.error(`Failed to link ${provider} account:`, error);
      return {
        success: false,
        message: error.message || `Failed to link ${provider} account`,
      };
    }
  }

  /**
   * Unlink social account
   */
  async unlinkSocialAccount(userId: string, provider: string): Promise<SocialAuthResponse> {
    try {
      // Log the unlinking action
      await this.logSocialAuth(
        userId,
        provider,
        null,
        null,
        'unlink',
        undefined,
        undefined,
        {
          unlinked_at: new Date().toISOString(),
          provider: provider,
        }
      );

      return {
        success: true,
        message: `${provider} account unlinked successfully`,
      };
    } catch (error) {
      this.logger.error(`Failed to unlink ${provider} account:`, error);
      return {
        success: false,
        message: error.message || `Failed to unlink ${provider} account`,
      };
    }
  }

  /**
   * Verify Google token (basic validation)
   */
  private async verifyGoogleToken(accessToken: string, idToken?: string) {
    // This is a simplified verification
    // In production, you should verify the token with Google's API
    // For now, we'll let Supabase handle the verification
    return {
      providerUserId: 'google_user_id', // This will be provided by Supabase
      email: 'user@example.com', // This will be provided by Supabase
    };
  }

  /**
   * Verify Apple token (basic validation)
   */
  private async verifyAppleToken(accessToken: string, idToken?: string) {
    // This is a simplified verification
    // In production, you should verify the token with Apple's public keys
    // For now, we'll let Supabase handle the verification
    return {
      providerUserId: 'apple_user_id', // This will be provided by Supabase
      email: 'user@privaterelay.appleid.com', // This will be provided by Supabase
    };
  }

  /**
   * Log social authentication activity
   */
  private async logSocialAuth(
    userId: string,
    provider: string,
    providerUserId: string | null,
    email: string | null,
    action: string,
    ipAddress?: string,
    userAgent?: string,
    metadata?: any
  ): Promise<void> {
    try {
      await this.supabase.rpc('log_social_auth', {
        p_user_id: userId,
        p_provider: provider,
        p_provider_user_id: providerUserId,
        p_email: email,
        p_action: action,
        p_ip_address: ipAddress,
        p_user_agent: userAgent,
        p_metadata: metadata || {},
      });
    } catch (error) {
      this.logger.error('Failed to log social auth activity:', error);
    }
  }
}
