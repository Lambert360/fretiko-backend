import { IsOptional, IsString, IsArray, IsNumber, Min, Max, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';

export enum SearchType {
  ALL = 'all',
  PRODUCTS = 'products',
  SERVICES = 'services',
  PEOPLE = 'people',
  PROVIDERS = 'providers',
}

export class SearchQueryDto {
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsEnum(SearchType)
  type?: SearchType = SearchType.ALL;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => Array.isArray(value) ? value : value?.split(',') || [])
  tags?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : undefined)
  minPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : undefined)
  maxPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  @Transform(({ value }) => value ? parseFloat(value) : undefined)
  minRating?: number;

  @IsOptional()
  @IsString()
  sortBy?: 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'newest' | 'popular';

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => value ? parseInt(value) : 1)
  page?: number = 1;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => value ? parseInt(value) : 20)
  limit?: number = 20;
}

export class TrendingSearchDto {
  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  @Transform(({ value }) => value ? parseInt(value) : 10)
  limit?: number = 10;
}

export class FeaturedContentDto {
  @IsOptional()
  @IsEnum(SearchType)
  type?: SearchType;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  @Transform(({ value }) => value ? parseInt(value) : 10)
  limit?: number = 10;
}

export class SearchSuggestionsDto {
  @IsString()
  @Transform(({ value }) => value?.toLowerCase().trim())
  query: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  @Transform(({ value }) => value ? parseInt(value) : 5)
  limit?: number = 5;
}