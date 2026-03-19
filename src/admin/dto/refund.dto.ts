import { IsEnum, IsString, IsOptional, IsNumber, Min } from 'class-validator';

/**
 * Refund Type Enum
 */
export enum RefundType {
  FULL = 'full',
  PARTIAL = 'partial',
  RELEASE = 'release',
}

/**
 * Refund Request DTO
 */
export class RefundRequestDto {
  @IsEnum(RefundType)
  type: RefundType;

  @IsString()
  reason: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  riderEarnings?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  vendorAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  platformFee?: number;
}
