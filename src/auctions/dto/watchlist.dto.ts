import { IsNotEmpty, IsString, IsOptional, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * DTO for watchlist operations
 */
export class WatchlistDto {
  @IsNotEmpty()
  @IsString()
  auction_id: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== false)
  notification_enabled?: boolean;
}