import { IsString, IsOptional, IsUUID, IsEnum, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum JobApplicationStatus {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  SHORTLISTED = 'shortlisted',
  REJECTED = 'rejected',
  HIRED = 'hired',
}

export class CreateJobApplicationDto {
  @ApiProperty({ description: 'Job ID' })
  @IsString()
  jobId: string;

  @ApiProperty({ description: 'Job title' })
  @IsString()
  jobTitle: string;

  @ApiProperty({ description: 'Applicant name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Applicant email' })
  @IsString()
  email: string;

  @ApiPropertyOptional({ description: 'Applicant phone' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'Resume URL' })
  @IsString()
  @IsOptional()
  resume?: string;

  @ApiPropertyOptional({ description: 'Cover letter' })
  @IsString()
  @IsOptional()
  coverLetter?: string;

  @ApiPropertyOptional({ description: 'Experience details' })
  @IsString()
  @IsOptional()
  experience?: string;

  @ApiPropertyOptional({ description: 'Education details' })
  @IsString()
  @IsOptional()
  education?: string;

  @ApiPropertyOptional({ description: 'Portfolio URL' })
  @IsString()
  @IsOptional()
  portfolio?: string;

  @ApiPropertyOptional({ description: 'Application status', enum: JobApplicationStatus })
  @IsEnum(JobApplicationStatus)
  @IsOptional()
  status?: JobApplicationStatus;
}

export class UpdateJobApplicationDto {
  @ApiPropertyOptional({ description: 'Application status', enum: JobApplicationStatus })
  @IsEnum(JobApplicationStatus)
  @IsOptional()
  status?: JobApplicationStatus;

  @ApiPropertyOptional({ description: 'Review notes' })
  @IsString()
  @IsOptional()
  reviewNotes?: string;
}

export class JobApplicationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsEnum(JobApplicationStatus)
  @IsOptional()
  status?: JobApplicationStatus;

  @ApiPropertyOptional({ description: 'Filter by job ID' })
  @IsUUID()
  @IsOptional()
  jobId?: string;

  @ApiPropertyOptional({ description: 'Search by name or email' })
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
}
