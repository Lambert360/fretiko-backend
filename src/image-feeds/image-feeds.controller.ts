import { Controller, Get, Post, Put, Body } from '@nestjs/common';
import { ImageFeedsService } from './image-feeds.service';
import { ImageFeedsScheduler } from './image-feeds.scheduler';

@Controller('admin/image-feeds')
export class ImageFeedsController {
  constructor(
    private readonly imageFeedsService: ImageFeedsService,
    private readonly imageFeedsScheduler: ImageFeedsScheduler,
  ) {}

  @Get('config')
  getConfig() {
    return { success: true, config: this.imageFeedsService.getConfig() };
  }

  @Get('personas')
  getPersonas() {
    return { success: true, personas: this.imageFeedsService.getPersonas() };
  }

  @Get('status')
  getStatus() {
    return { success: true, status: this.imageFeedsScheduler.getStatus() };
  }

  @Post('post-now')
  async postNow() {
    return await this.imageFeedsScheduler.manualPostOnce();
  }

  @Put('settings')
  async updateSettings(@Body() settings: any) {
    try {
      await this.imageFeedsService.updateSettings(settings);
      return { success: true, message: 'Settings updated' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}
