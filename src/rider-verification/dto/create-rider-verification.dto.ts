import { 
  IsString, 
  IsNotEmpty, 
  IsOptional, 
  IsInt, 
  IsEmail,
  IsUrl,
  IsArray,
  MaxLength,
  Min,
  Max,
  IsObject,
  ArrayNotEmpty
} from 'class-validator';

export class CreateRiderVerificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  full_name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  country: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  vehicle_type: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicle_make?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicle_model?: string;

  @IsOptional()
  @IsInt()
  @Min(1900)
  vehicle_year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  license_plate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  company_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  company_name?: string;

  @IsOptional()
  @IsUrl()
  driver_license_url?: string;

  @IsOptional()
  @IsUrl()
  vehicle_registration_url?: string;

  @IsOptional()
  @IsUrl()
  insurance_document_url?: string;

  @IsOptional()
  @IsUrl()
  profile_photo_url?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  years_experience?: number;

  @IsOptional()
  @IsArray()
  previous_delivery_companies?: string[];
}

export class VerifyRiderDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsObject()
  verification_details?: Record<string, any>;
}

export class RejectRiderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  admin_notes?: string;
}

export class VerificationFiltersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: 'in_progress' | 'under_review' | 'verified' | 'rejected';

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class RiderFiltersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: 'active' | 'suspended' | 'terminated';

  @IsOptional()
  @IsString()
  company_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
