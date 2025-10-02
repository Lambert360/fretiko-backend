import { IsString, IsNumber, IsOptional, IsArray, IsBoolean, IsEnum, Min, Max, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateProductDto {
  @IsString()
  name: string;

  @IsString()
  description: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsNumber()
  @Min(0)
  quantity: number;

  @IsEnum(['new', 'like-new', 'good', 'fair'])
  condition: string;

  @IsUUID()
  category_id: string;

  @IsArray()
  @IsString({ each: true })
  images: string[];

  @IsOptional()
  @IsString()
  primary_image_url?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  shipping_options?: {
    pickup: boolean;
    delivery: boolean;
    shipping: boolean;
  };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsEnum(['new', 'like-new', 'good', 'fair'])
  condition?: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  shipping_options?: {
    pickup: boolean;
    delivery: boolean;
    shipping: boolean;
  };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(['draft', 'active', 'sold', 'inactive'])
  status?: string;
}

export class ProductQueryDto {
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsNumber()
  @Min(0)
  offset?: number = 0;
}

export class ProductResponseDto {
  id: string;
  user_id: string;
  category_id: string;
  name: string;
  description: string;
  price: number;
  quantity: number;
  condition: string;
  images: string[];
  primary_image_url?: string;
  location?: string;
  shipping_options: any;
  tags: string[];
  status: string;
  is_featured: boolean;
  view_count: number;
  like_count: number;
  save_count: number;
  average_rating?: number;
  review_count?: number;
  created_at: string;
  updated_at: string;
}

export class ProductCategoryDto {
  id: string;
  name: string;
  description?: string;
  icon_name?: string;
  color_hex?: string;
  sort_order: number;
  is_active: boolean;
}