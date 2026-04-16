import { IsString, IsOptional, IsArray, IsBoolean, IsEnum, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export enum BlogPostStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

export class CreateBlogPostDto {
  @ApiProperty({ description: 'Blog post title' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Blog post content' })
  @IsString()
  content: string;

  @ApiProperty({ description: 'Blog post excerpt' })
  @IsString()
  excerpt: string;

  @ApiPropertyOptional({ description: 'Author name' })
  @IsString()
  @IsOptional()
  author?: string;

  @ApiPropertyOptional({ description: 'Publication status', enum: BlogPostStatus })
  @IsEnum(BlogPostStatus)
  @IsOptional()
  status?: BlogPostStatus;

  @ApiProperty({ description: 'URL-friendly slug' })
  @IsString()
  slug: string;

  @ApiPropertyOptional({ description: 'Array of tags' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ description: 'Featured image URL' })
  @IsString()
  @IsOptional()
  featuredImageUrl?: string;

  @ApiPropertyOptional({ description: 'Estimated reading time in minutes' })
  @IsNumber()
  @IsOptional()
  readingTime?: number;
}

export class UpdateBlogPostDto {
  @ApiPropertyOptional({ description: 'Blog post title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Blog post content' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: 'Blog post excerpt' })
  @IsString()
  @IsOptional()
  excerpt?: string;

  @ApiPropertyOptional({ description: 'Author name' })
  @IsString()
  @IsOptional()
  author?: string;

  @ApiPropertyOptional({ description: 'Publication status', enum: BlogPostStatus })
  @IsEnum(BlogPostStatus)
  @IsOptional()
  status?: BlogPostStatus;

  @ApiPropertyOptional({ description: 'URL-friendly slug' })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiPropertyOptional({ description: 'Array of tags' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ description: 'Featured image URL' })
  @IsString()
  @IsOptional()
  featuredImageUrl?: string;

  @ApiPropertyOptional({ description: 'Estimated reading time in minutes' })
  @IsNumber()
  @IsOptional()
  readingTime?: number;
}

export class BlogPostQueryDto {
  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsEnum(BlogPostStatus)
  @IsOptional()
  status?: BlogPostStatus;

  @ApiPropertyOptional({ description: 'Filter by author' })
  @IsString()
  @IsOptional()
  author?: string;

  @ApiPropertyOptional({ description: 'Filter by tags' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

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
}
