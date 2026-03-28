import { Module } from '@nestjs/common';
import { VideoProcessingController } from './video-processing.controller';
import { VideoProcessingService } from '../services/videoProcessingService';
import { BackgroundVideoProcessor } from '../services/backgroundVideoProcessor';

@Module({
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
export class VideoProcessingModule {}
