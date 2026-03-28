import { Controller, Post, Get, Body, Param, UseGuards, Request } from '@nestjs/common';
import { VideoProcessingService } from '../services/videoProcessingService';
import { BackgroundVideoProcessor } from '../services/backgroundVideoProcessor';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('api/video-processing')
@UseGuards(JwtAuthGuard)
export class VideoProcessingController {
  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    private readonly backgroundVideoProcessor: BackgroundVideoProcessor,
  ) {}

  // Process single video for compatibility
  @Post('process-video')
  async processVideo(@Body() body: { videoUrl: string; platform?: string; quality?: string }, @Request() req) {
    try {
      const { videoUrl, platform = 'android', quality = 'medium' } = body;

      if (!videoUrl) {
        return { 
          success: false, 
          error: 'Video URL is required' 
        };
      }

      // Download video from URL
      const inputPath = await this.downloadVideo(videoUrl);
      
      // Process video for compatibility
      const result = await this.videoProcessingService.processVideo({
        inputPath,
        platform: platform as 'android' | 'ios' | 'web' | undefined,
        quality: quality as 'low' | 'medium' | 'high' | undefined
      });

      if (result.success) {
        return {
          success: true,
          processedVideoUrl: result.outputPath,
          metadata: result.metadata,
          message: 'Video processed successfully for cross-platform compatibility'
        };
      } else {
        return {
          success: false,
          error: result.error
        };
      }

    } catch (error) {
      console.error('Video processing error:', error);
      return {
        success: false,
        error: 'Internal server error during video processing'
      };
    }
  }

  // Add video to background processing queue
  @Post('queue-video')
  async queueVideo(@Body() body: { videoUrl: string; platform?: string; priority?: string }, @Request() req) {
    try {
      const { videoUrl, platform = 'android', priority = 'medium' } = body;
      const userId = req.user?.sub;

      if (!videoUrl) {
        return { 
          success: false, 
          error: 'Video URL is required' 
        };
      }

      // Add to processing queue
      const jobId = await this.backgroundVideoProcessor.addVideoToQueue(videoUrl, userId, {
        platform: platform as 'android' | 'ios' | 'web' | undefined,
        priority: priority as 'low' | 'medium' | 'high' | undefined
      });

      return {
        success: true,
        jobId,
        message: 'Video added to processing queue'
      };

    } catch (error) {
      console.error('Queue video error:', error);
      return {
        success: false,
        error: 'Failed to add video to processing queue'
      };
    }
  }

  // Get job status
  @Get('job-status/:jobId')
  async getJobStatus(@Param('jobId') jobId: string, @Request() req) {
    try {
      const userId = req.user.id;

      const job = this.backgroundVideoProcessor.getJobStatus(jobId);
      
      if (!job) {
        return {
          success: false,
          error: 'Job not found'
        };
      }

      // Ensure user can only see their own jobs
      if (job.userId !== userId) {
        return {
          success: false,
          error: 'Access denied'
        };
      }

      return {
        success: true,
        job: {
          id: job.id,
          status: job.status,
          priority: job.priority,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          error: job.error,
          result: job.result
        }
      };

    } catch (error) {
      console.error('Get job status error:', error);
      return {
        success: false,
        error: 'Failed to get job status'
      };
    }
  }

  // Get user's processing jobs
  @Get('my-jobs')
  async getUserJobs(@Request() req) {
    try {
      const userId = req.user.id;
      const jobs = this.backgroundVideoProcessor.getUserJobs(userId);

      return {
        success: true,
        jobs: jobs.map(job => ({
          id: job.id,
          status: job.status,
          priority: job.priority,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          error: job.error,
          result: job.result
        }))
      };

    } catch (error) {
      console.error('Get user jobs error:', error);
      return {
        success: false,
        error: 'Failed to get user jobs'
      };
    }
  }

  // Get processing statistics (admin only)
  @Get('stats')
  async getStats(@Request() req) {
    try {
      // Check if user is admin
      if (!req.user.isAdmin) {
        return {
          success: false,
          error: 'Admin access required'
        };
      }

      const stats = this.backgroundVideoProcessor.getStats();
      
      return {
        success: true,
        stats
      };

    } catch (error) {
      console.error('Get stats error:', error);
      return {
        success: false,
        error: 'Failed to get processing statistics'
      };
    }
  }

  // Helper method to download video
  private async downloadVideo(url: string): Promise<string> {
    const https = require('https');
    const fs = require('fs');
    const path = require('path');
    
    return new Promise((resolve, reject) => {
      const fileName = `temp_${Date.now()}.mp4`;
      const filePath = path.join('/tmp', fileName);
      
      const file = fs.createWriteStream(filePath);
      
      https.get(url, (response) => {
        response.pipe(file);
      }).on('error', reject).on('end', () => {
        file.close();
        resolve(filePath);
      });
    });
  }
}
