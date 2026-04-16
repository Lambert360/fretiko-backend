import { IsString, IsOptional, IsArray, IsEnum, IsBoolean, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export enum JobType {
  FULL_TIME = 'full-time',
  PART_TIME = 'part-time',
  CONTRACT = 'contract',
  INTERNSHIP = 'internship',
}

export enum JobStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ACTIVE = 'active',
  CLOSED = 'closed',
}

export class CreateJobListingDto {
  @ApiProperty({ description: 'Job title' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Job description' })
  @IsString()
  description: string;

  @ApiPropertyOptional({ description: 'Job requirements array' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requirements?: string[];

  @ApiProperty({ description: 'Job location' })
  @IsString()
  location: string;

  @ApiPropertyOptional({ description: 'Employment type', enum: JobType })
  @IsEnum(JobType)
  @IsOptional()
  type?: JobType;

  @ApiProperty({ description: 'Department' })
  @IsString()
  department: string;

  @ApiProperty({ description: 'Salary range' })
  @IsString()
  salary: string;

  @ApiPropertyOptional({ description: 'Publication status', enum: JobStatus })
  @IsEnum(JobStatus)
  @IsOptional()
  status?: JobStatus;

  @ApiPropertyOptional({ description: 'Experience level' })
  @IsString()
  @IsOptional()
  experienceLevel?: string;

  @ApiPropertyOptional({ description: 'Whether remote work is available' })
  @IsBoolean()
  @IsOptional()
  remoteWork?: boolean;

  @ApiPropertyOptional({ description: 'URL-friendly slug' })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiPropertyOptional({ description: 'Company logo URL' })
  @IsString()
  @IsOptional()
  companyLogoUrl?: string;
}

export class UpdateJobListingDto {
  @ApiPropertyOptional({ description: 'Job title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Job description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Job requirements array' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requirements?: string[];

  @ApiPropertyOptional({ description: 'Job location' })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ description: 'Employment type', enum: JobType })
  @IsEnum(JobType)
  @IsOptional()
  type?: JobType;

  @ApiPropertyOptional({ description: 'Department' })
  @IsString()
  @IsOptional()
  department?: string;

  @ApiPropertyOptional({ description: 'Salary range' })
  @IsString()
  @IsOptional()
  salary?: string;

  @ApiPropertyOptional({ description: 'Publication status', enum: JobStatus })
  @IsEnum(JobStatus)
  @IsOptional()
  status?: JobStatus;

  @ApiPropertyOptional({ description: 'Experience level' })
  @IsString()
  @IsOptional()
  experienceLevel?: string;

  @ApiPropertyOptional({ description: 'Whether remote work is available' })
  @IsBoolean()
  @IsOptional()
  remoteWork?: boolean;

  @ApiPropertyOptional({ description: 'URL-friendly slug' })
  @IsString()
  @IsOptional()
  slug?: string;
}

export class JobListingQueryDto {
  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsEnum(JobStatus)
  @IsOptional()
  status?: JobStatus;

  @ApiPropertyOptional({ description: 'Filter by type' })
  @IsEnum(JobType)
  @IsOptional()
  type?: JobType;

  @ApiPropertyOptional({ description: 'Filter by department' })
  @IsString()
  @IsOptional()
  department?: string;

  @ApiPropertyOptional({ description: 'Filter by location' })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ description: 'Filter by remote work availability' })
  @IsBoolean()
  @IsOptional()
  remoteWork?: boolean;

  @ApiPropertyOptional({ description: 'Filter by experience level' })
  @IsString()
  @IsOptional()
  experienceLevel?: string;

  @ApiPropertyOptional({ description: 'Search term' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ description: 'Page number' })
  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page' })
  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  limit?: number = 10;

  @ApiPropertyOptional({ description: 'Company logo URL' })
  @IsString()
  @IsOptional()
  companyLogoUrl?: string;
}
