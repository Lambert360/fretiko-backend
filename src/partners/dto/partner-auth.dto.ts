import { IsString, IsNotEmpty, IsOptional, MinLength, MaxLength, Matches, IsEmail } from 'class-validator';

export class PartnerLoginDto {
  @IsString()
  @IsNotEmpty({ message: 'Username is required' })
  @MinLength(3, { message: 'Username must be at least 3 characters long' })
  @MaxLength(100, { message: 'Username cannot exceed 100 characters' })
  username: string;

  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password: string;
}

export class PartnerResetPasswordDto {
  @IsString()
  @IsOptional()
  username?: string;

  @IsString()
  @IsOptional()
  @MaxLength(64, { message: 'Token cannot exceed 64 characters' })
  token?: string;

  @IsString()
  @IsOptional()
  @MinLength(6, { message: 'New password must be at least 6 characters long' })
  @MaxLength(128, { message: 'New password cannot exceed 128 characters' })
  newPassword?: string;
}

export class PartnerChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  currentPassword: string;

  @IsString()
  @IsNotEmpty({ message: 'New password is required' })
  @MinLength(6, { message: 'New password must be at least 6 characters long' })
  @MaxLength(128, { message: 'New password cannot exceed 128 characters' })
  newPassword: string;
}

export class PartnerProfileUpdateDto {
  @IsString()
  @IsOptional()
  @MaxLength(255, { message: 'Contact name cannot exceed 255 characters' })
  contactPersonName?: string;

  @IsString()
  @IsOptional()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  contactEmail?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50, { message: 'Phone number cannot exceed 50 characters' })
  @Matches(/^[+]?[\d\s\-\(\)]+$/, { message: 'Please provide a valid phone number' })
  contactPhone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500, { message: 'Company website cannot exceed 500 characters' })
  @Matches(/^https?:\/\/.+/, { message: 'Please provide a valid URL starting with http:// or https://' })
  companyWebsite?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000, { message: 'Address cannot exceed 1000 characters' })
  headquartersAddress?: string;
}
