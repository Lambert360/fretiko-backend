import { IsNumber, IsString, IsOptional, IsBoolean, Min, Max } from 'class-validator';

export class AdminCreateGiftCardDto {
  @IsNumber()
  @Min(1)
  @Max(10000)
  amount: number;

  @IsString()
  design_id: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  quantity?: number = 1;

  @IsString()
  creation_reason: string;

  @IsOptional()
  @IsBoolean()
  is_commercial?: boolean = false;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  expiry_days?: number = 365;

  @IsOptional()
  @IsString()
  notes?: string;
}
