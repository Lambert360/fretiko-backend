import { IsString, IsOptional, IsBoolean, IsDateString, IsPhoneNumber, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Username must be 50 characters or less' })
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Bio must be 500 characters or less' })
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Location must be 100 characters or less' })
  location?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Date of birth must be a valid date' })
  dateOfBirth?: string;

  @IsOptional()
  @IsBoolean()
  isSeller?: boolean;

  @IsOptional()
  @IsBoolean()
  isRider?: boolean;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  bgPicUrl?: string;

  @IsOptional()
  preferences?: {
    notifications?: {
      email?: boolean;
      push?: boolean;
      sms?: boolean;
    };
    privacy?: {
      showEmail?: boolean;
      showPhone?: boolean;
      showLocation?: boolean;
    };
    shopping?: {
      currency?: string;
      language?: string;
    };
    primaryRole?: string;
    roleSelectedAt?: string;
  };
}

export class UserProfileResponse {
  id: string;
  username: string;
  bio?: string;
  avatarUrl?: string;
  bgPicUrl?: string;
  location?: string;
  phone?: string;
  dateOfBirth?: string;
  preferences?: any;
  isSeller: boolean;
  isRider: boolean;
  createdAt: string;
  updatedAt: string;
}

export class PublicProfileResponse {
  id: string;
  username: string;
  bio?: string;
  avatarUrl?: string;
  bgPicUrl?: string;
  location?: string;
  isSeller: boolean;
  isRider: boolean;
  createdAt: string;
}