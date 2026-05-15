import { IsOptional, IsInt, IsEnum, IsUUID, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { FeedItemType } from '../interfaces/post.interface';

export class FeedQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;

  @IsOptional()
  @IsEnum(FeedItemType)
  type?: FeedItemType;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class PaginationQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;
}
