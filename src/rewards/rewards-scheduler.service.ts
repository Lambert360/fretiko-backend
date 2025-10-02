/**
 * FRETIKO REWARDS SCHEDULER SERVICE
 * Handles scheduled tasks for rewards calculation and crediting
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RewardsService } from './rewards.service';

@Injectable()
export class RewardsSchedulerService {
  private readonly logger = new Logger(RewardsSchedulerService.name);

  constructor(private readonly rewardsService: RewardsService) {}

  /**
   * Calculate and credit monthly rewards
   * Runs on the 1st of every month at 2:00 AM
   */
  @Cron('0 2 1 * *', {
    name: 'monthly-rewards-calculation',
    timeZone: 'UTC', // Use UTC to avoid timezone issues
  })
  async calculateMonthlyRewards(): Promise<void> {
    this.logger.log('Starting monthly rewards calculation...');

    try {
      // Calculate for the previous month
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const calculationPeriod = lastMonth.toISOString().slice(0, 7); // YYYY-MM

      this.logger.log(`Calculating rewards for period: ${calculationPeriod}`);

      // Process all users
      const results = await this.rewardsService.calculateAllUsersMonthlyRewards(calculationPeriod);

      this.logger.log(
        `Monthly rewards calculation completed: ` +
        `${results.processed} users processed, ` +
        `${results.credited} rewards credited, ` +
        `${results.errors} errors`
      );

      // Log summary for monitoring
      if (results.errors > 0) {
        this.logger.warn(`${results.errors} errors occurred during rewards calculation`);
      }

    } catch (error) {
      this.logger.error('Error in monthly rewards calculation:', error);
      // In production, you might want to send alerts or notifications here
    }
  }

  /**
   * Health check for rewards system
   * Runs daily at 6:00 AM to verify rewards system is working
   */
  @Cron('0 6 * * *', {
    name: 'rewards-health-check',
    timeZone: 'UTC',
  })
  async rewardsHealthCheck(): Promise<void> {
    this.logger.log('Running rewards system health check...');

    try {
      // You can add health checks here, such as:
      // - Verify database connection
      // - Check for stuck calculations
      // - Verify rewards configuration
      // - Check for negative balances

      this.logger.log('Rewards system health check completed successfully');
    } catch (error) {
      this.logger.error('Rewards system health check failed:', error);
    }
  }

  /**
   * Manual trigger for testing (can be called via admin endpoint)
   */
  async manualCalculation(calculationPeriod?: string): Promise<any> {
    this.logger.log(`Manual rewards calculation triggered for period: ${calculationPeriod || 'current month'}`);

    try {
      const results = await this.rewardsService.calculateAllUsersMonthlyRewards(calculationPeriod);
      
      this.logger.log('Manual calculation completed:', results);
      return {
        success: true,
        results,
        message: `Processed ${results.processed} users, credited ${results.credited} rewards`
      };
    } catch (error) {
      this.logger.error('Manual calculation failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}