import { IsString, IsOptional, IsEnum, IsUUID, IsBoolean, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum SupportMessageType {
  CONTACT = 'contact',
  PARTNERSHIP_GENERAL = 'partnership_general',
  PARTNERSHIP_LOGISTICS = 'partnership_logistics',
  LEGAL = 'legal',
  CAREERS = 'careers',
}

export enum SupportMessageStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

export class CreateSupportMessageDto {
  @ApiProperty({ description: 'Message type', enum: SupportMessageType })
  @IsEnum(SupportMessageType)
  type: SupportMessageType;

  @ApiProperty({ description: 'Sender name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Sender email' })
  @IsString()
  email: string;

  @ApiProperty({ description: 'Message subject' })
  @IsString()
  subject: string;

  @ApiProperty({ description: 'Message content' })
  @IsString()
  message: string;

  @ApiPropertyOptional({ description: 'Phone number' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'Company name' })
  @IsString()
  @IsOptional()
  company?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Message status', enum: SupportMessageStatus })
  @IsEnum(SupportMessageStatus)
  @IsOptional()
  status?: SupportMessageStatus;

  @ApiPropertyOptional({ description: 'Attachment file URL' })
  @IsString()
  @IsOptional()
  attachmentUrl?: string;
}

export class UpdateSupportMessageDto {
  @ApiPropertyOptional({ description: 'Message status', enum: SupportMessageStatus })
  @IsEnum(SupportMessageStatus)
  @IsOptional()
  status?: SupportMessageStatus;

  @ApiPropertyOptional({ description: 'Admin notes' })
  @IsString()
  @IsOptional()
  adminNotes?: string;

  @ApiPropertyOptional({ description: 'Assigned staff ID' })
  @IsUUID()
  @IsOptional()
  assignedTo?: string;
}

export class SupportMessageReplyDto {
  @ApiProperty({ description: 'Reply message' })
  @IsString()
  message: string;

  @ApiPropertyOptional({ description: 'Send email notification' })
  @IsBoolean()
  @IsOptional()
  sendEmail?: boolean = true;

  @ApiPropertyOptional({ description: 'Admin notes for the reply' })
  @IsString()
  @IsOptional()
  adminNotes?: string;
}

export class SupportMessageQueryDto {
  @ApiPropertyOptional({ description: 'Filter by type' })
  @IsEnum(SupportMessageType)
  @IsOptional()
  type?: SupportMessageType;

  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsEnum(SupportMessageStatus)
  @IsOptional()
  status?: SupportMessageStatus;

  @ApiPropertyOptional({ description: 'Filter by assigned staff' })
  @IsUUID()
  @IsOptional()
  assignedTo?: string;

  @ApiPropertyOptional({ description: 'Search by name, email, or subject' })
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
