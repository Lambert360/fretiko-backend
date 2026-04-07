import { Controller, Get } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Controller('health')
export class HealthController {
  @Get()
  async getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'fretiko-backend'
    };
  }

  @Get('ffmpeg')
  async getFFmpegStatus() {
    try {
      const { stdout } = await execAsync('ffmpeg -version');
      const version = stdout.split('\n')[0];
      
      return {
        status: 'available',
        version,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'not_available',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }

  @Get('video-processing')
  async getVideoProcessingStatus() {
    try {
      // Test FFmpeg availability
      const { stdout: ffmpegVersion } = await execAsync('ffmpeg -version');
      
      // Test ffprobe availability  
      const { stdout: ffprobeVersion } = await execAsync('ffprobe -version');
      
      return {
        status: 'ready',
        ffmpeg: ffmpegVersion.split('\n')[0],
        ffprobe: ffprobeVersion.split('\n')[0],
        features: {
          h264_encoding: true,
          hevc_decoding: true,
          thumbnail_generation: true,
          hls_generation: true
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'not_ready',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }
}
