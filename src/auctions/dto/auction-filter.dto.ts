import { IsOptional, IsString, IsEnum, IsNumber, IsBoolean, IsNotEmpty, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * DTO for filtering and searching auctions
 */
export class AuctionFilterDto {
  // Search
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  category_id?: string;

  @IsOptional()
  @IsString()
  category_slug?: string;

  // Status filters
  @IsOptional()
  @IsEnum(['scheduled', 'active', 'ended', 'cancelled', 'sold'])
  status?: 'scheduled' | 'active' | 'ended' | 'cancelled' | 'sold';

  @IsOptional()
  @IsEnum(['timed', 'live'])
  auction_type?: 'timed' | 'live';

  // Price filters
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : null)
  min_price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : null)
  max_price?: number;

  // Time filters
  @IsOptional()
  @IsEnum(['ending_soon', 'just_started', 'upcoming'])
  time_filter?: 'ending_soon' | 'just_started' | 'upcoming';

  // Sorting
  @IsOptional()
  @IsEnum(['price_asc', 'price_desc', 'time_asc', 'time_desc', 'bids_desc', 'created_desc'])
  sort?: 'price_asc' | 'price_desc' | 'time_asc' | 'time_desc' | 'bids_desc' | 'created_desc';

  // Pagination
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => value ? parseInt(value) : 20)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => value ? parseInt(value) : 0)
  offset?: number;

  // Special filters
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  featured_only?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  no_reserve?: boolean;

  @IsOptional()
  @IsString()
  seller_id?: string;
}

