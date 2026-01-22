import { IsNotEmpty, IsString, IsNumber, IsOptional, IsArray, Min } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * DTO for creating a new auction item during a live auction
 * Allows hosts to add items on-the-fly
 */
export class CreateAuctionItemDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  lot_number?: string;

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

  // Timing
  @IsOptional()
  @IsNumber()
  @Min(30) // Minimum 30 seconds
  @Transform(({ value }) => value ? parseInt(value) : 120)
  bidding_duration?: number; // Default 120 seconds (2 minutes)

  // Media
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];
}

