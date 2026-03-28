import { videoProcessingService } from './videoProcessingService';
import { StorageClient } from '@supabase/storage-js';
import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';

export interface VideoProcessingJob {
  id: string;
  videoUrl: string;
  userId: string;
  serviceId?: string;
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
  private processingQueue: Map<string, VideoProcessingJob> = new Map();
  private activeWorkers: Map<string, Worker> = new Map();
  private maxConcurrentJobs = 3;
  private storageClient: StorageClient;

  constructor() {
    this.storageClient = new StorageClient(
      process.env.SUPABASE_URL + '/storage/v1',
      {
        apikey: process.env.SUPABASE_ANON_KEY || '',
      }
    );
    
    // Start processing loop
    this.startProcessingLoop();
  }

  /**
   * Add video to processing queue
   */
  async addVideoToQueue(videoUrl: string, userId: string, options: {
    serviceId?: string;
    platform?: 'android' | 'ios' | 'web';
    priority?: 'low' | 'medium' | 'high';
  } = {}): Promise<string> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    const job: VideoProcessingJob = {
      id: jobId,
      videoUrl,
      userId,
      serviceId: options.serviceId,
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
          metadata: result.metadata
        };
        
        console.log(`✅ Video processing completed: ${job.id}`);
        
        // Update service with processed video URL
        if (job.serviceId) {
          await this.updateServiceVideo(job.serviceId, result.outputPath!);
        }
        
        // Notify user (optional)
        await this.notifyUser(job.userId, {
          type: 'video_processing_completed',
          jobId: job.id,
          serviceId: job.serviceId
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
   * Update service with processed video URL
   */
  private async updateServiceVideo(serviceId: string, processedVideoUrl: string): Promise<void> {
    try {
      // This would update the service in your database
      // Implementation depends on your database structure
      console.log(`📝 Updated service ${serviceId} with processed video: ${processedVideoUrl}`);
      
      // Example: await this.db.services.update(serviceId, { 
      //   processedVideoUrl,
      //   videoProcessed: true,
      //   videoProcessedAt: new Date()
      // });
      
    } catch (error) {
      console.error('Failed to update service video:', error);
    }
  }

  /**
   * Notify user about processing status
   */
  private async notifyUser(userId: string, notification: {
    type: string;
    jobId: string;
    serviceId?: string;
  }): Promise<void> {
    try {
      // This would send a push notification or update user's notifications
      console.log(`📱 Notifying user ${userId} about ${notification.type} for job ${notification.jobId}`);
      
      // Example: await this.notificationService.send(userId, {
      //   title: 'Video Processing Complete',
      //   body: 'Your video has been optimized for better playback',
      //   data: notification
      // });
      
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
