import { IsString, IsOptional, IsEnum, IsNumber, IsUUID, IsBoolean } from 'class-validator';

export enum StoryMediaType {
  IMAGE = 'image',
  VIDEO = 'video'
}

export class CreateStoryDto {
  @IsString()
  media_url: string;

  @IsEnum(StoryMediaType)
  media_type: StoryMediaType;

  @IsOptional()
  @IsString()
  thumbnail_url?: string;

  @IsOptional()
  @IsString()
  caption?: string;

  @IsOptional()
  @IsNumber()
  duration?: number; // For videos, duration in seconds
}

export class UpdateStoryDto {
  @IsOptional()
  @IsString()
  caption?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class CreateStoryCommentDto {
  @IsString()
  content: string;
}

export class StoryQueryDto {
  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  offset?: number;

  @IsOptional()
  @IsUUID()
  user_id?: string; // Get stories from specific user
}

export class StoryViewDto {
  @IsUUID()
  story_id: string;
}

export class StoryLikeDto {
  @IsUUID()
  story_id: string;
}