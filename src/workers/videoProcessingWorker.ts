import { videoProcessingService } from '../services/videoProcessingService';
import { supabase } from '../lib/supabase';

export class VideoProcessingWorker {
  private isRunning = false;
  private pollInterval = 5000; // 5 seconds
  private maxConcurrentJobs = 2;
  private currentJobs = 0;

  /**
   * Start the video processing worker
   */
  async start() {
    if (this.isRunning) {
      console.log('🔄 Video processing worker is already running');
      return;
    }

    console.log('🚀 Starting video processing worker...');
    this.isRunning = true;

    // Start the processing loop
    this.processLoop();
  }

  /**
   * Stop the video processing worker
   */
  async stop() {
    console.log('🛑 Stopping video processing worker...');
    this.isRunning = false;
  }

  /**
   * Main processing loop
   */
  private async processLoop() {
    while (this.isRunning) {
      try {
        // Check if we can process more jobs
        if (this.currentJobs < this.maxConcurrentJobs) {
          await this.processNextJob();
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, this.pollInterval));
      } catch (error) {
        console.error('❌ Error in processing loop:', error);
        // Wait a bit longer on error
        await new Promise(resolve => setTimeout(resolve, this.pollInterval * 2));
      }
    }

    console.log('📋 Video processing worker stopped');
  }

  /**
   * Process the next available job
   */
  private async processNextJob() {
    try {
      // Get next job from queue
      const { data: jobs, error } = await supabase
        .rpc('get_next_video_processing_job');

      if (error) {
        console.error('❌ Failed to get next job:', error);
        return;
      }

      // No jobs available
      if (!jobs || jobs.length === 0) {
        return;
      }

      const job = jobs[0];
      console.log(`🎬 Processing video job: ${job.id} (${job.original_filename})`);
      
      this.currentJobs++;

      // Process job in background
      this.processJob(job).finally(() => {
        this.currentJobs--;
      });

    } catch (error) {
      console.error('❌ Error getting next job:', error);
    }
  }

  /**
   * Process a single video job
   */
  private async processJob(job: any) {
    const jobId = job.id;
    
    try {
      // Update progress: Starting
      await this.updateProgress(jobId, 10, 'Reading file metadata');

      // Get video metadata
      const metadata = await videoProcessingService.getVideoMetadata(job.original_file_path);
      
      if (!metadata) {
        throw new Error('Failed to read video metadata');
      }

      // Update progress: Converting
      await this.updateProgress(jobId, 20, 'Converting video to H.264');

      // Process video with H.264 conversion (fixes H.265 issues)
      const result = await videoProcessingService.processVideo({
        inputPath: job.original_file_path,
        quality: job.quality,
        platform: job.platform,
        generateThumbnail: job.generate_thumbnail,
        generateHLS: job.generate_hls,
        maxDuration: job.max_duration
      });

      if (!result.success) {
        throw new Error(result.error || 'Video processing failed');
      }

      // Update progress: Uploading
      await this.updateProgress(jobId, 80, 'Uploading processed video');

      // Mark job as completed
      const { error: completeError } = await supabase
        .rpc('complete_video_processing_job', {
          job_id: jobId,
          processed_url: result.outputPath,
          thumbnail_url: result.thumbnailUrl,
          hls_master_playlist_url: result.hlsUrls?.masterPlaylist,
          hls_variants: result.hlsUrls?.variants || {},
          processed_codec: result.metadata?.codec,
          processed_resolution: result.metadata?.resolution,
          processed_bitrate: result.metadata?.bitrate,
          processed_duration: result.metadata?.duration
        });

      if (completeError) {
        console.error('❌ Failed to complete job:', completeError);
        throw new Error('Failed to mark job as completed');
      }

      // Update progress: Complete
      await this.updateProgress(jobId, 100, 'Completed');

      console.log(`✅ Video processing completed: ${jobId}`);

    } catch (error) {
      console.error(`❌ Video processing failed for job ${jobId}:`, error);
      
      // Mark job as failed
      const { error: failError } = await supabase
        .rpc('fail_video_processing_job', {
          job_id: jobId,
          error_message: error instanceof Error ? error.message : 'Unknown error',
          error_details: {
            timestamp: new Date().toISOString(),
            stack: error instanceof Error ? error.stack : undefined
          },
          current_stage: 'Processing failed',
          progress: null
        });

      if (failError) {
        console.error('❌ Failed to mark job as failed:', failError);
      }
    }
  }

  /**
   * Update job progress
   */
  private async updateProgress(jobId: string, progress: number, stage: string) {
    try {
      const { error } = await supabase
        .rpc('update_video_processing_progress', {
          job_id: jobId,
          progress,
          current_stage: stage
        });

      if (error) {
        console.error(`❌ Failed to update progress for job ${jobId}:`, error);
      } else {
        console.log(`📊 Job ${jobId}: ${progress}% - ${stage}`);
      }
    } catch (error) {
      console.error(`❌ Error updating progress for job ${jobId}:`, error);
    }
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      currentJobs: this.currentJobs,
      maxConcurrentJobs: this.maxConcurrentJobs,
      pollInterval: this.pollInterval
    };
  }

  /**
   * Configure worker settings
   */
  configure(settings: {
    pollInterval?: number;
    maxConcurrentJobs?: number;
  }) {
    if (settings.pollInterval) {
      this.pollInterval = settings.pollInterval;
    }
    
    if (settings.maxConcurrentJobs) {
      this.maxConcurrentJobs = settings.maxConcurrentJobs;
    }
    
    console.log('⚙️ Video processing worker configured:', {
      pollInterval: this.pollInterval,
      maxConcurrentJobs: this.maxConcurrentJobs
    });
  }
}

// Create singleton instance
export const videoProcessingWorker = new VideoProcessingWorker();
