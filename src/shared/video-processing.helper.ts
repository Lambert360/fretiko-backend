import { Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { backgroundVideoProcessor } from '../services/backgroundVideoProcessor';

const execAsync = promisify(exec);

export type EntityType = 'service' | 'product' | 'post_media' | 'chat';

export interface VideoProcessingResult {
  needsProcessing: boolean;
  jobId?: string;
  originalCodec?: string;
}

export class VideoProcessingHelper {
  private static readonly logger = new Logger(VideoProcessingHelper.name);

  // Codecs that cannot be played on most Android devices and need H.264 conversion
  private static readonly INCOMPATIBLE_CODECS = ['hevc', 'h265', 'vp9', 'av1', 'dolbyvision', 'dvhe'];

  /**
   * Check a video URL for incompatible codecs and queue it for background
   * conversion if needed. This is fire-and-forget: it never throws and never
   * blocks the caller.
   */
  static async checkAndQueue(
    videoUrl: string,
    userId: string,
    entityType: EntityType,
    entityId: string,
    videoIndex: number = 0,
    postId?: string,
  ): Promise<VideoProcessingResult> {
    try {
      this.logger.log(`[${entityType}] Checking codec for ${videoUrl}`);

      const tempPath = await this.downloadTemporarily(videoUrl);

      try {
        const codec = await this.detectCodec(tempPath);
        this.logger.log(`[${entityType}] Detected codec: ${codec}`);

        if (!this.needsConversion(codec)) {
          this.logger.log(`[${entityType}] Codec ${codec} is compatible, no processing needed`);
          return { needsProcessing: false, originalCodec: codec };
        }

        this.logger.log(`[${entityType}] Incompatible codec ${codec}, queuing for processing`);

        const jobId = await backgroundVideoProcessor.addVideoToQueue(videoUrl, userId, {
          entityType,
          entityId,
          postId,
          videoIndex,
          platform: 'android',
          priority: 'medium',
        });

        this.logger.log(`[${entityType}] Queued with jobId: ${jobId}`);

        return { needsProcessing: true, jobId, originalCodec: codec };
      } finally {
        this.safeDelete(tempPath);
      }
    } catch (error) {
      this.logger.error(`[${entityType}] Video processing check failed:`, error);
      // Never fail the upstream operation
      return { needsProcessing: false };
    }
  }

  /**
   * Detect video codec using ffprobe
   */
  private static async detectCodec(videoPath: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      );
      return stdout.trim().toLowerCase();
    } catch (error) {
      this.logger.error('FFprobe failed:', error);
      return 'unknown';
    }
  }

  /**
   * Determine if a codec needs conversion to H.264 for universal playback
   */
  private static needsConversion(codec: string): boolean {
    return this.INCOMPATIBLE_CODECS.includes(codec);
  }

  /**
   * Download a remote video to a temporary file for analysis
   */
  private static async downloadTemporarily(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const fileName = `vp_temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp4`;
      const filePath = path.join(os.tmpdir(), fileName);
      const file = fs.createWriteStream(filePath);

      file.on('error', reject);

      https
        .get(url, (response) => {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve(filePath);
          });
        })
        .on('error', (err) => {
          fs.unlinkSync(filePath);
          reject(err);
        });
    });
  }

  private static safeDelete(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }
}
