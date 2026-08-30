import { IsString, IsOptional, IsNumber, IsUUID, IsBoolean, IsEnum, IsUrl, IsDateString, IsArray, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export enum ScreenTarget {
  HOME = 'home',
  PRODUCTS = 'products',
  LIVE_SALES = 'live_sales',
  AUCTIONS = 'auctions',
  ALL = 'all',
}

export enum MediaType {
  IMAGE = 'image',
  VIDEO = 'video',
}

export enum ProcessingStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export class SignPostMediaItemDto {
  @ApiPropertyOptional({ description: 'Media item ID (omit when creating)' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ description: 'Media type', enum: MediaType })
  @IsEnum(MediaType)
  mediaType!: MediaType;

  @ApiProperty({ description: 'Media URL' })
  @IsUrl()
  @IsString()
  mediaUrl!: string;

  @ApiPropertyOptional({ description: 'Thumbnail URL (required for videos)' })
  @IsOptional()
  @IsUrl()
  @IsString()
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Sort order' })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}

export class CreateSignPostDto {
  @ApiProperty({ description: 'Admin label for the sign post' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Hero title' })
  @IsString()
  title!: string;

  @ApiPropertyOptional({ description: 'Hero subtitle' })
  @IsOptional()
  @IsString()
  subtitle?: string;

  @ApiPropertyOptional({ description: 'Action URL when hero is tapped' })
  @IsOptional()
  @IsString()
  actionUrl?: string;

  @ApiProperty({ description: 'Target screen', enum: ScreenTarget })
  @IsEnum(ScreenTarget)
  screenTarget!: ScreenTarget;

  @ApiPropertyOptional({ description: 'Whether to display a live countdown overlay on the hero' })
  @IsOptional()
  @IsBoolean()
  countdownEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Countdown target date/time (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  countdownTarget?: string;

  @ApiPropertyOptional({ description: 'Whether the sign post is active' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Display order among sign posts' })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Start display time' })
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiPropertyOptional({ description: 'End display time' })
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @ApiPropertyOptional({ description: 'Media items for this sign post' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SignPostMediaItemDto)
  media?: SignPostMediaItemDto[];
}

export class UpdateSignPostDto {
  @ApiPropertyOptional({ description: 'Admin label for the sign post' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Hero title' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Hero subtitle' })
  @IsOptional()
  @IsString()
  subtitle?: string;

  @ApiPropertyOptional({ description: 'Action URL when hero is tapped' })
  @IsOptional()
  @IsString()
  actionUrl?: string;

  @ApiPropertyOptional({ description: 'Target screen', enum: ScreenTarget })
  @IsOptional()
  @IsEnum(ScreenTarget)
  screenTarget?: ScreenTarget;

  @ApiPropertyOptional({ description: 'Whether to display a live countdown overlay on the hero' })
  @IsOptional()
  @IsBoolean()
  countdownEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Countdown target date/time (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  countdownTarget?: string;

  @ApiPropertyOptional({ description: 'Whether the sign post is active' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Display order among sign posts' })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Start display time' })
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiPropertyOptional({ description: 'End display time' })
  @IsOptional()
  @IsDateString()
  endAt?: string;
}

export class CreateSignPostMediaDto {
  @ApiProperty({ description: 'Media type', enum: MediaType })
  @IsEnum(MediaType)
  mediaType!: MediaType;

  @ApiPropertyOptional({ description: 'Sort order' })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}

export class UpdateSignPostMediaDto {
  @ApiPropertyOptional({ description: 'Sort order' })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Media URL' })
  @IsOptional()
  @IsString()
  mediaUrl?: string;

  @ApiPropertyOptional({ description: 'Thumbnail URL' })
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;
}

export class SignPostQueryDto {
  @ApiPropertyOptional({ description: 'Filter by screen target', enum: ScreenTarget })
  @IsOptional()
  @IsEnum(ScreenTarget)
  screenTarget?: ScreenTarget;

  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
