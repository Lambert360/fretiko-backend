import { IsString, IsOptional, IsEnum, IsBoolean, MaxLength, MinLength, ValidateNested, IsArray, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { PrivacyLevel, MediaType } from '../interfaces/post.interface';
import { PostMediaDto } from './create-post.dto';

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content?: string;

  @IsOptional()
  @IsEnum(PrivacyLevel)
  privacyLevel?: PrivacyLevel;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  @ArrayMaxSize(10)
  media?: PostMediaDto[];

  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;
}
