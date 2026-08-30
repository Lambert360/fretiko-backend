import { Controller, Get, Param, Query, Request, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LiveSalesGamificationService } from './live-sales-gamification.service';

@Controller('live-sales/gamification')
@UseGuards(JwtAuthGuard)
export class LiveSalesGamificationController {
  constructor(private readonly gamificationService: LiveSalesGamificationService) {}

  /**
   * GET /live-sales/gamification/config
   * Public event config for mobile apps (watch time, leaderboard status, etc.)
   */
  @Get('config')
  async getPublicConfig() {
    const config = await this.gamificationService.getEventConfig();
    if (!config) return null;

    return {
      watch_rewards_enabled: config.watch_rewards_enabled,
      watch_time_minutes: config.watch_time_minutes,
      freti_per_reward: config.freti_per_reward,
      daily_cap_per_user: config.daily_cap_per_user,
      per_stream_cap_per_user: config.per_stream_cap_per_user,
      notifications_enabled: config.notifications_enabled,
      leaderboard_enabled: config.leaderboard_enabled,
      special_event_enabled: config.special_event_enabled,
      special_event_name: config.special_event_name,
    };
  }

  /**
   * GET /live-sales/gamification/progress/:streamId
   * Current viewer's reward countdown for a stream
   */
  @Get('progress/:streamId')
  async getViewerProgress(
    @Param('streamId') streamId: string,
    @Request() req: any,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    return this.gamificationService.getViewerProgress(streamId, userId);
  }

  /**
   * GET /live-sales/gamification/leaderboard
   * Public vendor leaderboard for a given period
   */
  @Get('leaderboard')
  async getLeaderboard(
    @Query('period') period: 'daily' | 'weekly' | 'monthly' | 'event' = 'weekly',
    @Query('event_name') eventName?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    if (limitNum > 100) {
      throw new BadRequestException('Limit cannot exceed 100');
    }

    return this.gamificationService.getLeaderboard(period, eventName, limitNum);
  }
}
