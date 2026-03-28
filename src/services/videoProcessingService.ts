import { StorageClient } from '@supabase/storage-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

export interface VideoProcessingOptions {
  inputPath: string;
  outputPath?: string;
  quality?: 'low' | 'medium' | 'high';
  platform?: 'android' | 'ios' | 'web';
}

export interface VideoProcessingResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  metadata?: {
    codec: string;
    resolution: string;
    bitrate: number;
    duration: number;
  };
}

export class VideoProcessingService {
  private storageClient: StorageClient;

  constructor() {
    this.storageClient = new StorageClient(
      process.env.SUPABASE_URL + '/storage/v1',
      {
        apikey: process.env.SUPABASE_ANON_KEY || '',
      }
    );
  }

  /**
   * Process video for optimal compatibility across all platforms
   */
  async processVideo(options: VideoProcessingOptions): Promise<VideoProcessingResult> {
    try {
      console.log('🎥 Starting video processing:', options);

      // Validate input file exists
      if (!fs.existsSync(options.inputPath)) {
        return { success: false, error: 'Input video file not found' };
      }

      // Get video metadata
      const metadata = await this.getVideoMetadata(options.inputPath);
      console.log('📊 Original video metadata:', metadata);

      // Check if conversion is needed
      const needsConversion = this.needsConversion(metadata, options.platform);
      
      if (!needsConversion) {
        console.log('✅ Video is already compatible, no conversion needed');
        return { 
          success: true, 
          outputPath: options.inputPath,
          metadata 
        };
      }

      // Generate output path
      const outputPath = options.outputPath || this.generateOutputPath(options.inputPath);

      // Convert video to compatible format
      const conversionResult = await this.convertVideo({
        ...options,
        outputPath,
        metadata
      });

      if (conversionResult.success) {
        // Upload converted video
        const uploadResult = await this.uploadConvertedVideo(outputPath);
        
        if (uploadResult.success) {
          // Clean up temporary files
          await this.cleanupTempFiles([outputPath]);
          
          return {
            success: true,
            outputPath: uploadResult.publicUrl,
            metadata: conversionResult.metadata
          };
        } else {
          return { success: false, error: uploadResult.error };
        }
      } else {
        return conversionResult;
      }

    } catch (error) {
      console.error('❌ Video processing failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown processing error' 
      };
    }
  }

  /**
   * Get video metadata using FFprobe
   */
  async getVideoMetadata(videoPath: string): Promise<any> {
    try {
      const { stdout } = await execAsync(`ffprobe -v quiet -print_format json -show_streams "${videoPath}"`);
      const probeData = JSON.parse(stdout);
      
      const videoStream = probeData.streams.find((stream: any) => stream.codec_type === 'video');
      
      return {
        codec: videoStream?.codec_name || 'unknown',
        resolution: `${videoStream?.width || 0}x${videoStream?.height || 0}`,
        bitrate: parseInt(videoStream?.bit_rate || '0'),
        duration: parseFloat(probeData.format?.duration || '0'),
        width: videoStream?.width || 0,
        height: videoStream?.height || 0
      };
    } catch (error) {
      console.error('Failed to get video metadata:', error);
      return null;
    }
  }

  /**
   * Check if video needs conversion based on platform requirements
   */
  needsConversion(metadata: any, platform: string = 'android'): boolean {
    if (!metadata) return true;

    const { codec, resolution, bitrate } = metadata;
    
    // Android compatibility rules
    if (platform === 'android') {
      // HEVC (H.265) needs conversion to H.264
      if (codec === 'hevc') return true;
      
      // Resolution limits
      const [width, height] = resolution.split('x').map(Number);
      const totalPixels = width * height;
      if (totalPixels > 1920 * 1080) return true; // > Full HD
      
      // Bitrate limits
      if (bitrate > 5000000) return true; // > 5 Mbps
    }
    
    // iOS is more flexible but still has limits
    if (platform === 'ios') {
      const [width, height] = resolution.split('x').map(Number);
      const totalPixels = width * height;
      if (totalPixels > 3840 * 2160) return true; // > 4K
      if (bitrate > 10000000) return true; // > 10 Mbps
    }
    
    return false;
  }

  /**
   * Convert video to compatible format using FFmpeg
   */
  private async convertVideo(options: VideoProcessingOptions & { 
    outputPath: string; 
    metadata: any 
  }): Promise<VideoProcessingResult> {
    try {
      console.log('🔄 Converting video to compatible format...');

      // Determine optimal settings based on platform
      const settings = this.getOptimalSettings(options.platform || 'android', options.quality);
      
      const ffmpegCommand = [
        'ffmpeg',
        '-i', options.inputPath,
        '-c:v', settings.videoCodec,
        '-preset', settings.preset,
        '-crf', settings.crf,
        '-maxrate', settings.maxBitrate.toString(),
        '-bufsize', settings.bufsize,
        '-pix_fmt', settings.pixelFormat,
        '-vf', `scale=${settings.scale}`,
        '-c:a', settings.audioCodec,
        '-b:a', settings.audioBitrate,
        '-movflags', '+faststart', // For web streaming
        '-y', // Overwrite output file
        options.outputPath
      ];

      console.log('🔧 FFmpeg command:', ffmpegCommand.join(' '));

      const { stdout, stderr } = await execAsync(ffmpegCommand.join(' '));
      
      if (stderr && !stderr.includes('Conversion successful')) {
        console.error('FFmpeg error:', stderr);
        return { success: false, error: 'Video conversion failed' };
      }

      // Get new metadata
      const newMetadata = await this.getVideoMetadata(options.outputPath);
      
      console.log('✅ Video conversion successful');
      return {
        success: true,
        outputPath: options.outputPath,
        metadata: newMetadata
      };

    } catch (error) {
      console.error('Video conversion error:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Conversion failed' 
      };
    }
  }

  /**
   * Get optimal video settings for target platform
   */
  private getOptimalSettings(platform: string, quality: string = 'medium') {
    const baseSettings = {
      android: {
        videoCodec: 'libx264',
        preset: 'medium',
        crf: '23',
        maxBitrate: '5M',
        bufsize: '10M',
        pixelFormat: 'yuv420p',
        scale: 'min(1920,iw):-2:min(1080,ih)', // Max 1080p
        audioCodec: 'aac',
        audioBitrate: '128k'
      },
      ios: {
        videoCodec: 'libx264',
        preset: 'medium',
        crf: '23',
        maxBitrate: '10M',
        bufsize: '20M',
        pixelFormat: 'yuv420p',
        scale: 'min(3840,iw):-2:min(2160,ih)', // Max 4K
        audioCodec: 'aac',
        audioBitrate: '128k'
      }
    };

    // Adjust for quality
    if (quality === 'low') {
      baseSettings.android.crf = '28';
      baseSettings.android.maxBitrate = '2M';
      baseSettings.ios.crf = '28';
      baseSettings.ios.maxBitrate = '4M';
    } else if (quality === 'high') {
      baseSettings.android.crf = '18';
      baseSettings.android.maxBitrate = '8M';
      baseSettings.ios.crf = '18';
      baseSettings.ios.maxBitrate = '15M';
    }

    return baseSettings[platform as keyof typeof baseSettings] || baseSettings.android;
  }

  /**
   * Generate output path for converted video
   */
  private generateOutputPath(inputPath: string): string {
    const dir = path.dirname(inputPath);
    const ext = path.extname(inputPath);
    const name = path.basename(inputPath, ext);
    return path.join(dir, `${name}_converted.mp4`);
  }

  /**
   * Upload converted video to storage
   */
  private async uploadConvertedVideo(videoPath: string): Promise<{ success: boolean; publicUrl?: string; error?: string }> {
    try {
      const fileContent = fs.readFileSync(videoPath);
      const fileName = path.basename(videoPath);
      
      const { data, error } = await this.storageClient
        .from('media')
        .upload(fileName, fileContent, {
          contentType: 'video/mp4',
          cacheControl: '3600',
          upsert: false,
        });

      if (error) {
        return { success: false, error: error.message };
      }

      const { data: publicUrlData } = this.storageClient
        .from('media')
        .getPublicUrl(data.path);

      return {
        success: true,
        publicUrl: publicUrlData.publicUrl
      };

    } catch (error) {
      console.error('Upload failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Upload failed' 
      };
    }
  }

  /**
   * Clean up temporary files
   */
  private async cleanupTempFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log('🗑️ Cleaned up temp file:', filePath);
        }
      } catch (error) {
        console.error('Failed to clean up temp file:', error);
      }
    }
  }

  /**
   * Batch process multiple videos
   */
  async processBatchVideos(videos: Array<{ inputPath: string; platform?: string }>): Promise<VideoProcessingResult[]> {
    console.log(`🎥 Starting batch processing of ${videos.length} videos`);
    
    const results = await Promise.all(
      videos.map(video => this.processVideo({
        ...video,
        platform: video.platform as 'android' | 'ios' | 'web' | undefined
      }))
    );

    const successCount = results.filter(r => r.success).length;
    console.log(`✅ Batch processing complete: ${successCount}/${videos.length} successful`);

    return results;
  }
}

export const videoProcessingService = new VideoProcessingService();
