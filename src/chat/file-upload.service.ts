import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { FileUploadDto } from './dto/chat.dto';
import { backgroundVideoProcessor } from '../services/backgroundVideoProcessor';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class FileUploadService {
  private supabase;
  private readonly logger = new Logger(FileUploadService.name);
  
  // Allowed file types and sizes
  private readonly ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  private readonly ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/avi', 'video/mov'];
  private readonly ALLOWED_AUDIO_TYPES = ['audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/m4a', 'audio/ogg', 'audio/x-m4a'];
  private readonly ALLOWED_DOCUMENT_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
  ];
  
  private readonly MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
  private readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
  private readonly MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async uploadFile(
    userId: string,
    file: Express.Multer.File,
    messageId: string,
    userToken?: string
  ): Promise<{ publicUrl: string; fileData: any }> {
    this.logger.log(`Uploading file for user: ${userId}, message: ${messageId}`);

    // Validate file
    this.validateFile(file);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Generate unique filename
      const fileExtension = file.originalname.split('.').pop();
      const uniqueFileName = `${userId}/${messageId}/${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExtension}`;
      
      // Determine storage bucket based on file type
      const bucket = this.getStorageBucket(file.mimetype);
      
      // Upload file to Supabase Storage
      const { data: uploadData, error: uploadError } = await client.storage
        .from(bucket)
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error('File upload failed:', uploadError);
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      // Get public URL
      const { data: urlData } = client.storage
        .from(bucket)
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      // Save file metadata to database
      const fileMetadata = {
        name: file.originalname,
        size: file.size,
        type: this.getFileType(file.mimetype),
        mimeType: file.mimetype,
        bucket,
        storagePath: uniqueFileName,
      };

      const { error: dbError } = await client
        .from('chat_file_uploads')
        .insert({
          message_id: messageId,
          uploader_id: userId,
          file_name: file.originalname,
          file_size: file.size,
          file_type: this.getFileType(file.mimetype),
          mime_type: file.mimetype,
          storage_path: uniqueFileName,
          public_url: publicUrl,
          metadata: {
            bucket,
            originalName: file.originalname,
            uploadedAt: new Date().toISOString(),
          },
        });

      if (dbError) {
        this.logger.error('Failed to save file metadata:', dbError);
        // Cleanup uploaded file
        await client.storage.from(bucket).remove([uniqueFileName]);
        throw new BadRequestException(`Failed to save file metadata: ${dbError.message}`);
      }

      this.logger.log(`File uploaded successfully: ${publicUrl}`);

      // Check if this is a video that needs processing
      if (fileMetadata.type === 'video') {
        await this.checkAndProcessVideo(publicUrl, fileMetadata, userId, messageId);
      }

      return {
        publicUrl,
        fileData: fileMetadata,
      };
    } catch (error) {
      this.logger.error('Error uploading file:', error);
      throw error;
    }
  }

  async uploadMultipleFiles(
    userId: string,
    files: Express.Multer.File[],
    messageId: string,
    userToken?: string
  ): Promise<{ publicUrls: string[]; filesData: any[] }> {
    this.logger.log(`Uploading ${files.length} files for user: ${userId}`);

    const uploadPromises = files.map(file => 
      this.uploadFile(userId, file, `${messageId}_${Date.now()}`, userToken)
    );

    try {
      const results = await Promise.all(uploadPromises);
      
      return {
        publicUrls: results.map(result => result.publicUrl),
        filesData: results.map(result => result.fileData),
      };
    } catch (error) {
      this.logger.error('Error uploading multiple files:', error);
      throw error;
    }
  }

  async deleteFile(userId: string, fileId: string, userToken?: string): Promise<void> {
    this.logger.log(`Deleting file: ${fileId} for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get file metadata
      const { data: fileData, error: fetchError } = await client
        .from('chat_file_uploads')
        .select('storage_path, mime_type, uploader_id')
        .eq('id', fileId)
        .single();

      if (fetchError || !fileData) {
        throw new BadRequestException('File not found');
      }

      // Check if user owns the file
      if (fileData.uploader_id !== userId) {
        throw new BadRequestException('Access denied');
      }

      // Delete from storage
      const bucket = this.getStorageBucket(fileData.mime_type);
      const { error: deleteError } = await client.storage
        .from(bucket)
        .remove([fileData.storage_path]);

      if (deleteError) {
        this.logger.error('Failed to delete file from storage:', deleteError);
      }

      // Delete metadata from database
      const { error: dbError } = await client
        .from('chat_file_uploads')
        .delete()
        .eq('id', fileId);

      if (dbError) {
        throw new BadRequestException(`Failed to delete file metadata: ${dbError.message}`);
      }

      this.logger.log(`File deleted successfully: ${fileId}`);
    } catch (error) {
      this.logger.error('Error deleting file:', error);
      throw error;
    }
  }

  async getFilesByMessage(messageId: string, userToken?: string): Promise<any[]> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: files, error } = await client
        .from('chat_file_uploads')
        .select('*')
        .eq('message_id', messageId)
        .order('created_at', { ascending: true });

      if (error) {
        throw new BadRequestException(`Failed to fetch files: ${error.message}`);
      }

      return files || [];
    } catch (error) {
      this.logger.error('Error fetching files:', error);
      throw error;
    }
  }

  // Generate presigned URL for secure file access
  async generatePresignedUrl(
    userId: string, 
    fileId: string, 
    expiresIn: number = 3600, // 1 hour default
    userToken?: string
  ): Promise<string> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get file metadata and verify access
      const { data: fileData, error } = await client
        .from('chat_file_uploads')
        .select(`
          storage_path,
          mime_type,
          message_id,
          chat_messages!inner (
            conversation_id,
            chat_conversations!inner (
              chat_participants!inner (
                user_id
              )
            )
          )
        `)
        .eq('id', fileId)
        .single();

      if (error || !fileData) {
        throw new BadRequestException('File not found or access denied');
      }

      // Check if user has access to the conversation
      const hasAccess = fileData.chat_messages.chat_conversations.chat_participants
        .some(p => p.user_id === userId);

      if (!hasAccess) {
        throw new BadRequestException('Access denied');
      }

      // Generate presigned URL
      const bucket = this.getStorageBucket(fileData.mime_type);
      const { data: urlData, error: urlError } = await client.storage
        .from(bucket)
        .createSignedUrl(fileData.storage_path, expiresIn);

      if (urlError) {
        throw new BadRequestException(`Failed to generate URL: ${urlError.message}`);
      }

      return urlData.signedUrl;
    } catch (error) {
      this.logger.error('Error generating presigned URL:', error);
      throw error;
    }
  }

  // Private helper methods
  private validateFile(file: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Check file size
    if (file.size > this.MAX_FILE_SIZE) {
      throw new BadRequestException('File too large. Maximum size is 50MB');
    }

    // Check specific size limits
    if (this.ALLOWED_IMAGE_TYPES.includes(file.mimetype) && file.size > this.MAX_IMAGE_SIZE) {
      throw new BadRequestException('Image too large. Maximum size is 10MB');
    }

    if (this.ALLOWED_VIDEO_TYPES.includes(file.mimetype) && file.size > this.MAX_VIDEO_SIZE) {
      throw new BadRequestException('Video too large. Maximum size is 100MB');
    }

    // Check file type
    const allowedTypes = [
      ...this.ALLOWED_IMAGE_TYPES,
      ...this.ALLOWED_VIDEO_TYPES,
      ...this.ALLOWED_AUDIO_TYPES,
      ...this.ALLOWED_DOCUMENT_TYPES,
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException(`File type ${file.mimetype} is not allowed`);
    }
  }

  private getStorageBucket(mimeType: string): string {
    if (this.ALLOWED_IMAGE_TYPES.includes(mimeType)) {
      return 'chat-media';
    }
    if (this.ALLOWED_VIDEO_TYPES.includes(mimeType)) {
      return 'chat-media';
    }
    if (this.ALLOWED_AUDIO_TYPES.includes(mimeType)) {
      return 'chat-media';
    }
    if (this.ALLOWED_DOCUMENT_TYPES.includes(mimeType)) {
      return 'chat-media';
    }
    return 'chat-media'; // Default bucket
  }

  private getFileType(mimeType: string): string {
    if (this.ALLOWED_IMAGE_TYPES.includes(mimeType)) return 'image';
    if (this.ALLOWED_VIDEO_TYPES.includes(mimeType)) return 'video';
    if (this.ALLOWED_AUDIO_TYPES.includes(mimeType)) return 'audio';
    if (this.ALLOWED_DOCUMENT_TYPES.includes(mimeType)) return 'document';
    return 'file';
  }

  // Utility method to generate thumbnail for videos/images
  async generateThumbnail(fileUrl: string, fileType: string): Promise<string | null> {
    // This would integrate with a thumbnail generation service
    // For now, return null - in production you'd use services like:
    // - FFmpeg for video thumbnails
    // - Sharp for image resizing
    // - Cloud services like Cloudinary
    this.logger.log(`Generating thumbnail for ${fileType}: ${fileUrl}`);
    return null;
  }

  /**
   * Check if video needs processing and queue it if necessary
   */
  private async checkAndProcessVideo(
    videoUrl: string, 
    fileMetadata: any, 
    userId: string, 
    messageId: string
  ): Promise<void> {
    try {
      this.logger.log(`Checking video codec for: ${videoUrl}`);
      
      // Download video temporarily to check codec
      const tempPath = await this.downloadVideoTemporarily(videoUrl);
      
      try {
        // Get video codec using FFprobe
        const codec = await this.getVideoCodec(tempPath);
        this.logger.log(`Detected video codec: ${codec}`);
        
        // Check if codec needs processing (HEVC/H.265)
        if (this.needsVideoProcessing(codec)) {
          this.logger.log(`Video ${videoUrl} uses incompatible codec ${codec}, queuing for processing`);
          
          // Add to background processing queue
          const jobId = await backgroundVideoProcessor.addVideoToQueue(videoUrl, userId, {
            serviceId: messageId, // Use messageId as service identifier
            platform: 'android', // Default to android for maximum compatibility
            priority: 'medium'
          });
          
          this.logger.log(`Video queued for processing with job ID: ${jobId}`);
          
          // Update database to indicate processing is in progress
          await this.updateVideoProcessingStatus(messageId, {
            processing: true,
            jobId,
            originalCodec: codec,
            processingStartedAt: new Date().toISOString()
          });
        } else {
          this.logger.log(`Video ${videoUrl} uses compatible codec ${codec}, no processing needed`);
        }
      } finally {
        // Clean up temp file
        if (tempPath && require('fs').existsSync(tempPath)) {
          require('fs').unlinkSync(tempPath);
        }
      }
    } catch (error) {
      this.logger.error('Error checking video codec:', error);
      // Don't fail the upload, just log the error
    }
  }

  /**
   * Download video temporarily for codec analysis
   */
  private async downloadVideoTemporarily(url: string): Promise<string> {
    const https = require('https');
    const fs = require('fs');
    const path = require('path');
    
    return new Promise((resolve, reject) => {
      const fileName = `temp_video_check_${Date.now()}.mp4`;
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
   * Get video codec using FFprobe
   */
  private async getVideoCodec(videoPath: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
      return stdout.trim().toLowerCase();
    } catch (error) {
      this.logger.error('Failed to get video codec:', error);
      return 'unknown';
    }
  }

  /**
   * Check if video needs processing based on codec
   */
  private needsVideoProcessing(codec: string): boolean {
    // HEVC/H.265 codecs that need conversion to H.264
    const incompatibleCodecs = ['hevc', 'h265', 'vp9', 'av1'];
    return incompatibleCodecs.includes(codec);
  }

  /**
   * Update video processing status in database
   */
  private async updateVideoProcessingStatus(messageId: string, processingInfo: {
    processing: boolean;
    jobId?: string;
    originalCodec?: string;
    processingStartedAt?: string;
  }): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('chat_file_uploads')
        .update({
          metadata: {
            videoProcessing: processingInfo,
            updated_at: new Date().toISOString()
          }
        })
        .eq('message_id', messageId)
        .eq('file_type', 'video');

      if (error) {
        this.logger.error('Failed to update video processing status:', error);
      }
    } catch (error) {
      this.logger.error('Error updating video processing status:', error);
    }
  }

  // Get file usage statistics
  async getStorageStats(userId: string, userToken?: string): Promise<any> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: stats, error } = await client
        .from('chat_file_uploads')
        .select('file_type, file_size')
        .eq('uploader_id', userId);

      if (error) {
        throw new BadRequestException(`Failed to fetch storage stats: ${error.message}`);
      }

      // Calculate statistics
      const totalSize = stats?.reduce((sum, file) => sum + file.file_size, 0) || 0;
      const fileTypeCounts = stats?.reduce((acc, file) => {
        acc[file.file_type] = (acc[file.file_type] || 0) + 1;
        return acc;
      }, {}) || {};

      return {
        totalFiles: stats?.length || 0,
        totalSize,
        totalSizeMB: Math.round((totalSize / (1024 * 1024)) * 100) / 100,
        fileTypeCounts,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Error fetching storage stats:', error);
      throw error;
    }
  }
}