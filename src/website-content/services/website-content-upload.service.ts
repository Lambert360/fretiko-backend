import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../../shared/supabase.client';

@Injectable()
export class WebsiteContentUploadService {
  private serviceSupabase;
  private readonly logger = new Logger(WebsiteContentUploadService.name);

  // Allowed file types for website content
  private readonly ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  private readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

  constructor(private configService: ConfigService) {
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async uploadBlogImage(
    file: Express.Multer.File,
    blogId: string
  ): Promise<{ publicUrl: string; imagePath: string }> {
    this.logger.log(`Uploading blog image for blog: ${blogId}`);

    this.validateImageFile(file);

    try {
      const fileExtension = file.originalname.split('.').pop();
      const uniqueFileName = `blog-images/${blogId}/${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExtension}`;

      // Upload to website-content bucket
      const { data: uploadData, error: uploadError } = await this.serviceSupabase.storage
        .from('website-content')
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error('Blog image upload failed:', uploadError);
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      // Get public URL
      const { data: urlData } = this.serviceSupabase.storage
        .from('website-content')
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      this.logger.log(`Blog image uploaded successfully: ${publicUrl}`);

      return {
        publicUrl,
        imagePath: uniqueFileName,
      };
    } catch (error) {
      this.logger.error('Error uploading blog image:', error);
      throw error;
    }
  }

  async uploadAboutImage(
    file: Express.Multer.File,
    sectionId: string
  ): Promise<{ publicUrl: string; imagePath: string }> {
    this.logger.log(`Uploading about image for section: ${sectionId}`);

    this.validateImageFile(file);

    try {
      const fileExtension = file.originalname.split('.').pop();
      const uniqueFileName = `about-images/${sectionId}/${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExtension}`;

      const { data: uploadData, error: uploadError } = await this.serviceSupabase.storage
        .from('website-content')
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error('About image upload failed:', uploadError);
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      const { data: urlData } = this.serviceSupabase.storage
        .from('website-content')
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      this.logger.log(`About image uploaded successfully: ${publicUrl}`);

      return {
        publicUrl,
        imagePath: uniqueFileName,
      };
    } catch (error) {
      this.logger.error('Error uploading about image:', error);
      throw error;
    }
  }

  async uploadCareerImage(
    file: Express.Multer.File,
    careerId?: string
  ): Promise<{ publicUrl: string; imagePath: string }> {
    this.logger.log(`Uploading career image`);

    this.validateImageFile(file);

    try {
      const fileExtension = file.originalname.split('.').pop();
      const uniqueFileName = `career-images/${careerId || 'general'}/${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExtension}`;

      const { data: uploadData, error: uploadError } = await this.serviceSupabase.storage
        .from('website-content')
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error('Career image upload failed:', uploadError);
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      const { data: urlData } = this.serviceSupabase.storage
        .from('website-content')
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      this.logger.log(`Career image uploaded successfully: ${publicUrl}`);

      return {
        publicUrl,
        imagePath: uniqueFileName,
      };
    } catch (error) {
      this.logger.error('Error uploading career image:', error);
      throw error;
    }
  }

  async uploadJobListingImage(
    file: Express.Multer.File,
    jobId: string
  ): Promise<{ publicUrl: string; imagePath: string }> {
    this.logger.log(`Uploading job listing image for job: ${jobId}`);

    this.validateImageFile(file);

    try {
      const fileExtension = file.originalname.split('.').pop();
      const uniqueFileName = `job-listings/${jobId}/${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExtension}`;

      const { data: uploadData, error: uploadError } = await this.serviceSupabase.storage
        .from('website-content')
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error('Job listing image upload failed:', uploadError);
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      const { data: urlData } = this.serviceSupabase.storage
        .from('website-content')
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      this.logger.log(`Job listing image uploaded successfully: ${publicUrl}`);

      return {
        publicUrl,
        imagePath: uniqueFileName,
      };
    } catch (error) {
      this.logger.error('Error uploading job listing image:', error);
      throw error;
    }
  }

  async uploadJobApplicationFile(
    file: Express.Multer.File,
    applicationId: string,
    fileType: 'resume' | 'portfolio' | 'attachment'
  ): Promise<{ publicUrl: string; filePath: string }> {
    this.logger.log(`Uploading ${fileType} for application: ${applicationId}`);

    // Allow documents for resumes/portfolio and documents/images for attachments
    const allowedTypes = fileType === 'resume' || fileType === 'portfolio'
      ? fileType === 'resume' 
        ? ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
        : this.ALLOWED_IMAGE_TYPES
      : ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ...this.ALLOWED_IMAGE_TYPES];

    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException(`File type ${file.mimetype} is not allowed for ${fileType}`);
    }

    const maxSize = fileType === 'resume' ? 5 * 1024 * 1024 : this.MAX_IMAGE_SIZE; // 5MB for resume/portfolio/attachment, 10MB for portfolio images
    if (file.size > maxSize) {
      throw new BadRequestException(`${fileType} file too large. Maximum size is ${maxSize / (1024 * 1024)}MB`);
    }

    try {
      const fileExtension = file.originalname.split('.').pop();
      const uniqueFileName = `job-applications/${applicationId}/${fileType}/${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExtension}`;

      const { data: uploadData, error: uploadError } = await this.serviceSupabase.storage
        .from('website-content')
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error(`${fileType} upload failed:`, uploadError);
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      const { data: urlData } = this.serviceSupabase.storage
        .from('website-content')
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      this.logger.log(`${fileType} uploaded successfully: ${publicUrl}`);

      return {
        publicUrl,
        filePath: uniqueFileName,
      };
    } catch (error) {
      this.logger.error(`Error uploading ${fileType}:`, error);
      throw error;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    this.logger.log(`Deleting file: ${filePath}`);

    try {
      const { error } = await this.serviceSupabase.storage
        .from('website-content')
        .remove([filePath]);

      if (error) {
        this.logger.error('Failed to delete file from storage:', error);
        throw new BadRequestException(`Failed to delete file: ${error.message}`);
      }

      this.logger.log(`File deleted successfully: ${filePath}`);
    } catch (error) {
      this.logger.error('Error deleting file:', error);
      throw error;
    }
  }

  // Private helper methods
  private validateImageFile(file: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Check file type
    if (!this.ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(`File type ${file.mimetype} is not allowed. Allowed types: ${this.ALLOWED_IMAGE_TYPES.join(', ')}`);
    }

    // Check file size
    if (file.size > this.MAX_IMAGE_SIZE) {
      throw new BadRequestException(`Image too large. Maximum size is 10MB`);
    }
  }

  // Get storage statistics
  async getStorageStats(): Promise<any> {
    try {
      const { data: files, error } = await this.serviceSupabase.storage
        .from('website-content')
        .list('', { limit: 1000 }); // Get first 1000 files

      if (error) {
        throw new BadRequestException(`Failed to fetch storage stats: ${error.message}`);
      }

      // Calculate statistics by folder
      const folderStats: Record<string, { count: number; totalSize: number }> = files?.reduce((acc, file: any) => {
        const folder = file.name.split('/')[0];
        if (!acc[folder]) {
          acc[folder] = { count: 0, totalSize: 0 };
        }
        acc[folder].count++;
        acc[folder].totalSize += (file.metadata as any)?.size || 0;
        return acc;
      }, {} as Record<string, { count: number; totalSize: number }>) || {};

      const totalSize = Object.values(folderStats).reduce((sum: number, stat: { count: number; totalSize: number }) => sum + stat.totalSize, 0);

      return {
        totalFiles: files?.length || 0,
        totalSize,
        totalSizeMB: Math.round((totalSize / (1024 * 1024)) * 100) / 100,
        folderStats,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Error fetching storage stats:', error);
      throw error;
    }
  }
}
