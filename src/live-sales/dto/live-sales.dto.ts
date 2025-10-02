import { IsString, IsEnum, IsOptional, IsNumber, IsUUID, IsArray, ValidateNested, IsPositive, IsDateString, MinLength, MaxLength, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';

export enum StreamType {
  PRODUCTS = 'products',
  SERVICES = 'services',
}

export enum StreamStatus {
  SETUP = 'setup',
  LIVE = 'live',
  ENDED = 'ended',
  PAUSED = 'paused',
}

export enum ReactionType {
  LIKE = 'like',
  HEART = 'heart',
  FIRE = 'fire',
  CLAP = 'clap',
}

export enum TransactionType {
  PRODUCT = 'product',
  SERVICE = 'service',
  GIFT = 'gift',
}

export enum TransactionStatus {
  PENDING = 'pending',
  PAID = 'paid',
  ESCROW = 'escrow',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

// DTO for creating a new live stream
export class CreateLiveStreamDto {
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsEnum(StreamType)
  stream_type: StreamType;

  @IsOptional()
  @IsString()
  thumbnail_url?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LiveStreamProductDto)
  products?: LiveStreamProductDto[];
}

// DTO for adding products to a live stream
export class LiveStreamProductDto {
  @IsUUID()
  product_id: string;

  @IsNumber()
  @IsPositive()
  live_price: number;

  @IsNumber()
  @IsPositive()
  live_stock: number;

  @IsOptional()
  @IsNumber()
  display_order?: number;

  @IsOptional()
  @IsBoolean()
  is_featured?: boolean;
}

// DTO for updating live stream status
export class UpdateStreamStatusDto {
  @IsEnum(StreamStatus)
  status: StreamStatus;

  @IsOptional()
  @IsString()
  stream_url?: string;
}

// DTO for posting a comment
export class PostCommentDto {
  @IsUUID()
  stream_id: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message: string;
}

// DTO for sending a reaction
export class SendReactionDto {
  @IsUUID()
  stream_id: string;

  @IsEnum(ReactionType)
  reaction_type: ReactionType;
}

// DTO for sending a gift
export class SendGiftDto {
  @IsUUID()
  stream_id: string;

  @IsString()
  gift_type: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  message?: string;
}

// DTO for live product purchase
export class LiveProductPurchaseDto {
  @IsUUID()
  stream_id: string;

  @IsUUID()
  product_id: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @IsBoolean()
  continue_watching?: boolean; // true = instant wallet debit, false = checkout

  @IsOptional()
  @IsString()
  checkout_option?: string; // 'continue_watching' or 'checkout'

  @IsOptional()
  @IsUUID()
  rider_id?: string;

  @IsOptional()
  delivery_address?: any; // JSON object for delivery details
}

// DTO for live service booking
export class LiveServiceBookingDto {
  @IsUUID()
  stream_id: string;

  @IsDateString()
  service_date: string;

  @IsString()
  service_time: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  service_notes?: string;

  @IsOptional()
  @IsBoolean()
  continue_watching?: boolean;
}

// DTO for joining a stream
export class JoinStreamDto {
  @IsUUID()
  stream_id: string;
}

// DTO for leaving a stream
export class LeaveStreamDto {
  @IsUUID()
  stream_id: string;
}

// Response DTOs
export interface LiveStreamResponse {
  id: string;
  vendor_id: string;
  vendor: {
    id: string;
    username: string;
    profile_pic_url?: string;
    is_verified?: boolean;
  };
  title: string;
  description?: string;
  stream_type: StreamType;
  status: StreamStatus;
  viewer_count: number;
  total_viewers: number;
  total_sales: number;
  thumbnail_url?: string;
  stream_url?: string;
  products?: LiveStreamProductResponse[];
  started_at?: string;
  ended_at?: string;
  created_at: string;
}

export interface LiveStreamProductResponse {
  id: string;
  product_id: string;
  product: {
    id: string;
    name: string;
    primary_image_url?: string;
    category_name?: string;
  };
  live_price: number;
  live_stock: number;
  original_stock: number;
  sold_count: number;
  display_order: number;
  is_featured: boolean;
}

export interface LiveStreamStatsResponse {
  id: string;
  vendor_id: string;
  title: string;
  stream_type: StreamType;
  status: StreamStatus;
  viewer_count: number;
  total_viewers: number;
  total_sales: number;
  current_viewers: number;
  total_comments: number;
  total_reactions: number;
  total_gifts: number;
  total_gift_value: number;
  created_at: string;
  started_at?: string;
}

export interface CommentResponse {
  id: string;
  user: {
    id: string;
    username: string;
    profile_pic_url?: string;
  };
  message: string;
  is_pinned: boolean;
  created_at: string;
}

export interface GiftTypeResponse {
  id: string;
  name: string;
  display_name: string;
  icon_name: string;
  base_value: number;
  color: string;
  animation_type?: string;
}

export interface TransactionResponse {
  id: string;
  stream_id: string;
  transaction_type: TransactionType;
  total_amount: number;
  status: TransactionStatus;
  product?: {
    id: string;
    name: string;
    quantity: number;
    unit_price: number;
  };
  service?: {
    date: string;
    time: string;
    notes?: string;
  };
  rider?: {
    id: string;
    username: string;
  };
  created_at: string;
}