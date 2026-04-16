import { Request, Response } from 'express';
import { videoProcessingService } from '../services/videoProcessingService';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { ConfigService } from '@nestjs/config';

export class VideoProcessingController {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(configService);
  }

  /**
   * Submit a video for processing
   */
  async submitVideoForProcessing(req: Request, res: Response) {
    try {
      const { 
        original_file_path, 
        original_filename, 
        file_size, 
        mime_type,
        quality = 'medium',
        platform = 'android',
        generate_thumbnail = true,
        generate_hls = false,
        max_duration
      } = req.body;

      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Validate input
      if (!original_file_path || !original_filename || !file_size || !mime_type) {
        return res.status(400).json({ 
          error: 'Missing required fields: original_file_path, original_filename, file_size, mime_type' 
        });
      }

      // Validate file type
      const allowedTypes = [
        'video/mp4', 'video/quicktime', 'video/x-msvideo', 
        'video/x-matroska', 'video/webm', 'video/hevc'
      ];
      
      if (!allowedTypes.includes(mime_type)) {
        return res.status(400).json({ 
          error: 'Invalid file type. Only video files are allowed.' 
        });
      }

      // Validate file size (500MB limit)
      const maxSize = 500 * 1024 * 1024; // 500MB
      if (file_size > maxSize) {
        return res.status(400).json({ 
          error: 'File too large. Maximum size is 500MB.' 
        });
      }

      // Insert into processing queue
      const { data: job, error } = await this.supabase
        .from('video_processing_queue')
        .insert({
          user_id: userId,
          original_file_path,
          original_filename,
          file_size,
          mime_type,
          quality,
          platform,
          generate_thumbnail,
          generate_hls,
          max_duration,
          status: 'pending',
          progress: 0
        })
        .select()
        .single();

      if (error) {
        console.error('Failed to create processing job:', error);
        return res.status(500).json({ error: 'Failed to create processing job' });
      }

      console.log('🎬 Video processing job created:', job.id);
      
      res.status(201).json({
        success: true,
        job_id: job.id,
        status: 'pending',
        message: 'Video submitted for processing'
      });

    } catch (error) {
      console.error('Submit video processing error:', error);
      res.status(500).json({ 
        error: 'Internal server error' 
      });
    }
  }

  /**
   * Get processing status for a video
   */
  async getProcessingStatus(req: Request, res: Response) {
    try {
      const { job_id } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { data: job, error } = await this.supabase
        .from('video_processing_queue')
        .select('*')
        .eq('id', job_id)
        .eq('user_id', userId)
        .single();

      if (error || !job) {
        return res.status(404).json({ error: 'Processing job not found' });
      }

      res.json({
        success: true,
        job: {
          id: job.id,
          status: job.status,
          progress: job.progress,
          current_stage: job.current_stage,
          quality: job.quality,
          platform: job.platform,
          original_filename: job.original_filename,
          created_at: job.created_at,
          started_at: job.started_at,
          completed_at: job.completed_at,
          retry_count: job.retry_count,
          error_message: job.error_message,
          processed_url: job.processed_url,
          thumbnail_url: job.thumbnail_url,
          hls_master_playlist_url: job.hls_master_playlist_url,
          hls_variants: job.hls_variants
        }
      });

    } catch (error) {
      console.error('Get processing status error:', error);
      res.status(500).json({ 
        error: 'Internal server error' 
      });
    }
  }

  /**
   * Get all processing jobs for the current user
   */
  async getUserProcessingJobs(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      const { status, limit = 20, offset = 0 } = req.query;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      let query = this.supabase
        .from('video_processing_queue')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1);

      if (status) {
        query = query.eq('status', status);
      }

      const { data: jobs, error } = await query;

      if (error) {
        console.error('Failed to fetch processing jobs:', error);
        return res.status(500).json({ error: 'Failed to fetch processing jobs' });
      }

      res.json({
        success: true,
        jobs: jobs.map(job => ({
          id: job.id,
          status: job.status,
          progress: job.progress,
          current_stage: job.current_stage,
          quality: job.quality,
          platform: job.platform,
          original_filename: job.original_filename,
          file_size: job.file_size,
          created_at: job.created_at,
          started_at: job.started_at,
          completed_at: job.completed_at,
          retry_count: job.retry_count,
          error_message: job.error_message,
          processed_url: job.processed_url,
          thumbnail_url: job.thumbnail_url
        }))
      });

    } catch (error) {
      console.error('Get user processing jobs error:', error);
      res.status(500).json({ 
        error: 'Internal server error' 
      });
    }
  }

  /**
   * Cancel a processing job
   */
  async cancelProcessingJob(req: Request, res: Response) {
    try {
      const { job_id } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { data: job, error } = await this.supabase
        .from('video_processing_queue')
        .select('status')
        .eq('id', job_id)
        .eq('user_id', userId)
        .single();

      if (error || !job) {
        return res.status(404).json({ error: 'Processing job not found' });
      }

      // Only allow cancellation of pending or retrying jobs
      if (!['pending', 'retrying'].includes(job.status)) {
        return res.status(400).json({ 
          error: 'Cannot cancel job that is already processing or completed' 
        });
      }

      const { error: updateError } = await this.supabase
        .from('video_processing_queue')
        .update({ 
          status: 'failed',
          error_message: 'Cancelled by user',
          updated_at: new Date().toISOString()
        })
        .eq('id', job_id)
        .eq('user_id', userId);

      if (updateError) {
        console.error('Failed to cancel job:', updateError);
        return res.status(500).json({ error: 'Failed to cancel job' });
      }

      console.log('🚫 Video processing job cancelled:', job_id);
      
      res.json({
        success: true,
        message: 'Processing job cancelled successfully'
      });

    } catch (error) {
      console.error('Cancel processing job error:', error);
      res.status(500).json({ 
        error: 'Internal server error' 
      });
    }
  }

  /**
   * Retry a failed processing job
   */
  async retryProcessingJob(req: Request, res: Response) {
    try {
      const { job_id } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { data: job, error } = await this.supabase
        .from('video_processing_queue')
        .select('status, retry_count, max_retries')
        .eq('id', job_id)
        .eq('user_id', userId)
        .single();

      if (error || !job) {
        return res.status(404).json({ error: 'Processing job not found' });
      }

      // Only allow retry of failed jobs that haven't exceeded max retries
      if (job.status !== 'failed' || job.retry_count >= job.max_retries) {
        return res.status(400).json({ 
          error: 'Cannot retry job. Either not failed or max retries exceeded' 
        });
      }

      const { error: updateError } = await this.supabase
        .from('video_processing_queue')
        .update({ 
          status: 'pending',
          error_message: null,
          error_details: null,
          next_retry_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', job_id)
        .eq('user_id', userId);

      if (updateError) {
        console.error('Failed to retry job:', updateError);
        return res.status(500).json({ error: 'Failed to retry job' });
      }

      console.log('🔄 Video processing job queued for retry:', job_id);
      
      res.json({
        success: true,
        message: 'Processing job queued for retry'
      });

    } catch (error) {
      console.error('Retry processing job error:', error);
      res.status(500).json({ 
        error: 'Internal server error' 
      });
    }
  }
}

export const videoProcessingController = new VideoProcessingController(new ConfigService());
