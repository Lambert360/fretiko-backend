import { IsEmail, IsString, MinLength, IsOptional, IsBoolean, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

// These are the data shapes that flow between your frontend and backend
// Think of them as forms that must be filled out correctly

export class SignUpDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @MaxLength(255, { message: 'Email address is too long' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password is too long' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  })
  @IsNotEmpty({ message: 'Password is required' })
  password: string;

  @IsString()
  @MinLength(2, { message: 'First name must be at least 2 characters long' })
  @MaxLength(50, { message: 'First name is too long' })
  @Matches(/^[a-zA-Z\s'-]+$/, { message: 'First name can only contain letters, spaces, hyphens and apostrophes' })
  @IsNotEmpty({ message: 'First name is required' })
  firstName: string;

  @IsString()
  @MinLength(2, { message: 'Last name must be at least 2 characters long' })
  @MaxLength(50, { message: 'Last name is too long' })
  @Matches(/^[a-zA-Z\s'-]+$/, { message: 'Last name can only contain letters, spaces, hyphens and apostrophes' })
  @IsNotEmpty({ message: 'Last name is required' })
  lastName: string;

  @IsString()
  @IsOptional()
  dateOfBirth?: string;

  @IsOptional()
  @Transform(({ value }) => {
    console.log('🔍 Transform input:', value, 'type:', typeof value);
    // Handle string "true"/"false" values
    if (typeof value === 'string') {
      const result = value.toLowerCase() === 'true';
      console.log('🔍 Transform string result:', result);
      return result;
    }
    console.log('🔍 Transform non-string result:', value);
    return value;
  })
  hasAcceptedTerms: boolean;

  @IsString()
  @IsOptional()
  @Matches(/^(male|female|other|prefer_not_to_say)$/, { message: 'Invalid gender option' })
  gender?: string;
}

export class SignInDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @MaxLength(255, { message: 'Email address is too long' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password is too long' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  })
  @IsNotEmpty({ message: 'Password is required' })
  password: string;
}

export class MigrateAccountDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @MaxLength(255, { message: 'Email address is too long' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password is too long' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number'
  })
  @IsNotEmpty({ message: 'New password is required' })
  newPassword: string;
}

export class AuthResponse {
  user: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    avatar_url?: string;
    user_role?: string;
    is_seller?: boolean;
    is_rider?: boolean;
    is_verified?: boolean;
  };
  accessToken: string;
  refreshToken: string;
  isSuspended?: boolean; // Industry standard: allow suspended users to authenticate
  requiresEmailVerification?: boolean; // New flag for email verification requirement
}