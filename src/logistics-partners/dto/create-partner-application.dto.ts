import { 
  IsString, 
  IsEmail, 
  IsNotEmpty, 
  IsArray, 
  IsOptional, 
  IsEnum, 
  IsInt, 
  Min, 
  Max, 
  ValidateNested, 
  ArrayMinSize,
  IsUrl,
  IsObject,
  IsPhoneNumber,
  IsDateString,
  ArrayNotEmpty,
  MaxLength
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreatePartnerApplicationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  company_name: string;

  @IsOptional()
  @IsUrl()
  company_logo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  company_registration_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  tax_id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  contact_person_name: string;

  @IsEmail()
  @IsNotEmpty()
  contact_email: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contact_phone?: string;

  @IsOptional()
  @IsUrl()
  company_website?: string;

  @IsString()
  @IsNotEmpty()
  headquarters_address: string;

  @IsArray()
  @ArrayNotEmpty()
  service_areas: string[];

  @IsOptional()
  @IsObject()
  operating_hours?: Record<string, { start: string; end: string }>;

  @IsObject()
  @IsNotEmpty()
  vehicle_fleet: Record<string, {
    count: number;
    photos?: string[];
  }>;

  @IsOptional()
  @IsInt()
  @Min(0)
  total_riders?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  average_daily_deliveries?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  years_in_operation?: number;

  @IsOptional()
  @IsObject()
  insurance_coverage?: Record<string, any>;

  @IsOptional()
  @IsArray()
  service_categories?: string[];

  @IsOptional()
  @IsArray()
  registration_document_urls?: string[];

  @IsOptional()
  @IsArray()
  insurance_document_urls?: string[];

  @IsOptional()
  @IsArray()
  fleet_document_urls?: string[];
}

export class VerifyPartnerDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsObject()
  verification_details?: Record<string, any>;
}

export class RejectApplicationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  admin_notes?: string;
}

export class ApplicationFiltersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: 'in_progress' | 'under_review' | 'verified' | 'rejected';

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class PartnerFiltersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: 'active' | 'suspended' | 'terminated';

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
