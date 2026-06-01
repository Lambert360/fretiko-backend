import { Module, OnModuleInit } from '@nestjs/common';
import { VideoProcessingController } from './video-processing.controller';
import { VideoProcessingService } from '../services/videoProcessingService';
import { BackgroundVideoProcessor } from '../services/backgroundVideoProcessor';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [VideoProcessingController],
  providers: [
    VideoProcessingService,
    BackgroundVideoProcessor,
  ],
  exports: [
    VideoProcessingService,
    BackgroundVideoProcessor,
  ],
})
export class VideoProcessingModule implements OnModuleInit {
  async onModuleInit() {
    await VideoProcessingService.checkFfmpegAvailability();
  }
}
