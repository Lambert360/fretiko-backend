import { IsString, IsEnum, IsOptional, IsNumber, IsInt, IsUUID, IsArray, ArrayMinSize, ValidateNested, IsPositive, Min, Max, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for creating a new virtual gift (Admin only)
 */
export class CreateGiftDto {
  @IsString()
  name: string;

  @IsString()
  emoji: string;

  @IsNumber()
  @IsPositive()
  credit_value: number;

  @IsOptional()
  @IsNumber()
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

/**
 * DTO for updating a virtual gift (Admin only)
 */
export class UpdateGiftDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  emoji?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  credit_value?: number;

  @IsOptional()
  @IsNumber()
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

/**
 * DTO for purchasing gifts
 */
export class GiftPurchaseItem {
  @IsUUID()
  gift_id: string;

  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(100)
  quantity: number;
}

export class PurchaseGiftsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GiftPurchaseItem)
  purchases: GiftPurchaseItem[];
}

/**
 * DTO item for converting a specific quantity of a gift
 */
export class ConvertGiftItemDto {
  @IsUUID()
  user_gift_id: string; // user_gifts.id

  @IsInt()
  @Min(1)
  quantity: number; // How many to convert (must be <= user's current quantity)
}

/**
 * DTO for converting gifts to credits
 */
export class ConvertGiftsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConvertGiftItemDto)
  gifts: ConvertGiftItemDto[]; // Array of { user_gift_id, quantity }
}

/**
 * DTO for sending a gift in a call/stream/auction
 */
export class SendGiftDto {
  @IsUUID()
  gift_id: string; // virtual_gifts.id

  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(10)
  quantity: number;

  @IsUUID()
  recipient_id: string;

  @IsEnum(['call', 'stream', 'auction'])
  session_type: 'call' | 'stream' | 'auction';

  @IsUUID()
  session_id: string;

  @IsOptional()
  @IsString()
  message?: string;
}

/**
 * Response DTOs
 */
export interface PurchaseGiftsResponse {
  success: boolean;
  transaction_id: string;
  total_cost: number;
  gifts_added: Array<{
    gift_id: string;
    gift_name: string;
    quantity: number;
  }>;
  new_wallet_balance: number;
}

export interface ConvertGiftsResponse {
  success: boolean;
  transaction_id: string;
  total_value: number;
  user_credit: number; // 80% of total value
  platform_fee: number; // 20% of total value
  new_wallet_balance: number;
  gifts_converted: Array<{
    gift_id: string;
    gift_name: string;
    quantity: number;
  }>;
}

export interface UserGiftsResponse {
  gifts: Array<{
    id: string; // user_gifts.id
    gift_id: string;
    gift_name: string;
    emoji: string;
    quantity: number;
    total_value: number;
    source: string;
    received_at: string;
  }>;
  total_gifts: number;
  total_value: number;
}

