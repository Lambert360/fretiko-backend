import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

// Global type for Express.Multer.File
declare global {
  namespace Express {
    namespace Multer {
      interface File {
        fieldname: string;
        originalname: string;
        encoding: string;
        mimetype: string;
        size: number;
        destination: string;
        filename: string;
        path: string;
        buffer: Buffer;
      }
    }
  }
}

export enum FileType {
  BLOG_IMAGE = 'blog_image',
  ABOUT_IMAGE = 'about_image',
  CAREER_IMAGE = 'career_image',
  JOB_LISTING_IMAGE = 'job_listing_image',
  RESUME = 'resume',
  PORTFOLIO = 'portfolio',
  ATTACHMENT = 'attachment',
}

export class UploadBlogImageDto {
  @ApiProperty({ description: 'Blog post ID' })
  @IsString()
  blogId: string;

  @ApiProperty({ description: 'Blog image file', type: 'string', format: 'binary' })
  file: Express.Multer.File;
}

export class UploadAboutImageDto {
  @ApiProperty({ description: 'About section ID' })
  @IsString()
  sectionId: string;

  @ApiProperty({ description: 'About section image file', type: 'string', format: 'binary' })
    file: Express.Multer.File;
}

export class UploadCareerImageDto {
  @ApiPropertyOptional({ description: 'Career post ID (optional)' })
  @IsString()
  @IsOptional()
  careerId?: string;

  @ApiProperty({ description: 'Career image file', type: 'string', format: 'binary' })
    file: Express.Multer.File;
}

export class UploadJobListingImageDto {
  @ApiProperty({ description: 'Job listing ID' })
  @IsString()
  jobId: string;

  @ApiProperty({ description: 'Job listing image file', type: 'string', format: 'binary' })
    file: Express.Multer.File;
}

export class UploadJobApplicationFileDto {
  @ApiProperty({ description: 'Job application ID' })
  @IsString()
  applicationId: string;

  @ApiProperty({ description: 'File type' })
  @IsEnum(FileType)
  fileType: 'resume' | 'portfolio' | 'attachment';

  @ApiProperty({ description: 'Application file', type: 'string', format: 'binary' })
    file: Express.Multer.File;
}

export class DeleteFileDto {
  @ApiProperty({ description: 'File path to delete' })
  @IsString()
  filePath: string;
}

export class FileUploadResponseDto {
  @ApiProperty({ description: 'Public URL of uploaded file' })
  @IsString()
  publicUrl: string;

  @ApiProperty({ description: 'Internal file path' })
  @IsString()
  filePath: string;

  @ApiProperty({ description: 'File size in bytes' })
  @IsOptional()
  @IsString()
  size?: string;

  @ApiProperty({ description: 'File type' })
  @IsOptional()
  @IsString()
  type?: string;
}
