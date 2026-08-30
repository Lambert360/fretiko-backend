import { Controller, Get, Put, Post, Body, Query, Request, UseGuards, BadRequestException } from '@nestjs/common';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { LiveSalesGamificationService, UpdateEventConfigDto } from '../live-sales/live-sales-gamification.service';

@Controller('admin/live-sales')
@UseGuards(StaffJwtAuthGuard)
export class LiveSalesGamificationAdminController {
  constructor(private readonly gamificationService: LiveSalesGamificationService) {}

  /**
   * GET /admin/live-sales/event-config
   * Get full live sales event configuration
   */
  @Get('event-config')
  async getEventConfig(@Request() req: any) {
    return this.gamificationService.getEventConfig();
  }

  /**
   * PUT /admin/live-sales/event-config
   * Update live sales event configuration
   */
  @Put('event-config')
  async updateEventConfig(
    @Request() req: any,
    @Body() dto: UpdateEventConfigDto,
  ) {
    if (!req.user?.sub) {
      throw new BadRequestException('Staff user not authenticated');
    }

    // Basic validation: weights must sum to 100 if all provided
    if (dto.default_order_weight !== undefined || dto.default_viewer_weight !== undefined || dto.default_revenue_weight !== undefined) {
      const total =
        (dto.default_order_weight ?? 40) +
        (dto.default_viewer_weight ?? 30) +
        (dto.default_revenue_weight ?? 30);
      if (total !== 100) {
        throw new BadRequestException('Default weights must sum to 100');
      }
    }

    if (dto.special_event_order_weight !== undefined || dto.special_event_viewer_weight !== undefined || dto.special_event_revenue_weight !== undefined) {
      const total =
        (dto.special_event_order_weight ?? 40) +
        (dto.special_event_viewer_weight ?? 30) +
        (dto.special_event_revenue_weight ?? 30);
      if (total !== 100) {
        throw new BadRequestException('Special event weights must sum to 100');
      }
    }

    return this.gamificationService.updateEventConfig(req.user.sub, dto);
  }

  /**
   * GET /admin/live-sales/leaderboard
   * Admin view of the cached vendor leaderboard
   */
  @Get('leaderboard')
  async getLeaderboard(
    @Query('period') period: 'daily' | 'weekly' | 'monthly' | 'event' = 'weekly',
    @Query('event_name') eventName?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    return this.gamificationService.getLeaderboard(period, eventName, limitNum);
  }

  /**
   * POST /admin/live-sales/recalculate-leaderboard
   * Force leaderboard recalculation
   */
  @Post('recalculate-leaderboard')
  async recalculateLeaderboard() {
    await this.gamificationService.recalculateLeaderboards();
    return { success: true, message: 'Leaderboard recalculation started' };
  }
}
