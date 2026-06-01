import { videoProcessingService } from './videoProcessingService';
import { StorageClient } from '@supabase/storage-js';
import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { EventEmitter } from 'events';

export interface VideoProcessingJob {
  id: string;
  videoUrl: string;
  userId: string;
  entityType?: 'service' | 'product' | 'post_media' | 'chat';
  entityId?: string;
  postId?: string;
  videoIndex?: number;
  platform?: 'android' | 'ios' | 'web';
  priority: 'low' | 'medium' | 'high';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  result?: {
    processedVideoUrl: string;
    metadata: any;
  };
}

export class BackgroundVideoProcessor {
  static eventEmitter = new EventEmitter();
  private processingQueue: Map<string, VideoProcessingJob> = new Map();
  private activeWorkers: Map<string, Worker> = new Map();
  private maxConcurrentJobs = 3;
  private storageClient: StorageClient;
  private supabase: any;

  constructor() {
    this.storageClient = new StorageClient(
      process.env.SUPABASE_URL + '/storage/v1',
      {
        apikey: process.env.SUPABASE_KEY || '',
      }
    );
    
    // Initialize Supabase client for database operations
    this.supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
    );
    
    // Start processing loop
    this.startProcessingLoop();
  }

  /**
   * Add video to processing queue
   */
  async addVideoToQueue(videoUrl: string, userId: string, options: {
    entityType?: 'service' | 'product' | 'post_media' | 'chat';
    entityId?: string;
    postId?: string;
    videoIndex?: number;
    platform?: 'android' | 'ios' | 'web';
    priority?: 'low' | 'medium' | 'high';
  } = {}): Promise<string> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    const job: VideoProcessingJob = {
      id: jobId,
      videoUrl,
      userId,
      entityType: options.entityType,
      entityId: options.entityId,
      postId: options.postId,
      videoIndex: options.videoIndex ?? 0,
      platform: options.platform || 'android',
      priority: options.priority || 'medium',
      status: 'pending',
      createdAt: new Date()
    };

    this.processingQueue.set(jobId, job);
    console.log(`📋 Video added to processing queue: ${jobId}`);
    
    // Trigger processing immediately
    this.processQueue();
    
    return jobId;
  }

  /**
   * Get job status
   */
  getJobStatus(jobId: string): VideoProcessingJob | null {
    return this.processingQueue.get(jobId) || null;
  }

  /**
   * Get all jobs for a user
   */
  getUserJobs(userId: string): VideoProcessingJob[] {
    return Array.from(this.processingQueue.values())
      .filter(job => job.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Start processing loop
   */
  private startProcessingLoop(): void {
    setInterval(() => {
      this.processQueue();
    }, 5000); // Check every 5 seconds
  }

  /**
   * Process queue
   */
  private async processQueue(): Promise<void> {
    // Count active jobs
    const activeJobs = Array.from(this.processingQueue.values())
      .filter(job => job.status === 'processing');
    
    if (activeJobs.length >= this.maxConcurrentJobs) {
      return; // Max concurrent jobs reached
    }

    // Get next pending jobs
    const pendingJobs = Array.from(this.processingQueue.values())
      .filter(job => job.status === 'pending')
      .sort((a, b) => {
        // Priority order: high > medium > low
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
        if (priorityDiff !== 0) return priorityDiff;
        
        // If same priority, process older jobs first
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    // Process jobs up to max concurrent
    const jobsToProcess = pendingJobs.slice(0, this.maxConcurrentJobs - activeJobs.length);
    
    for (const job of jobsToProcess) {
      this.processJob(job);
    }
  }

  /**
   * Process individual job
   */
  private async processJob(job: VideoProcessingJob): Promise<void> {
    try {
      // Update job status
      job.status = 'processing';
      job.startedAt = new Date();
      this.processingQueue.set(job.id, job);

      console.log(`🔄 Starting video processing: ${job.id}`);

      // Download video
      const inputPath = await this.downloadVideo(job.videoUrl);
      
      // Process video
      const result = await videoProcessingService.processVideo({
        inputPath,
        platform: job.platform,
        quality: 'medium'
      });

      // Update job with result
      if (result.success) {
        job.status = 'completed';
        job.completedAt = new Date();
        job.result = {
          processedVideoUrl: result.outputPath!,
          metadata: result.metadata,
          // Keep thumbnailUrl on the job for debugging/inspection
          // (primary persistence happens in updateEntityVideo)
          // @ts-ignore - extend result typing for runtime value
          thumbnailUrl: (result as any).thumbnailUrl,
        };
        
        console.log(`✅ Video processing completed: ${job.id}`);
        
        // Update the correct entity with processed video URL
        if (job.entityId && job.entityType) {
          await this.updateEntityVideo(
            job.entityType,
            job.entityId,
            job.videoIndex ?? 0,
            result.outputPath!,
            job.postId,
            // Pass through thumbnailUrl if generated
            (result as any).thumbnailUrl,
          );
        }
        
        // Notify user (optional)
        await this.notifyUser(job.userId, {
          type: 'video_processing_completed',
          jobId: job.id,
          entityType: job.entityType,
          entityId: job.entityId
        });
        
      } else {
        job.status = 'failed';
        job.error = result.error;
        console.error(`❌ Video processing failed: ${job.id}`, result.error);
      }

      // Clean up temporary files
      if (inputPath && fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
      }

      this.processingQueue.set(job.id, job);
      
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.completedAt = new Date();
      
      console.error(`💥 Video processing error: ${job.id}`, error);
      this.processingQueue.set(job.id, job);
    }
  }

  /**
   * Download video from URL
   */
  private async downloadVideo(url: string): Promise<string> {
    const https = require('https');
    const fs = require('fs');
    const path = require('path');
    
    return new Promise((resolve, reject) => {
      const fileName = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.mp4`;
      const filePath = path.join('/tmp', fileName);
      
      const file = fs.createWriteStream(filePath);
      
      https.get(url, (response: any) => {
        response.pipe(file);
      }).on('error', reject).on('end', () => {
        file.close();
        resolve(filePath);
      });
    });
  }

  /**
   * Update the correct entity table with the processed video URL
   */
  private async updateEntityVideo(
    entityType: string,
    entityId: string,
    videoIndex: number,
    processedVideoUrl: string,
    postId?: string,
    thumbnailUrl?: string,
  ): Promise<void> {
    try {
      const now = new Date().toISOString();

      if (entityType === 'service') {
        // Update services.processed_videos, video_processing_status, and optionally thumbnails
        const { data: service } = await this.supabase
          .from('services')
          .select('processed_videos, video_processing_status, images, primary_media_url')
          .eq('id', entityId)
          .single();

        const processedVideos = service?.processed_videos || [];
        processedVideos[videoIndex] = processedVideoUrl;

        const statusMap = service?.video_processing_status || {};
        statusMap[videoIndex.toString()] = {
          status: 'completed',
          processedUrl: processedVideoUrl,
          processedAt: now,
        };

        // If no images exist yet and we have a generated thumbnail, use it as primary image
        const existingImages: string[] = service?.images || [];
        let updatedImages = existingImages;
        let primaryMediaUrl = service?.primary_media_url || null;

        if (thumbnailUrl && existingImages.length === 0) {
          updatedImages = [thumbnailUrl];
          primaryMediaUrl = primaryMediaUrl || thumbnailUrl;
        }

        const { error } = await this.supabase
          .from('services')
          .update({
            processed_videos: processedVideos,
            video_processing_status: statusMap,
            images: updatedImages,
            primary_media_url: primaryMediaUrl,
          })
          .eq('id', entityId);

        if (error) throw error;
        console.log(`✅ Updated service ${entityId} processed video[${videoIndex}]`);

      } else if (entityType === 'product') {
        const { data: product } = await this.supabase
          .from('products')
          .select('processed_videos, video_processing_status, images, primary_image_url')
          .eq('id', entityId)
          .single();

        const processedVideos = product?.processed_videos || [];
        processedVideos[videoIndex] = processedVideoUrl;

        const statusMap = product?.video_processing_status || {};
        statusMap[videoIndex.toString()] = {
          status: 'completed',
          processedUrl: processedVideoUrl,
          processedAt: now,
        };

        const existingImages: string[] = product?.images || [];
        let updatedImages = existingImages;
        let primaryImageUrl = product?.primary_image_url || null;

        if (thumbnailUrl && existingImages.length === 0) {
          updatedImages = [thumbnailUrl];
          primaryImageUrl = primaryImageUrl || thumbnailUrl;
        }

        const { error } = await this.supabase
          .from('products')
          .update({
            processed_videos: processedVideos,
            video_processing_status: statusMap,
            images: updatedImages,
            primary_image_url: primaryImageUrl,
          })
          .eq('id', entityId);

        if (error) throw error;
        console.log(`✅ Updated product ${entityId} processed video[${videoIndex}]`);

      } else if (entityType === 'post_media') {
        // post_media uses a single row per media item
        const { data: existingMedia } = await this.supabase
          .from('post_media')
          .select('thumbnail_url')
          .eq('id', entityId)
          .single();

        const updatePayload: any = {
          processed_url: processedVideoUrl,
          processing_status: 'completed',
        };

        // Only set thumbnail_url if none exists and we have a generated thumbnail
        if (thumbnailUrl && !existingMedia?.thumbnail_url) {
          updatePayload.thumbnail_url = thumbnailUrl;
        }

        const { error } = await this.supabase
          .from('post_media')
          .update(updatePayload)
          .eq('id', entityId);

        if (error) throw error;
        console.log(`✅ Updated post_media ${entityId} processed_url`);

        // Also sync into parent posts.processed_media_urls if postId is known
        if (postId) {
          const { data: post } = await this.supabase
            .from('posts')
            .select('processed_media_urls, media_urls')
            .eq('id', postId)
            .single();

          if (post?.media_urls) {
            const processedMediaUrls = post.processed_media_urls || [];
            const mediaIndex = post.media_urls.indexOf(processedVideoUrl);
            if (mediaIndex === -1) {
              // Try to find by entityId via post_media (safer)
              const { data: pm } = await this.supabase
                .from('post_media')
                .select('media_url, order_index')
                .eq('id', entityId)
                .single();
              if (pm?.order_index !== undefined) {
                processedMediaUrls[pm.order_index] = processedVideoUrl;
              }
            } else {
              processedMediaUrls[mediaIndex] = processedVideoUrl;
            }

            await this.supabase
              .from('posts')
              .update({ processed_media_urls: processedMediaUrls })
              .eq('id', postId);
            console.log(`✅ Updated post ${postId} processed_media_urls`);
          }
        }

      } else if (entityType === 'chat') {
        // Legacy chat file upload support
        const { error } = await this.supabase
          .from('chat_file_uploads')
          .update({
            public_url: processedVideoUrl,
            metadata: {
              videoProcessing: {
                processing: false,
                processed: true,
                processedVideoUrl,
                processedAt: now,
              },
            },
          })
          .eq('message_id', entityId)
          .eq('file_type', 'video');

        if (error) throw error;
        console.log(`✅ Updated chat file upload ${entityId}`);
      }
    } catch (error) {
      console.error(`Failed to update ${entityType} video:`, error);
    }
  }

  /**
   * Notify user about processing status
   */
  private async notifyUser(userId: string, notification: {
    type: string;
    jobId: string;
    entityType?: string;
    entityId?: string;
    postId?: string;
  }): Promise<void> {
    try {
      console.log(`📱 Notifying user ${userId} about ${notification.type} for job ${notification.jobId}`);
      BackgroundVideoProcessor.eventEmitter.emit('video_processing_completed', {
        userId,
        ...notification,
      });
    } catch (error) {
      console.error('Failed to notify user:', error);
    }
  }

  /**
   * Clean up old completed jobs
   */
  cleanupOldJobs(maxAge: number = 24 * 60 * 60 * 1000): void { // 24 hours
    const cutoffTime = Date.now() - maxAge;
    
    for (const [jobId, job] of this.processingQueue.entries()) {
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        job.createdAt.getTime() < cutoffTime
      ) {
        this.processingQueue.delete(jobId);
        console.log(`🗑️ Cleaned up old job: ${jobId}`);
      }
    }
  }

  /**
   * Get processing statistics
   */
  getStats(): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    activeWorkers: number;
  } {
    const jobs = Array.from(this.processingQueue.values());
    
    return {
      total: jobs.length,
      pending: jobs.filter(j => j.status === 'pending').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      activeWorkers: this.activeWorkers.size
    };
  }
}

export const backgroundVideoProcessor = new BackgroundVideoProcessor();
