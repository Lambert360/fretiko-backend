import { IsNotEmpty, IsString, IsNumber, IsOptional, IsEnum, IsArray, IsBoolean, Min, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * DTO for creating a new auction
 * Includes validation rules following NestJS best practices
 */
export class CreateAuctionDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsNotEmpty()
  @IsString()
  description: string;

  @IsOptional()
  @IsString()
  lot_number?: string;

  @IsNotEmpty()
  @IsString()
  category_id: string;

  // Pricing
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.01)
  @Transform(({ value }) => parseFloat(value))
  starting_price: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Transform(({ value }) => value ? parseFloat(value) : null)
  reserve_price?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.01)
  @Transform(({ value }) => value ? parseFloat(value) : 1.0)
  bid_increment?: number;

  // Auction Type & Timing
  @IsEnum(['timed', 'live'])
  auction_type: 'timed' | 'live';

  @IsNotEmpty()
  @IsDateString()
  start_time: string;

  @IsNotEmpty()
  @IsDateString()
  end_time: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  soft_close_enabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(60)
  @Transform(({ value }) => value ? parseInt(value) : 300)
  soft_close_extension?: number;

  // Media
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  video_url?: string;

  @IsOptional()
  @IsString()
  thumbnail_url?: string;

  // Live Auction Features
  @IsOptional()
  @IsString()
  stream_url?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== false)
  auctioneer_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== false)
  crowd_sounds_enabled?: boolean;
}