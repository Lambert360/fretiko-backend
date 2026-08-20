import { Controller, Get, Post } from '@nestjs/common';
import { EngagementBotsService } from './engagement-bots.service';
import { EngagementBotsScheduler } from './engagement-bots.scheduler';

@Controller('admin/engagement-bots')
export class EngagementBotsController {
  constructor(
    private readonly engagementBotsService: EngagementBotsService,
    private readonly engagementBotsScheduler: EngagementBotsScheduler,
  ) {}

  @Get('personas')
  getPersonas() {
    return { success: true, count: this.engagementBotsService.getEngagementPersonas().length };
  }

  @Get('status')
  getStatus() {
    return { success: true, status: this.engagementBotsScheduler.getStatus() };
  }

  @Post('engage-now')
  async engageNow() {
    return await this.engagementBotsScheduler.manualEngageNow();
  }
}
