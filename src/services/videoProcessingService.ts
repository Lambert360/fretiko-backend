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
  generateHLS?: boolean;
  generateThumbnail?: boolean;
  maxDuration?: number; // in seconds
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
  hlsUrls?: {
    masterPlaylist: string;
    variants: {
      '480p'?: string;
      '720p'?: string;
      '1080p'?: string;
    };
  };
  thumbnailUrl?: string;
}

export class VideoProcessingService {
  private storageClient: StorageClient;

  constructor() {
    this.storageClient = new StorageClient(
      process.env.SUPABASE_URL + '/storage/v1',
      {
        apikey: process.env.SUPABASE_KEY || '',
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

      // Create output directory
      const outputDir = options.outputPath ? path.dirname(options.outputPath) : path.dirname(options.inputPath);
      const videoId = path.basename(options.inputPath, path.extname(options.inputPath));
      
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const result: VideoProcessingResult = {
        success: true,
        metadata
      };

      // Generate thumbnail if requested
      if (options.generateThumbnail !== false) {
        console.log('🖼️ Generating thumbnail...');
        const thumbnailResult = await this.generateThumbnail(options.inputPath, outputDir, videoId);
        if (thumbnailResult.success) {
          result.thumbnailUrl = thumbnailResult.thumbnailUrl;
        }
      }

      // Generate HLS if requested (production approach)
      if (options.generateHLS) {
        console.log('🎬 Generating HLS streams...');
        const hlsResult = await this.generateHLS(options, outputDir, videoId);
        if (hlsResult.success) {
          result.hlsUrls = hlsResult.hlsUrls;
        } else {
          return hlsResult; // Return HLS error as main error
        }
      } else {
        // Fallback to single MP4 conversion
        console.log('🔄 Converting to MP4...');
        const conversionResult = await this.convertToH264MP4(options, outputDir, videoId);
        if (!conversionResult.success) {
          return conversionResult;
        }
        result.outputPath = conversionResult.outputPath;
      }

      console.log('✅ Video processing completed successfully');
      return result;

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
   * Check if video needs conversion for the target platform
   */
  needsConversion(metadata: any, platform: string = 'android'): boolean {
    if (!metadata) return true;

    // Define platform-specific requirements
    const requirements = {
      android: {
        codecs: ['h264', 'avc1'],
        maxResolution: { width: 1920, height: 1080 },
        maxBitrate: 5000000, // 5 Mbps
        maxDuration: 600 // 10 minutes
      },
      ios: {
        codecs: ['h264', 'avc1', 'hevc', 'h265'],
        maxResolution: { width: 1920, height: 1080 },
        maxBitrate: 10000000, // 10 Mbps
        maxDuration: 600
      },
      web: {
        codecs: ['h264', 'avc1', 'vp9', 'av1'],
        maxResolution: { width: 1920, height: 1080 },
        maxBitrate: 8000000, // 8 Mbps
        maxDuration: 1200 // 20 minutes
      }
    };

    const req = requirements[platform as keyof typeof requirements] || requirements.android;

    // Check codec compatibility
    if (!req.codecs.includes(metadata.codec.toLowerCase())) {
      console.log(`❌ Codec ${metadata.codec} not supported for ${platform}`);
      return true;
    }

    // Check resolution
    if (metadata.width > req.maxResolution.width || metadata.height > req.maxResolution.height) {
      console.log(`❌ Resolution ${metadata.resolution} exceeds ${platform} limit`);
      return true;
    }

    // Check bitrate
    if (metadata.bitrate > req.maxBitrate) {
      console.log(`❌ Bitrate ${metadata.bitrate} exceeds ${platform} limit`);
      return true;
    }

    // Check duration
    if (metadata.duration > req.maxDuration) {
      console.log(`❌ Duration ${metadata.duration}s exceeds ${platform} limit`);
      return true;
    }

    console.log(`✅ Video is compatible with ${platform}`);
    return false;
  }

  /**
   * Generate thumbnail from video
   */
  private async generateThumbnail(inputPath: string, outputDir: string, videoId: string): Promise<{ success: boolean; thumbnailUrl?: string; error?: string }> {
    try {
      const thumbnailPath = path.join(outputDir, `${videoId}_thumbnail.jpg`);
      
      const ffmpegCommand = [
        'ffmpeg',
        '-i', inputPath,
        '-ss', '00:00:01', // Take frame at 1 second
        '-vframes', '1',
        '-vf', 'scale=320:240', // Small thumbnail size
        '-y',
        thumbnailPath
      ];

      console.log('🖼️ Generating thumbnail:', ffmpegCommand.join(' '));
      await execAsync(ffmpegCommand.join(' '));

      // Upload thumbnail
      const uploadResult = await this.uploadFile(thumbnailPath, 'image/jpeg');
      
      // Cleanup local file
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }

      return uploadResult;

    } catch (error) {
      console.error('Thumbnail generation failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Thumbnail generation failed' 
      };
    }
  }

  /**
   * Generate HLS streams with proper master playlist
   */
  private async generateHLS(options: VideoProcessingOptions, outputDir: string, videoId: string): Promise<VideoProcessingResult> {
    try {
      console.log('🎬 Starting HLS generation...');
      
      const hlsDir = path.join(outputDir, 'hls');
      if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
      }

      // Generate different quality variants
      const qualities = this.getHLSQualities(options.quality);
      const variantUrls: { [key: string]: string } = {};

      for (const [qualityName, config] of Object.entries(qualities)) {
        const qualityConfig = config as { crf: string; bitrate: string; scale: string; bandwidth: string; resolution: string };
        const qualityDir = path.join(hlsDir, qualityName);
        if (!fs.existsSync(qualityDir)) {
          fs.mkdirSync(qualityDir, { recursive: true });
        }

        console.log(`🎥 Generating ${qualityName} variant...`);
        
        const ffmpegCommand = [
          'ffmpeg',
          '-i', options.inputPath,
          // Video settings
          '-c:v', 'libx264', // Always convert to H.264
          '-preset', 'medium',
          '-crf', qualityConfig.crf,
          '-b:v', qualityConfig.bitrate,
          '-maxrate', `${parseInt(qualityConfig.bitrate) * 1.5}k`,
          '-bufsize', `${parseInt(qualityConfig.bitrate) * 3}k`,
          '-vf', `scale=${qualityConfig.scale}`,
          '-pix_fmt', 'yuv420p',
          // Audio settings
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          // HLS settings
          '-hls_time', '6',
          '-hls_list_size', '0',
          '-hls_segment_filename', path.join(qualityDir, 'segment%03d.ts'),
          '-f', 'hls',
          '-y',
          path.join(qualityDir, 'playlist.m3u8')
        ];

        // Add duration limit if specified
        if (options.maxDuration) {
          ffmpegCommand.splice(ffmpegCommand.indexOf('-i') + 2, 0, '-t', options.maxDuration.toString());
        }

        console.log(`🔧 FFmpeg command for ${qualityName}:`, ffmpegCommand.join(' '));
        
        try {
          await execAsync(ffmpegCommand.join(' '));
          
          // Upload variant playlist and segments
          const variantUploadResult = await this.uploadHLSDirectory(qualityDir, `videos/hls/${qualityName}`);
          if (variantUploadResult.success) {
            variantUrls[qualityName] = variantUploadResult.publicUrl!;
          }
          
        } catch (error) {
          console.error(`Failed to generate ${qualityName} variant:`, error);
          // Continue with other qualities
        }
      }

      // Create master playlist
      const masterPlaylistPath = path.join(hlsDir, 'master.m3u8');
      const masterPlaylist = this.createMasterPlaylist(variantUrls, qualities);
      
      fs.writeFileSync(masterPlaylistPath, masterPlaylist);
      
      // Upload master playlist
      const masterUploadResult = await this.uploadFile(masterPlaylistPath, 'application/vnd.apple.mpegurl');
      
      if (!masterUploadResult.success) {
        return { success: false, error: masterUploadResult.error };
      }

      // Cleanup HLS directory
      await this.cleanupTempFiles([hlsDir]);

      return {
        success: true,
        hlsUrls: {
          masterPlaylist: masterUploadResult.publicUrl!,
          variants: {
            '480p': variantUrls['480p'],
            '720p': variantUrls['720p'],
            '1080p': variantUrls['1080p']
          }
        }
      };

    } catch (error) {
      console.error('HLS generation failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'HLS generation failed' 
      };
    }
  }

  /**
   * Create HLS master playlist content
   */
  private createMasterPlaylist(variantUrls: { [key: string]: string }, qualities: { [key: string]: any }): string {
    let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n';
    
    const qualityOrder = ['480p', '720p', '1080p'];
    
    for (const quality of qualityOrder) {
      if (variantUrls[quality]) {
        const config = qualities[quality];
        playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${config.bandwidth},RESOLUTION=${config.resolution},CODECS="avc1.42E01E,mp4a.40.2"\n`;
        playlist += `${variantUrls[quality]}\n`;
      }
    }
    
    return playlist;
  }

  /**
   * Get HLS quality configurations
   */
  private getHLSQualities(baseQuality: string = 'medium'): { [key: string]: { crf: string; bitrate: string; scale: string; bandwidth: string; resolution: string } } {
    const baseConfigs = {
      low: {
        '480p': {
          crf: '28',
          bitrate: '1000k',
          scale: '854:480',
          bandwidth: '1000000',
          resolution: '854x480'
        }
      },
      medium: {
        '480p': {
          crf: '28',
          bitrate: '1000k',
          scale: '854:480',
          bandwidth: '1000000',
          resolution: '854x480'
        },
        '720p': {
          crf: '23',
          bitrate: '2500k',
          scale: '1280:720',
          bandwidth: '2500000',
          resolution: '1280x720'
        }
      },
      high: {
        '480p': {
          crf: '28',
          bitrate: '1000k',
          scale: '854:480',
          bandwidth: '1000000',
          resolution: '854x480'
        },
        '720p': {
          crf: '23',
          bitrate: '2500k',
          scale: '1280:720',
          bandwidth: '2500000',
          resolution: '1280x720'
        },
        '1080p': {
          crf: '18',
          bitrate: '5000k',
          scale: '1920:1080',
          bandwidth: '5000000',
          resolution: '1920x1080'
        }
      }
    };

    return baseConfigs[baseQuality as keyof typeof baseConfigs] || baseConfigs.medium;
  }

  /**
   * Upload HLS directory to storage
   */
  private async uploadHLSDirectory(localDir: string, remoteDir: string): Promise<{ success: boolean; publicUrl?: string; error?: string }> {
    try {
      const files = fs.readdirSync(localDir, { recursive: true });
      let masterPlaylistUrl = '';

      for (const file of files) {
        const fileName = typeof file === 'string' ? file : file.toString();
        const localPath = path.join(localDir, fileName);
        const stat = fs.statSync(localPath);
        
        if (stat.isFile()) {
          const fileContent = fs.readFileSync(localPath);
          const remotePath = path.join(remoteDir, fileName).replace(/\\/g, '/');
          
          const contentType = fileName.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 
                           fileName.endsWith('.ts') ? 'video/MP2T' : 'application/octet-stream';
          
          const { data, error } = await this.storageClient
            .from('media')
            .upload(remotePath, fileContent, {
              contentType,
              cacheControl: '3600',
              upsert: false,
            });

          if (error) {
            console.error(`Failed to upload ${fileName}:`, error);
            continue;
          }

          // Track master playlist URL
          if (fileName.endsWith('playlist.m3u8')) {
            const { data: publicUrlData } = this.storageClient
              .from('media')
              .getPublicUrl(data.path);
            masterPlaylistUrl = publicUrlData.publicUrl;
          }
        }
      }

      if (!masterPlaylistUrl) {
        return { success: false, error: 'No master playlist uploaded' };
      }

      return {
        success: true,
        publicUrl: masterPlaylistUrl
      };

    } catch (error) {
      console.error('HLS directory upload failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'HLS directory upload failed' 
      };
    }
  }
  private async convertToH264MP4(options: VideoProcessingOptions, outputDir: string, videoId: string): Promise<VideoProcessingResult> {
    try {
      const outputPath = path.join(outputDir, `${videoId}_converted.mp4`);
      
      // Get optimal settings based on platform
      const settings = this.getOptimalSettings(options.platform || 'android', options.quality);
      
      const ffmpegCommand = [
        'ffmpeg',
        '-i', options.inputPath,
        // Convert to H.264 (fixes H.265 issues)
        '-c:v', 'libx264',
        '-preset', 'veryfast', // Faster encoding for mobile
        '-crf', settings.crf,
        '-maxrate', settings.maxBitrate,
        '-bufsize', settings.bufsize,
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'baseline', // Maximum compatibility
        '-level', '3.0', // Mobile-friendly level
        '-vf', `scale=${settings.scale}`,
        // Audio settings
        '-c:a', settings.audioCodec,
        '-b:a', settings.audioBitrate,
        '-ar', '44100', // Standard sample rate
        // Optimization for streaming
        '-movflags', '+faststart',
        '-y'
      ];

      // Add duration limit if specified
      if (options.maxDuration) {
        ffmpegCommand.splice(ffmpegCommand.indexOf('-i') + 2, 0, '-t', options.maxDuration.toString());
      }
      
      ffmpegCommand.push(outputPath);

      console.log('🔧 FFmpeg H.264 conversion command:', ffmpegCommand.join(' '));
      await execAsync(ffmpegCommand.join(' '));

      // Get new metadata
      const newMetadata = await this.getVideoMetadata(outputPath);
      
      // Upload converted video
      const uploadResult = await this.uploadFile(outputPath, 'video/mp4');
      
      // Cleanup local file
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }

      if (uploadResult.success) {
        return {
          success: true,
          outputPath: uploadResult.publicUrl,
          metadata: newMetadata
        };
      } else {
        return { success: false, error: uploadResult.error };
      }

    } catch (error) {
      console.error('H.264 conversion failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'H.264 conversion failed' 
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
        scale: '1920:1080', // Max 1080p
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
        scale: '1920:1080', // Max 1080p for compatibility
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
   * Upload file to storage
   */
  private async uploadFile(filePath: string, contentType: string): Promise<{ success: boolean; publicUrl?: string; error?: string }> {
    try {
      const fileContent = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      
      const { data, error } = await this.storageClient
        .from('media')
        .upload(fileName, fileContent, {
          contentType,
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
