import { IsString, IsNumber, IsBoolean, IsOptional, IsArray, IsEnum, IsObject, Min, Max, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// Vehicle Types
export enum VehicleType {
  WHEELBARROW = 'wheelbarrow',
  BIKE = 'bike',
  CAR = 'car',
  VAN = 'van',
  TRUCK = 'truck',
}

export enum VehicleCondition {
  EXCELLENT = 'excellent',
  GOOD = 'good',
  FAIR = 'fair',
}

export enum ProfileStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

// Service Pricing DTOs
export class ServiceCategoryPricingDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(100)
  base_price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(50)
  per_km_rate?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(500)
  custom_price?: number | null;
}

export class ServicePricingDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceCategoryPricingDto)
  intracity?: ServiceCategoryPricingDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceCategoryPricingDto)
  intercity?: ServiceCategoryPricingDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceCategoryPricingDto)
  interstate?: ServiceCategoryPricingDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceCategoryPricingDto)
  express?: ServiceCategoryPricingDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceCategoryPricingDto)
  cargo?: ServiceCategoryPricingDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceCategoryPricingDto)
  shipping?: ServiceCategoryPricingDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceCategoryPricingDto)
  food?: ServiceCategoryPricingDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceCategoryPricingDto)
  grocery?: ServiceCategoryPricingDto;
}

// Operating Hours DTO
export class DayScheduleDto {
  @IsString()
  start: string; // HH:MM format

  @IsString()
  end: string; // HH:MM format
}

export class OperatingHoursDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => DayScheduleDto)
  monday?: DayScheduleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DayScheduleDto)
  tuesday?: DayScheduleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DayScheduleDto)
  wednesday?: DayScheduleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DayScheduleDto)
  thursday?: DayScheduleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DayScheduleDto)
  friday?: DayScheduleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DayScheduleDto)
  saturday?: DayScheduleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DayScheduleDto)
  sunday?: DayScheduleDto;
}

// Vehicle Info DTO
export class VehicleInfoDto {
  @IsEnum(VehicleType)
  vehicle_type: VehicleType;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  vehicle_make?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  vehicle_model?: string;

  @IsOptional()
  @IsNumber()
  @Min(1900)
  @Max(2100)
  vehicle_year?: number;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  vehicle_color?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  license_plate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  vehicle_capacity_weight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  vehicle_capacity_volume?: number;

  @IsOptional()
  @IsEnum(VehicleCondition)
  vehicle_condition?: VehicleCondition;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vehicle_photos?: string[];
}

// Create Rider Profile DTO
export class CreateRiderProfileDto {
  @IsEnum(VehicleType)
  vehicle_type: VehicleType;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  vehicle_make?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  vehicle_model?: string;

  @IsOptional()
  @IsNumber()
  @Min(1900)
  @Max(2100)
  vehicle_year?: number;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  vehicle_color?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  license_plate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  vehicle_capacity_weight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  vehicle_capacity_volume?: number;

  @IsOptional()
  @IsEnum(VehicleCondition)
  vehicle_condition?: VehicleCondition;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vehicle_photos?: string[];

  @IsOptional()
  @IsObject()
  service_pricing?: ServicePricingDto;

  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(120)
  promised_delivery_time?: number;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  delivery_promise_message?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  max_delivery_distance?: number;

  @IsOptional()
  @IsObject()
  operating_hours?: OperatingHoursDto;
}

// Update Rider Profile DTO
export class UpdateRiderProfileDto {
  @IsOptional()
  @IsEnum(VehicleType)
  vehicle_type?: VehicleType;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  vehicle_make?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  vehicle_model?: string;

  @IsOptional()
  @IsNumber()
  @Min(1900)
  @Max(2100)
  vehicle_year?: number;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  vehicle_color?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  license_plate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  vehicle_capacity_weight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  vehicle_capacity_volume?: number;

  @IsOptional()
  @IsEnum(VehicleCondition)
  vehicle_condition?: VehicleCondition;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vehicle_photos?: string[];

  @IsOptional()
  @IsObject()
  service_pricing?: ServicePricingDto;

  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(120)
  promised_delivery_time?: number;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  delivery_promise_message?: string;

  @IsOptional()
  @IsBoolean()
  is_available?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  max_delivery_distance?: number;

  @IsOptional()
  @IsObject()
  operating_hours?: OperatingHoursDto;

  @IsOptional()
  @IsEnum(ProfileStatus)
  profile_status?: ProfileStatus;
}

// Toggle Online Status DTO
export class ToggleOnlineStatusDto {
  @IsBoolean()
  is_online: boolean;
}

// Upload Photos DTO
export class UploadPhotosDto {
  @IsArray()
  @IsString({ each: true })
  @Length(1, 5, { each: true })
  photos: string[];
}

