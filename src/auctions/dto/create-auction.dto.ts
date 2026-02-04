import { IsNotEmpty, IsString, IsNumber, IsOptional, IsEnum, IsArray, IsBoolean, Min, IsDateString, ValidateNested, ArrayNotEmpty } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { CreateAuctionItemDto } from './create-auction-item.dto';

/**
 * Custom validator to handle file uploads vs URL arrays
 */
const IsStringArrayOrUndefined = () => {
  return (target: any, propertyKey: string) => {
    // This field will be handled by the file upload interceptor
    // We'll skip validation for file uploads
    return IsOptional()(target, propertyKey);
  };
};

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

  // Media - For file uploads, images come through @UploadedFiles() decorator
  // This field is optional during creation and will be populated by the service
  @IsOptional()
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

  // Multi-item support for live auctions
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateAuctionItemDto)
  @Transform(({ value }) => {
    // Parse JSON string from FormData if needed
    if (typeof value === 'string') {
      try {
        console.log('🔍 DTO Transform - Raw string value:', value);
        const parsed = JSON.parse(value);
        console.log('🔍 DTO Transform - Parsed JSON:', parsed);
        
        if (Array.isArray(parsed)) {
          // Transform each plain object into CreateAuctionItemDto
          const transformed = parsed.map(item => {
            const dto = new CreateAuctionItemDto();
            Object.assign(dto, item);
            return dto;
          });
          console.log('🔍 DTO Transform - Transformed items:', transformed);
          return transformed;
        }
        return [];
      } catch (error) {
        console.error('🔍 DTO Transform - JSON parse error:', error);
        return [];
      }
    }
    return Array.isArray(value) ? value : [];
  })
  items?: CreateAuctionItemDto[];
}