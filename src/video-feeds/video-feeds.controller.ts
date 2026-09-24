import { Controller, Get, Post, Put, Body } from '@nestjs/common';
import { VideoFeedsService } from './video-feeds.service';
import { VideoFeedsScheduler } from './video-feeds.scheduler';

@Controller('admin/video-feeds')
export class VideoFeedsController {
  constructor(
    private readonly videoFeedsService: VideoFeedsService,
    private readonly videoFeedsScheduler: VideoFeedsScheduler,
  ) {}

  @Get('config')
  getConfig() {
    return { success: true, config: this.videoFeedsService.getConfig() };
  }

  @Get('personas')
  getPersonas() {
    return { success: true, personas: this.videoFeedsService.getPersonas() };
  }

  @Get('status')
  getStatus() {
    return { success: true, status: this.videoFeedsScheduler.getStatus() };
  }

  @Post('post-now')
  async postNow() {
    return await this.videoFeedsScheduler.manualPostOnce();
  }

  @Put('settings')
  async updateSettings(@Body() settings: any) {
    try {
      await this.videoFeedsService.updateSettings(settings);
      return { success: true, message: 'Settings updated' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}
