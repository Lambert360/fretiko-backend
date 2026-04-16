import {
  Controller,
  Post,
  Delete,
  Body,
  UploadedFile,
  UseInterceptors,
  HttpStatus,
  Get,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { WebsiteContentUploadService } from '../services/website-content-upload.service';
import {
  UploadBlogImageDto,
  UploadAboutImageDto,
  UploadCareerImageDto,
  UploadJobListingImageDto,
  UploadJobApplicationFileDto,
  DeleteFileDto,
  FileUploadResponseDto,
  FileType,
} from '../dto/website-content-upload.dto';

@ApiTags('Website Content Upload')
@Controller('website-content/upload')
@UseInterceptors(FileInterceptor('file'))
export class WebsiteContentUploadController {
  constructor(private readonly uploadService: WebsiteContentUploadService) {}

  @Post('blog')
  @ApiOperation({ summary: 'Upload blog post image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadBlogImageDto })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Blog image uploaded successfully', type: FileUploadResponseDto })
  async uploadBlogImage(@UploadedFile() file: Express.Multer.File, @Body() uploadDto: UploadBlogImageDto) {
    return this.uploadService.uploadBlogImage(file, uploadDto.blogId);
  }

  @Post('about')
  @ApiOperation({ summary: 'Upload about section image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadAboutImageDto })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'About image uploaded successfully', type: FileUploadResponseDto })
  async uploadAboutImage(@UploadedFile() file: Express.Multer.File, @Body() uploadDto: UploadAboutImageDto) {
    return this.uploadService.uploadAboutImage(file, uploadDto.sectionId);
  }

  @Post('career')
  @ApiOperation({ summary: 'Upload career page image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadCareerImageDto })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Career image uploaded successfully', type: FileUploadResponseDto })
  async uploadCareerImage(@UploadedFile() file: Express.Multer.File, @Body() uploadDto: UploadCareerImageDto) {
    return this.uploadService.uploadCareerImage(file, uploadDto.careerId);
  }

  @Post('job-listing')
  @ApiOperation({ summary: 'Upload job listing image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadJobListingImageDto })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Job listing image uploaded successfully', type: FileUploadResponseDto })
  async uploadJobListingImage(@UploadedFile() file: Express.Multer.File, @Body() uploadDto: UploadJobListingImageDto) {
    return this.uploadService.uploadJobListingImage(file, uploadDto.jobId);
  }

  @Post('job-application')
  @ApiOperation({ summary: 'Upload job application file (resume or portfolio)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadJobApplicationFileDto })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Application file uploaded successfully', type: FileUploadResponseDto })
  async uploadJobApplicationFile(@UploadedFile() file: Express.Multer.File, @Body() uploadDto: UploadJobApplicationFileDto) {
    return this.uploadService.uploadJobApplicationFile(file, uploadDto.applicationId, uploadDto.fileType);
  }

  @Delete('file')
  @ApiOperation({ summary: 'Delete uploaded file' })
  @ApiResponse({ status: HttpStatus.OK, description: 'File deleted successfully' })
  async deleteFile(@Body() deleteDto: DeleteFileDto) {
    await this.uploadService.deleteFile(deleteDto.filePath);
    return { message: 'File deleted successfully' };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get storage statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Storage statistics retrieved successfully' })
  async getStorageStats() {
    return this.uploadService.getStorageStats();
  }
}

// Public controller for anonymous uploads
@ApiTags('Public - Website Content Upload')
@Controller('public/website-content/upload')
@UseInterceptors(FileInterceptor('file'))
export class PublicWebsiteContentUploadController {
  constructor(private readonly uploadService: WebsiteContentUploadService) {}

  @Post('job-application-file')
  @ApiOperation({ summary: 'Upload job application file (anonymous)' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Application file uploaded successfully', type: FileUploadResponseDto })
  async uploadJobApplicationFile(@UploadedFile() file: Express.Multer.File, @Body() uploadDto: UploadJobApplicationFileDto) {
    return this.uploadService.uploadJobApplicationFile(file, uploadDto.applicationId, uploadDto.fileType);
  }

  @Post('support-attachment')
  @ApiOperation({ summary: 'Upload support attachment (anonymous)' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Support attachment uploaded successfully', type: FileUploadResponseDto })
  async uploadSupportAttachment(@UploadedFile() file: Express.Multer.File) {
    return this.uploadService.uploadJobApplicationFile(file, 'support', 'attachment');
  }
}
