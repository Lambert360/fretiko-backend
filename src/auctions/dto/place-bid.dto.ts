import { IsNotEmpty, IsString, IsNumber, IsOptional, IsEnum, Min } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * DTO for placing a bid on an auction
 */
export class PlaceBidDto {
  @IsNotEmpty()
  @IsString()
  auction_id: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.01)
  @Transform(({ value }) => parseFloat(value))
  amount: number;

  @IsOptional()
  @IsEnum(['manual', 'proxy'])
  bid_type?: 'manual' | 'proxy';

  // For proxy bidding - maximum amount willing to bid
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.01)
  @Transform(({ value }) => value ? parseFloat(value) : null)
  max_bid_amount?: number;
}

/**
 * DTO for updating proxy bid settings
 */
export class UpdateProxyBidDto {
  @IsNotEmpty()
  @IsString()
  auction_id: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.01)
  @Transform(({ value }) => parseFloat(value))
  max_bid_amount: number;
}