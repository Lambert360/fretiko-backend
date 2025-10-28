/**
 * FRETIKO REWARDS CONTROLLER
 * REST API endpoints for rewards system
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

interface RedeemRewardsDto {
  rewards_amount: number;
  order_id?: string;
}

interface ReverseRedemptionDto {
  rewards_amount: number;
  order_id?: string;
}

@Controller('rewards')
@UseGuards(JwtAuthGuard)
export class RewardsController {
  private readonly logger = new Logger(RewardsController.name);

  constructor(private readonly rewardsService: RewardsService) {}

  // ============================================
  // USER REWARDS ENDPOINTS
  // ============================================

  /**
   * GET /rewards/balance - Get user's rewards balance
   */
  @Get('balance')
  async getRewardsBalance(@Request() req: any) {
    this.logger.log(`Getting rewards balance for user ${req.user.sub}`);
    
    const balance = await this.rewardsService.getUserRewardsBalance(req.user.sub);
    
    return {
      user_id: req.user.sub,
      available_rewards: balance?.available_rewards || 0,
      pending_rewards: balance?.pending_rewards || 0,
      lifetime_earned: balance?.lifetime_earned || 0,
      lifetime_spent: balance?.lifetime_spent || 0,
      last_calculation_period: balance?.last_calculation_period,
      display_available: this.rewardsService.fretiToRewardsDisplay(balance?.available_rewards || 0),
      display_pending: this.rewardsService.fretiToRewardsDisplay(balance?.pending_rewards || 0),
    };
  }

  /**
   * GET /rewards/summary - Get user's rewards summary with current month progress
   */
  @Get('summary')
  async getRewardsSummary(@Request() req: any) {
    this.logger.log(`Getting rewards summary for user ${req.user.sub}`);
    
    const summary = await this.rewardsService.getUserRewardsSummary(req.user.sub);
    
    return {
      ...summary,
      display_available: this.rewardsService.fretiToRewardsDisplay(summary.available_rewards),
      display_pending: this.rewardsService.fretiToRewardsDisplay(summary.pending_rewards),
      display_current_month_rewards: this.rewardsService.fretiToRewardsDisplay(summary.current_month_rewards),
    };
  }

  /**
   * POST /rewards/redeem - Redeem rewards for a purchase
   */
  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  async redeemRewards(@Request() req: any, @Body() body: RedeemRewardsDto) {
    this.logger.log(`User ${req.user.sub} redeeming ${body.rewards_amount} rewards`);
    
    const result = await this.rewardsService.redeemRewards(
      req.user.sub,
      body.rewards_amount,
      body.order_id
    );
    
    return {
      success: result.success,
      transaction_id: result.transaction_id,
      redeemed_amount: body.rewards_amount,
      display_redeemed: this.rewardsService.fretiToRewardsDisplay(body.rewards_amount),
    };
  }

  /**
   * POST /rewards/reverse - Reverse rewards redemption (for cancelled orders)
   */
  @Post('reverse')
  @HttpCode(HttpStatus.OK)
  async reverseRedemption(@Request() req: any, @Body() body: ReverseRedemptionDto) {
    this.logger.log(`Reversing ${body.rewards_amount} rewards for user ${req.user.sub}`);
    
    const result = await this.rewardsService.reverseRewardsRedemption(
      req.user.sub,
      body.rewards_amount,
      body.order_id
    );
    
    return {
      success: result.success,
      reversed_amount: body.rewards_amount,
      display_reversed: this.rewardsService.fretiToRewardsDisplay(body.rewards_amount),
    };
  }

  // ============================================
  // CALCULATION ENDPOINTS
  // ============================================

  /**
   * GET /rewards/calculate/:period - Calculate rewards for specific period
   * (for testing or manual calculation)
   */
  @Get('calculate/:period')
  async calculatePeriodRewards(
    @Request() req: any,
    @Param('period') period: string
  ) {
    this.logger.log(`Calculating rewards for user ${req.user.sub} period ${period}`);
    
    const result = await this.rewardsService.calculateMonthlyRewards(req.user.sub, period);
    
    if (!result) {
      return {
        message: 'No qualifying transactions found for the period',
        period,
        calculated_rewards: 0,
      };
    }
    
    return {
      ...result,
      display_calculated: this.rewardsService.fretiToRewardsDisplay(result.calculated_rewards),
    };
  }

  /**
   * POST /rewards/credit/:period - Credit calculated rewards to balance
   * (for testing or manual crediting)
   */
  @Post('credit/:period')
  @HttpCode(HttpStatus.OK)
  async creditPeriodRewards(
    @Request() req: any,
    @Param('period') period: string
  ) {
    this.logger.log(`Crediting rewards for user ${req.user.sub} period ${period}`);
    
    const success = await this.rewardsService.creditMonthlyRewards(req.user.sub, period);
    
    return {
      success,
      period,
      message: success 
        ? `Rewards credited for period ${period}` 
        : `Failed to credit rewards for period ${period}`,
    };
  }

  // ============================================
  // WALLET INTEGRATION ENDPOINTS
  // ============================================

  /**
   * GET /rewards/wallet-display - Get rewards data for wallet display
   * Returns formatted data for the wallet screen
   */
  @Get('wallet-display')
  async getWalletDisplay(@Request() req: any) {
    try {
      this.logger.log(`Getting wallet display rewards for user ${req.user.sub}`);

      const summary = await this.rewardsService.getUserRewardsSummary(req.user.sub);
      const currentMonth = new Date().toISOString().slice(0, 7);

      return {
        available_rewards: summary.available_rewards,
        pending_rewards: summary.pending_rewards,
        display_available: this.rewardsService.fretiToRewardsDisplay(summary.available_rewards),
        display_pending: this.rewardsService.fretiToRewardsDisplay(summary.pending_rewards),
        next_credit_date: this.getNextCreditDate(),
        has_pending: summary.pending_rewards > 0,
        rewards_enabled: summary.rewards_enabled,
        current_month_progress: {
          transaction_amount: summary.current_month_transactions || 0,
          estimated_rewards: summary.current_month_rewards || 0,
          display_estimated: this.rewardsService.fretiToRewardsDisplay(summary.current_month_rewards || 0),
          period: currentMonth,
        },
      };
    } catch (error) {
      this.logger.error(`Error getting wallet display rewards for user ${req.user.sub}:`, error);
      // Return safe defaults instead of throwing
      const currentMonth = new Date().toISOString().slice(0, 7);
      return {
        available_rewards: 0,
        pending_rewards: 0,
        display_available: this.rewardsService.fretiToRewardsDisplay(0),
        display_pending: this.rewardsService.fretiToRewardsDisplay(0),
        next_credit_date: this.getNextCreditDate(),
        has_pending: false,
        rewards_enabled: false,
        current_month_progress: {
          transaction_amount: 0,
          estimated_rewards: 0,
          display_estimated: this.rewardsService.fretiToRewardsDisplay(0),
          period: currentMonth,
        },
      };
    }
  }

  /**
   * GET /rewards/checkout-display - Get rewards data for checkout screen
   * Returns available rewards that can be used for checkout
   */
  @Get('checkout-display')
  async getCheckoutDisplay(@Request() req: any) {
    try {
      this.logger.log(`Getting checkout display rewards for user ${req.user.sub}`);

      const balance = await this.rewardsService.getUserRewardsBalance(req.user.sub);

      return {
        available_rewards: balance?.available_rewards || 0,
        display_available: this.rewardsService.fretiToRewardsDisplay(balance?.available_rewards || 0),
        can_redeem: (balance?.available_rewards || 0) > 0,
        max_redeemable: balance?.available_rewards || 0,
      };
    } catch (error) {
      this.logger.error(`Error getting checkout display rewards for user ${req.user.sub}:`, error);
      // Return safe defaults instead of throwing
      return {
        available_rewards: 0,
        display_available: this.rewardsService.fretiToRewardsDisplay(0),
        can_redeem: false,
        max_redeemable: 0,
      };
    }
  }

  /**
   * GET /rewards/history - Get user's rewards transaction history
   * Returns paginated list of rewards transactions (credits, redemptions, reversals)
   */
  @Get('history')
  async getRewardsHistory(
    @Request() req: any,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('type') type?: string,
  ) {
    try {
      this.logger.log(`Getting rewards history for user ${req.user.sub}`);
      
      const transactions = await this.rewardsService.getRewardsTransactionHistory(
        req.user.sub,
        limit || 50,
        offset || 0,
        type
      );
      
      return {
        transactions,
        total: transactions.length,
        limit: limit || 50,
        offset: offset || 0,
      };
    } catch (error) {
      this.logger.error(`Error getting rewards history for user ${req.user.sub}:`, error);
      return {
        transactions: [],
        total: 0,
        limit: limit || 50,
        offset: offset || 0,
      };
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * Calculate next credit date (1st of next month)
   */
  private getNextCreditDate(): string {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth.toISOString().split('T')[0];
  }
}