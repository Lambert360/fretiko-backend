import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';

export interface ReferralStats {
  total_referrals: number;
  completed_referrals: number;
  pending_referrals: number;
  total_clicks: number;
  total_rewards: number;
}

export interface ReferralData {
  code: string;
  url: string;
  stats: ReferralStats;
}

@Injectable()
export class ReferralsService {
  constructor(private readonly supabaseClientManager: SupabaseClientManager) {}

  /**
   * Get user's referral data including code, URL, and stats
   */
  async getUserReferralData(userId: string): Promise<ReferralData> {
    const supabase = this.supabaseClientManager.getServiceClient();

    // Get user's referral code
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('referral_code')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      throw new NotFoundException('User profile not found');
    }

    // Generate referral code if missing
    let referralCode = profile.referral_code;
    if (!referralCode) {
      const { data: updated } = await supabase
        .from('user_profiles')
        .update({ referral_code: await this.generateReferralCode() })
        .eq('id', userId)
        .select('referral_code')
        .single();

      referralCode = updated?.referral_code;
    }

    // Get referral stats
    const stats = await this.getReferralStats(userId);

    // Build referral URL
    const referralUrl = `https://fretiko.com/r/${referralCode}`;

    return {
      code: referralCode,
      url: referralUrl,
      stats,
    };
  }

  /**
   * Validate a referral code
   */
  async validateReferralCode(code: string): Promise<{ valid: boolean; referrerId?: string }> {
    const supabase = this.supabaseClientManager.getServiceClient();

    const { data, error } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('referral_code', code)
      .single();

    if (error || !data) {
      return { valid: false };
    }

    return { valid: true, referrerId: data.id };
  }

  /**
   * Track a referral click
   */
  async trackReferralClick(code: string): Promise<{ success: boolean; referrerId?: string }> {
    const supabase = this.supabaseClientManager.getServiceClient();

    const { data, error } = await supabase.rpc('track_referral_click', {
      p_referral_code: code,
    });

    if (error) {
      throw new BadRequestException('Failed to track referral click');
    }

    return {
      success: data.success,
      referrerId: data.referrer_id,
    };
  }

  /**
   * Complete referral when user signs up
   */
  async completeReferral(userId: string, referralCode: string): Promise<{ success: boolean }> {
    const supabase = this.supabaseClientManager.getServiceClient();

    const { data, error } = await supabase.rpc('complete_referral', {
      p_referred_user_id: userId,
      p_referral_code: referralCode,
    });

    if (error) {
      throw new BadRequestException('Failed to complete referral');
    }

    return { success: data.success };
  }

  /**
   * Get referral history for a user
   */
  async getReferralHistory(userId: string) {
    const supabase = this.supabaseClientManager.getServiceClient();

    const { data, error } = await supabase
      .from('referrals')
      .select(`
        *,
        referred_user:user_profiles!referred_user_id (
          username,
          full_name,
          avatar_url
        )
      `)
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException('Failed to fetch referral history');
    }

    return data;
  }

  /**
   * Get referral stats for a user
   */
  private async getReferralStats(userId: string): Promise<ReferralStats> {
    const supabase = this.supabaseClientManager.getServiceClient();

    const { data, error } = await supabase.rpc('get_referral_stats', {
      p_user_id: userId,
    });

    if (error) {
      // Return default stats if function fails
      return {
        total_referrals: 0,
        completed_referrals: 0,
        pending_referrals: 0,
        total_clicks: 0,
        total_rewards: 0,
      };
    }

    return data as ReferralStats;
  }

  /**
   * Generate a unique referral code (fallback if DB function fails)
   */
  private async generateReferralCode(): Promise<string> {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const length = 7;
    let code = '';
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;

    const supabase = this.supabaseClientManager.getServiceClient();

    while (!isUnique && attempts < maxAttempts) {
      code = '';
      for (let i = 0; i < length; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }

      const { data } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('referral_code', code)
        .single();

      if (!data) {
        isUnique = true;
      }

      attempts++;
    }

    return code;
  }
}
