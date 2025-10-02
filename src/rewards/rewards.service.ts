/**
 * FRETIKO REWARDS SERVICE
 * Handles rewards calculation, crediting, and redemption
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createSupabaseClient } from '../shared/supabase.client';

export interface RewardsBalance {
  user_id: string;
  available_rewards: number;
  pending_rewards: number;
  lifetime_earned: number;
  lifetime_spent: number;
  last_calculation_period?: string;
  last_calculated_at?: string;
}

export interface RewardsConfig {
  rewards_rate: number;
  minimum_transaction_amount: number;
  rewards_enabled: boolean;
  calculation_period: 'monthly' | 'weekly' | 'daily';
}

export interface MonthlyCalculationResult {
  user_id: string;
  calculation_period: string;
  total_transaction_amount: number;
  calculated_rewards: number;
  credited: boolean;
}

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);
  private readonly supabase: SupabaseClient;

  constructor(private readonly configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  // ============================================
  // REWARDS BALANCE METHODS
  // ============================================

  /**
   * Get user's rewards balance
   */
  async getUserRewardsBalance(userId: string): Promise<RewardsBalance | null> {
    try {
      const { data, error } = await this.supabase
        .from('rewards_balances')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No rewards balance found, create one
          return await this.createUserRewardsBalance(userId);
        }
        throw error;
      }

      return data;
    } catch (error) {
      this.logger.error(`Error getting rewards balance for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Create rewards balance for new user
   */
  private async createUserRewardsBalance(userId: string): Promise<RewardsBalance> {
    try {
      const { data, error } = await this.supabase
        .from('rewards_balances')
        .insert({ user_id: userId })
        .select()
        .single();

      if (error) throw error;

      this.logger.log(`Created rewards balance for user ${userId}`);
      return data;
    } catch (error) {
      this.logger.error(`Error creating rewards balance for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get rewards summary with current month progress
   */
  async getUserRewardsSummary(userId: string): Promise<any> {
    try {
      const { data, error } = await this.supabase
        .from('user_rewards_summary')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) throw error;

      return data;
    } catch (error) {
      this.logger.error(`Error getting rewards summary for user ${userId}:`, error);
      throw error;
    }
  }

  // ============================================
  // REWARDS REDEMPTION METHODS
  // ============================================

  /**
   * Redeem rewards for a purchase (called during checkout)
   */
  async redeemRewards(
    userId: string, 
    rewardsAmount: number, 
    orderId?: string
  ): Promise<{ success: boolean; transaction_id?: string }> {
    try {
      // Verify user has sufficient rewards
      const balance = await this.getUserRewardsBalance(userId);
      if (!balance || balance.available_rewards < rewardsAmount) {
        throw new Error('Insufficient rewards balance');
      }

      // Create redemption transaction
      const { data, error } = await this.supabase
        .from('rewards_transactions')
        .insert({
          user_id: userId,
          transaction_type: 'purchase_redemption',
          available_delta: -rewardsAmount,
          pending_delta: 0,
          available_balance_after: balance.available_rewards - rewardsAmount,
          pending_balance_after: balance.pending_rewards,
          reference_type: 'order',
          reference_id: orderId,
          description: `Rewards redeemed for purchase: ⭐${this.formatRewards(rewardsAmount)}`,
          metadata: { order_id: orderId, redeemed_amount: rewardsAmount }
        })
        .select()
        .single();

      if (error) throw error;

      this.logger.log(`User ${userId} redeemed ⭐${this.formatRewards(rewardsAmount)} rewards`);
      return { success: true, transaction_id: data.id };
    } catch (error) {
      this.logger.error(`Error redeeming rewards for user ${userId}:`, error);
      return { success: false };
    }
  }

  /**
   * Reverse rewards redemption (for cancelled/refunded orders)
   */
  async reverseRewardsRedemption(
    userId: string, 
    rewardsAmount: number, 
    orderId?: string
  ): Promise<{ success: boolean }> {
    try {
      const balance = await this.getUserRewardsBalance(userId);
      if (!balance) throw new Error('Rewards balance not found');

      // Create reversal transaction
      const { error } = await this.supabase
        .from('rewards_transactions')
        .insert({
          user_id: userId,
          transaction_type: 'refund_reversal',
          available_delta: rewardsAmount,
          pending_delta: 0,
          available_balance_after: balance.available_rewards + rewardsAmount,
          pending_balance_after: balance.pending_rewards,
          reference_type: 'order',
          reference_id: orderId,
          description: `Rewards returned from cancelled order: ⭐${this.formatRewards(rewardsAmount)}`,
          metadata: { order_id: orderId, reversed_amount: rewardsAmount }
        });

      if (error) throw error;

      this.logger.log(`Reversed ⭐${this.formatRewards(rewardsAmount)} rewards for user ${userId}`);
      return { success: true };
    } catch (error) {
      this.logger.error(`Error reversing rewards for user ${userId}:`, error);
      return { success: false };
    }
  }

  // ============================================
  // MONTHLY REWARDS CALCULATION
  // ============================================

  /**
   * Calculate monthly rewards for a specific user
   */
  async calculateMonthlyRewards(
    userId: string, 
    calculationPeriod?: string
  ): Promise<MonthlyCalculationResult | null> {
    try {
      // Use current month if no period specified
      const period = calculationPeriod || new Date().toISOString().slice(0, 7); // YYYY-MM
      const [year, month] = period.split('-');
      const periodStart = new Date(parseInt(year), parseInt(month) - 1, 1);
      const periodEnd = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);

      // Check if already calculated for this period
      const existingCalculation = await this.getExistingCalculation(userId, period);
      if (existingCalculation) {
        this.logger.log(`Rewards already calculated for user ${userId} period ${period}`);
        return existingCalculation;
      }

      // Get rewards configuration
      const config = await this.getRewardsConfig();
      if (!config.rewards_enabled) {
        this.logger.log('Rewards system is disabled');
        return null;
      }

      // Calculate total qualifying transactions for the period
      const transactionData = await this.getQualifyingTransactions(userId, periodStart, periodEnd);
      
      if (transactionData.total_amount === 0) {
        this.logger.log(`No qualifying transactions for user ${userId} in period ${period}`);
        return null;
      }

      // Calculate rewards (1% of total transactions)
      const calculatedRewards = transactionData.total_amount * config.rewards_rate;
      
      // Create calculation record
      const { data: calculation, error } = await this.supabase
        .from('rewards_calculations')
        .insert({
          user_id: userId,
          calculation_period: period,
          period_start: periodStart.toISOString().split('T')[0],
          period_end: periodEnd.toISOString().split('T')[0],
          total_transaction_amount: transactionData.total_amount,
          qualifying_transaction_amount: transactionData.total_amount,
          transaction_count: transactionData.count,
          rewards_rate_used: config.rewards_rate,
          calculated_rewards: calculatedRewards,
          credited_rewards: calculatedRewards,
          status: 'calculated',
          processed_at: new Date().toISOString(),
          calculation_details: {
            period_start: periodStart.toISOString(),
            period_end: periodEnd.toISOString(),
            transactions: transactionData
          }
        })
        .select()
        .single();

      if (error) throw error;

      this.logger.log(`Calculated ⭐${this.formatRewards(calculatedRewards)} rewards for user ${userId} period ${period}`);
      
      return {
        user_id: userId,
        calculation_period: period,
        total_transaction_amount: transactionData.total_amount,
        calculated_rewards: calculatedRewards,
        credited: false
      };
    } catch (error) {
      this.logger.error(`Error calculating monthly rewards for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Credit calculated rewards to user's balance (run at month end)
   */
  async creditMonthlyRewards(userId: string, calculationPeriod: string): Promise<boolean> {
    try {
      // Get calculation record
      const { data: calculation, error } = await this.supabase
        .from('rewards_calculations')
        .select('*')
        .eq('user_id', userId)
        .eq('calculation_period', calculationPeriod)
        .eq('status', 'calculated')
        .single();

      if (error || !calculation) {
        this.logger.warn(`No calculation found for user ${userId} period ${calculationPeriod}`);
        return false;
      }

      if (calculation.credited_rewards <= 0) {
        this.logger.log(`No rewards to credit for user ${userId} period ${calculationPeriod}`);
        return true;
      }

      // Get current balance
      const balance = await this.getUserRewardsBalance(userId);
      if (!balance) throw new Error('Rewards balance not found');

      // Create credit transaction
      const { error: transactionError } = await this.supabase
        .from('rewards_transactions')
        .insert({
          user_id: userId,
          transaction_type: 'monthly_credit',
          available_delta: calculation.credited_rewards,
          pending_delta: 0,
          available_balance_after: balance.available_rewards + calculation.credited_rewards,
          pending_balance_after: balance.pending_rewards,
          calculation_period: calculationPeriod,
          reference_type: 'calculation',
          reference_id: calculation.id,
          description: `Monthly rewards credited for ${calculationPeriod}: ⭐${this.formatRewards(calculation.credited_rewards)}`,
          metadata: {
            calculation_id: calculation.id,
            calculation_period: calculationPeriod,
            transaction_amount: calculation.total_transaction_amount,
            rewards_rate: calculation.rewards_rate_used
          }
        });

      if (transactionError) throw transactionError;

      // Update calculation status
      await this.supabase
        .from('rewards_calculations')
        .update({ 
          status: 'credited',
          updated_at: new Date().toISOString()
        })
        .eq('id', calculation.id);

      // Update user's last calculation period
      await this.supabase
        .from('rewards_balances')
        .update({
          last_calculation_period: calculationPeriod,
          last_calculated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      this.logger.log(`Credited ⭐${this.formatRewards(calculation.credited_rewards)} rewards to user ${userId} for period ${calculationPeriod}`);
      return true;
    } catch (error) {
      this.logger.error(`Error crediting monthly rewards for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Run monthly rewards calculation for all users
   */
  async calculateAllUsersMonthlyRewards(calculationPeriod?: string): Promise<{
    processed: number;
    credited: number;
    errors: number;
  }> {
    const period = calculationPeriod || new Date().toISOString().slice(0, 7);
    const results = { processed: 0, credited: 0, errors: 0 };

    try {
      // Get all users with wallet transactions in the period
      const [year, month] = period.split('-');
      const periodStart = new Date(parseInt(year), parseInt(month) - 1, 1);
      const periodEnd = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59);

      // Get distinct users who had activity in the period
      const { data: transactions, error } = await this.supabase
        .from('wallet_ledger')
        .select('user_id')
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString())
        .in('transaction_type', ['deposit_mint', 'purchase_hold', 'escrow_release']);

      if (error) throw error;

      // Get unique user IDs
      const uniqueUserIds = [...new Set(transactions.map(t => t.user_id))];
      const users = uniqueUserIds.map(user_id => ({ user_id }));

      this.logger.log(`Processing monthly rewards for ${users.length} users for period ${period}`);

      // Process each user
      for (const { user_id } of users) {
        try {
          const calculation = await this.calculateMonthlyRewards(user_id, period);
          results.processed++;

          if (calculation && calculation.calculated_rewards > 0) {
            const credited = await this.creditMonthlyRewards(user_id, period);
            if (credited) results.credited++;
          }
        } catch (error) {
          this.logger.error(`Error processing rewards for user ${user_id}:`, error);
          results.errors++;
        }
      }

      this.logger.log(`Monthly rewards processing complete: ${results.processed} processed, ${results.credited} credited, ${results.errors} errors`);
      return results;
    } catch (error) {
      this.logger.error('Error in bulk monthly rewards calculation:', error);
      throw error;
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * Get rewards configuration
   */
  private async getRewardsConfig(): Promise<RewardsConfig> {
    try {
      const { data, error } = await this.supabase
        .from('rewards_config')
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.logger.error('Error getting rewards config:', error);
      // Return default config if none exists
      return {
        rewards_rate: 0.01,
        minimum_transaction_amount: 0,
        rewards_enabled: true,
        calculation_period: 'monthly'
      };
    }
  }

  /**
   * Get qualifying transactions for rewards calculation
   */
  private async getQualifyingTransactions(
    userId: string, 
    periodStart: Date, 
    periodEnd: Date
  ): Promise<{ total_amount: number; count: number }> {
    try {
      // Get all positive wallet transactions (money spent/earned)
      const { data, error } = await this.supabase
        .from('wallet_ledger')
        .select('available_delta, escrow_delta')
        .eq('user_id', userId)
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString())
        .in('transaction_type', ['deposit_mint', 'purchase_hold', 'escrow_release']);

      if (error) throw error;

      let totalAmount = 0;
      let count = 0;

      data.forEach(transaction => {
        // Count positive amounts (money flowing in/out, excluding fees and adjustments)
        const amount = Math.abs(transaction.available_delta) + Math.abs(transaction.escrow_delta);
        if (amount > 0) {
          totalAmount += amount;
          count++;
        }
      });

      return { total_amount: totalAmount, count };
    } catch (error) {
      this.logger.error(`Error getting qualifying transactions for user ${userId}:`, error);
      return { total_amount: 0, count: 0 };
    }
  }

  /**
   * Check if calculation already exists for period
   */
  private async getExistingCalculation(
    userId: string, 
    period: string
  ): Promise<MonthlyCalculationResult | null> {
    try {
      const { data, error } = await this.supabase
        .from('rewards_calculations')
        .select('*')
        .eq('user_id', userId)
        .eq('calculation_period', period)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      if (!data) return null;

      return {
        user_id: userId,
        calculation_period: period,
        total_transaction_amount: data.total_transaction_amount,
        calculated_rewards: data.calculated_rewards,
        credited: data.status === 'credited'
      };
    } catch (error) {
      this.logger.error(`Error checking existing calculation for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Format rewards amount for display (as stars)
   */
  formatRewards(amount: number): string {
    return amount.toFixed(0); // Show rewards as whole numbers (⭐5, not ⭐5.000000)
  }

  /**
   * Convert Freti amount to rewards display
   */
  fretiToRewardsDisplay(fretiAmount: number): string {
    return `⭐ ${this.formatRewards(fretiAmount)}`;
  }
}