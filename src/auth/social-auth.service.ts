import { Injectable, Logger, UnauthorizedException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import { SocialAuthDto, SocialAuthResponse } from './dto/social-auth.dto';
import { TokenService } from './token.service';

@Injectable()
export class SocialAuthService {
  private readonly logger = new Logger(SocialAuthService.name);
  private supabase: SupabaseClient;

  constructor(
    private configService: ConfigService,
    private tokenService: TokenService,
  ) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseServiceKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured');
    }
    
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  private async exchangeGoogleCodeForIdToken(code: string, redirectUri?: string): Promise<string> {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new UnauthorizedException('Google OAuth is not configured on the server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri || 'fretiko:/oauth2redirect/google',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await response.json();

    if (!response.ok) {
      this.logger.error('Google token exchange failed:', data);
      throw new UnauthorizedException(`Google token exchange failed: ${data.error_description || data.error || 'Unknown error'}`);
    }

    if (!data.id_token) {
      throw new UnauthorizedException('Google did not return an ID token.');
    }

    return data.id_token;
  }

  /**
   * Authenticate or sign up a user with Google/Apple.
   * Existing social users log in. New users must accept terms and complete the profile.
   */
  async authenticateWithSocialProvider(socialAuthDto: SocialAuthDto, ipAddress?: string, userAgent?: string): Promise<SocialAuthResponse> {
    const { provider, accessToken, idToken, code, redirectUri, hasAcceptedTerms, dateOfBirth, gender, user_role, is_seller, is_rider, firstName, lastName, referralCode } = socialAuthDto;

    if (provider !== 'google' && provider !== 'apple') {
      this.logger.warn(`Unsupported social provider received: ${provider}`);
      return { success: false, message: 'Unsupported OAuth provider' };
    }

    let token = idToken || accessToken;

    if (provider === 'google' && !token && code) {
      token = await this.exchangeGoogleCodeForIdToken(code, redirectUri);
    }

    if (!token) {
      return { success: false, message: 'Provider token is required' };
    }

    try {
      const { data, error } = await this.supabase.auth.signInWithIdToken({
        provider,
        token,
      });

      if (error) {
        throw new UnauthorizedException(`${provider} authentication failed: ${error.message}`);
      }

      if (!data.user || !data.session) {
        throw new UnauthorizedException(`${provider} authentication failed: No user session created`);
      }

      // Clear the in-memory session so that subsequent DB calls use the service role key (bypass RLS)
      await this.supabase.auth.signOut({ scope: 'local' });

      const userId = data.user.id;
      const email = data.user.email || '';
      const providerUserId = data.user.user_metadata?.provider_id || data.user.id;

      const { data: profileData } = await this.supabase
        .from('user_profiles')
        .select('id, username, avatar_url, user_role, is_seller, is_rider, is_verified, display_name, email_confirmed, terms_accepted_at, preferences')
        .eq('id', userId)
        .single();

      const isProfileComplete = !!profileData?.terms_accepted_at;
      const isNewUser = !isProfileComplete;

      if (!isProfileComplete) {
        if (!hasAcceptedTerms) {
          return {
            success: false,
            message: 'Please accept the terms and complete your profile to continue.',
            requiresProfile: true,
            idToken: token,
            user: {
              id: userId,
              email,
              firstName: data.user.user_metadata?.given_name || firstName || '',
              lastName: data.user.user_metadata?.family_name || lastName || '',
              avatar_url: data.user.user_metadata?.picture || null,
            },
          };
        }

        // Build display name from DTO or Supabase metadata
        const dtoFullName = `${firstName || ''} ${lastName || ''}`.trim();
        const providerName =
          data.user.user_metadata?.full_name ||
          data.user.user_metadata?.name ||
          data.user.user_metadata?.display_name ||
          '';
        const displayName = dtoFullName || providerName || (email ? email.split('@')[0] : '');

        const [derivedFirstName, ...rest] = (dtoFullName || providerName || '').split(' ');
        const derivedLastName = rest.join(' ');

        const upsertPayload: any = {
          id: userId,
          email_confirmed: true,
          display_name: displayName,
          avatar_url:
            data.user.user_metadata?.avatar_url ||
            data.user.user_metadata?.picture ||
            null,
          user_role: user_role || 'citizen',
          is_seller: is_seller || false,
          is_rider: is_rider || false,
          gender: gender || null,
          date_of_birth: dateOfBirth || null,
          terms_accepted_at: new Date().toISOString(),
          terms_accepted_ip: ipAddress || null,
          terms_accepted_user_agent: userAgent || null,
          ...(referralCode && { referred_by_code: referralCode }),
          preferences: {
            ...(profileData?.preferences || {}),
            auth_provider: provider,
            social_auth: true,
            provider_user_id: providerUserId,
            ...(gender && { gender }),
            ...(dateOfBirth && { date_of_birth: dateOfBirth }),
          },
        };

        const { error: upsertError } = await this.supabase
          .from('user_profiles')
          .upsert(upsertPayload)
          .eq('id', userId);

        if (upsertError) {
          this.logger.error('Failed to create social user profile:', upsertError);
          throw new UnauthorizedException('Failed to create user profile');
        }
      }

      await this.logSocialAuth(
        userId,
        provider,
        providerUserId,
        email,
        isNewUser ? 'signup' : 'signin',
        ipAddress,
        userAgent,
        {
          created_at: new Date().toISOString(),
          provider,
        }
      );

      const tokens = await this.tokenService.generateTokenPair(userId, userAgent, ipAddress);

      const { data: finalProfile } = await this.supabase
        .from('user_profiles')
        .select('id, username, avatar_url, user_role, is_seller, is_rider, is_verified, display_name')
        .eq('id', userId)
        .single();

      const dtoFullName = `${firstName || ''} ${lastName || ''}`.trim();
      const providerName =
        data.user.user_metadata?.full_name ||
        data.user.user_metadata?.name ||
        data.user.user_metadata?.display_name ||
        '';
      const fullName = dtoFullName || providerName;
      const nameParts = fullName.split(' ');

      const userData = {
        id: userId,
        email,
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' ') || '',
        username: finalProfile?.username || finalProfile?.display_name || null,
        avatar_url: finalProfile?.avatar_url,
        user_role: finalProfile?.user_role || 'citizen',
        is_seller: finalProfile?.is_seller || false,
        is_rider: finalProfile?.is_rider || false,
        is_verified: finalProfile?.is_verified || false,
      };

      return {
        success: true,
        message: isNewUser ? 'Account created successfully' : 'Authentication successful',
        user: userData,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        isNewUser,
        isSuspended: false,
      };
    } catch (error: any) {
      this.logger.error(`Social auth failed for ${provider}:`, error);
      return {
        success: false,
        message: error.message || `Failed to authenticate with ${provider}`,
      };
    }
  }

  /**
   * Link social account to existing user
   */
  async linkSocialAccount(userId: string, socialAuthDto: SocialAuthDto): Promise<SocialAuthResponse> {
    const { provider, accessToken, idToken } = socialAuthDto;

    try {
      const token = idToken || accessToken;
      if (!token) {
        return { success: false, message: 'Provider token is required' };
      }

      const { data, error } = await this.supabase.auth.signInWithIdToken({
        provider,
        token,
      });

      if (error || !data.user) {
        throw new UnauthorizedException(`Failed to verify ${provider} token`);
      }

      const providerUserId = data.user.user_metadata?.provider_id || data.user.id;

      const { data: existingLink } = await this.supabase
        .from('social_auth_logs')
        .select('user_id')
        .eq('provider', provider)
        .eq('provider_user_id', providerUserId)
        .eq('action', 'signup')
        .maybeSingle();

      if (existingLink && existingLink.user_id !== userId) {
        throw new ConflictException(`${provider} account is already linked to another user`);
      }

      await this.logSocialAuth(
        userId,
        provider,
        providerUserId,
        data.user.email || null,
        'link',
        undefined,
        undefined,
        {
          linked_at: new Date().toISOString(),
          provider,
        }
      );

      return {
        success: true,
        message: `${provider} account linked successfully`,
      };
    } catch (error: any) {
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
          provider,
        }
      );

      return {
        success: true,
        message: `${provider} account unlinked successfully`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to unlink ${provider} account:`, error);
      return {
        success: false,
        message: error.message || `Failed to unlink ${provider} account`,
      };
    }
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
    } catch (error: any) {
      this.logger.error('Failed to log social auth activity:', error);
    }
  }

}
