import { IsString, IsOptional, IsArray, IsEnum, MaxLength, MinLength, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MediaType, PrivacyLevel } from '../interfaces/post.interface';

export class PostMediaDto {
  @IsString()
  mediaUrl: string;

  @IsEnum(['image', 'video'])
  mediaType: 'image' | 'video';

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @IsOptional()
  duration?: number;

  @IsOptional()
  width?: number;

  @IsOptional()
  height?: number;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  fileSize?: number;
}

export class CreatePostDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  @ArrayMaxSize(10)
  media?: PostMediaDto[];

  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType = MediaType.TEXT;

  @IsOptional()
  @IsEnum(PrivacyLevel)
  privacyLevel?: PrivacyLevel = PrivacyLevel.PUBLIC;
}
