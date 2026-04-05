import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import * as crypto from 'crypto';

@Injectable()
export class TokenService {
  private serviceSupabase;

  constructor(
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Generate a secure random token for refresh tokens
   */
  private generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Hash a token for secure storage
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generate token pair (access + refresh) for a user
   */
  async generateTokenPair(userId: string, deviceInfo?: any, ipAddress?: string) {
    try {
      // Generate access token (7 days)
      const accessToken = this.jwtService.sign(
        { 
          sub: userId,
          type: 'access',
          iat: Math.floor(Date.now() / 1000)
        },
        { expiresIn: '7d' }
      );

      // Generate refresh token (30 days)
      const refreshToken = this.generateSecureToken();
      const refreshTokenHash = this.hashToken(refreshToken);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 days from now

      // Store refresh token in database
      const { error: insertError } = await this.serviceSupabase
        .from('refresh_tokens')
        .insert({
          user_id: userId,
          token_hash: refreshTokenHash,
          expires_at: expiresAt.toISOString(),
          device_info: deviceInfo || {},
          ip_address: ipAddress,
        });

      if (insertError) {
        console.error('❌ Failed to store refresh token:', insertError);
        throw new BadRequestException('Failed to create refresh token');
      }

      // Log user activity
      await this.logUserActivity(userId, 'login', {
        device_info: deviceInfo,
        ip_address: ipAddress,
        token_generated: true
      });

      console.log('✅ Token pair generated for user:', userId);
      
      return {
        accessToken,
        refreshToken,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      console.error('❌ Token generation error:', error);
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string, deviceInfo?: any, ipAddress?: string) {
    try {
      const refreshTokenHash = this.hashToken(refreshToken);

      // Find and validate refresh token
      const { data: tokenRecord, error: tokenError } = await this.serviceSupabase
        .from('refresh_tokens')
        .select('*')
        .eq('token_hash', refreshTokenHash)
        .eq('is_revoked', false)
        .single();

      if (tokenError || !tokenRecord) {
        console.log('❌ Invalid or expired refresh token');
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Check if token has expired
      const now = new Date().getTime();
      const expiresAt = new Date(tokenRecord.expires_at).getTime();
      
      if (now > expiresAt) {
        console.log('❌ Refresh token expired');
        // Revoke the expired token
        await this.revokeRefreshTokenByHash(refreshTokenHash);
        throw new UnauthorizedException('Refresh token expired');
      }

      // Check if user is inactive (30 days)
      const isInactive = await this.serviceSupabase
        .rpc('is_user_inactive', { p_user_id: tokenRecord.user_id });
      
      if (isInactive) {
        console.log('❌ User inactive, requiring re-authentication');
        await this.revokeRefreshToken(refreshToken);
        throw new UnauthorizedException('User inactive, please sign in again');
      }

      // Generate new access token
      const accessToken = this.jwtService.sign(
        { 
          sub: tokenRecord.user_id,
          type: 'access',
          iat: Math.floor(Date.now() / 1000)
        },
        { expiresIn: '7d' }
      );

      // Update last_used_at timestamp
      await this.serviceSupabase
        .from('refresh_tokens')
        .update({ 
          last_used_at: new Date().toISOString(),
          device_info: deviceInfo || tokenRecord.device_info,
          ip_address: ipAddress || tokenRecord.ip_address
        })
        .eq('id', tokenRecord.id);

      // Log token refresh activity
      await this.logUserActivity(tokenRecord.user_id, 'token_refresh', {
        device_info: deviceInfo,
        ip_address: ipAddress,
        refresh_token_id: tokenRecord.id
      });

      console.log('✅ Access token refreshed for user:', tokenRecord.user_id);
      
      return {
        accessToken,
        refreshToken, // Return same refresh token
        userId: tokenRecord.user_id,
      };
    } catch (error) {
      console.error('❌ Token refresh error:', error);
      throw error;
    }
  }

  /**
   * Revoke a refresh token by hash
   */
  async revokeRefreshToken(refreshToken: string) {
    try {
      const refreshTokenHash = this.hashToken(refreshToken);

      const { error } = await this.serviceSupabase
        .from('refresh_tokens')
        .update({ is_revoked: true })
        .eq('token_hash', refreshTokenHash);

      if (error) {
        console.error('❌ Failed to revoke refresh token:', error);
        return false;
      }

      console.log('✅ Refresh token revoked');
      return true;
    } catch (error) {
      console.error('❌ Token revocation error:', error);
      return false;
    }
  }

  /**
   * Revoke a refresh token by hash (internal method)
   */
  async revokeRefreshTokenByHash(refreshTokenHash: string) {
    try {
      const { error } = await this.serviceSupabase
        .from('refresh_tokens')
        .update({ is_revoked: true })
        .eq('token_hash', refreshTokenHash);

      if (error) {
        console.error('❌ Failed to revoke refresh token by hash:', error);
        return false;
      }

      console.log('✅ Refresh token revoked by hash');
      return true;
    } catch (error) {
      console.error('❌ Token revocation by hash error:', error);
      return false;
    }
  }

  /**
   * Revoke all refresh tokens for a user
   */
  async revokeAllUserTokens(userId: string) {
    try {
      const { error } = await this.serviceSupabase
        .from('refresh_tokens')
        .update({ is_revoked: true })
        .eq('user_id', userId);

      if (error) {
        console.error('❌ Failed to revoke all user tokens:', error);
        return false;
      }

      console.log('✅ All refresh tokens revoked for user:', userId);
      return true;
    } catch (error) {
      console.error('❌ Bulk token revocation error:', error);
      return false;
    }
  }

  /**
   * Log user activity
   */
  async logUserActivity(userId: string, activityType: string, metadata?: any) {
    try {
      const { error } = await this.serviceSupabase.rpc('log_user_activity', {
        p_user_id: userId,
        p_activity_type: activityType,
        p_metadata: metadata || {}
      });

      if (error) {
        console.error('❌ Failed to log user activity:', error);
      }
    } catch (error) {
      console.error('❌ Activity logging error:', error);
    }
  }

  /**
   * Get user's active sessions
   */
  async getUserActiveSessions(userId: string) {
    try {
      const { data, error } = await this.serviceSupabase
        .from('refresh_tokens')
        .select(`
          id,
          created_at,
          last_used_at,
          expires_at,
          device_info,
          ip_address
        `)
        .eq('user_id', userId)
        .eq('is_revoked', false)
        .gt('expires_at', new Date().toISOString())
        .order('last_used_at', { ascending: false });

      if (error) {
        console.error('❌ Failed to get user sessions:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      console.error('❌ Session retrieval error:', error);
      return [];
    }
  }

  /**
   * Clean up expired tokens (maintenance task)
   */
  async cleanupExpiredTokens() {
    try {
      const { error } = await this.serviceSupabase.rpc('cleanup_expired_refresh_tokens');
      
      if (error) {
        console.error('❌ Failed to cleanup expired tokens:', error);
        return false;
      }

      console.log('✅ Expired tokens cleaned up');
      return true;
    } catch (error) {
      console.error('❌ Token cleanup error:', error);
      return false;
    }
  }
}
