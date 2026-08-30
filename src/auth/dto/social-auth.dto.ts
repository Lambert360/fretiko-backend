import { IsString, IsOptional, IsNotEmpty, IsBoolean, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class SocialAuthDto {
  @ApiProperty({
    description: 'OAuth provider',
    enum: ['google', 'apple'],
    example: 'google',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(google|apple)$/, { message: 'Provider must be google or apple' })
  provider!: 'google' | 'apple';

  @ApiProperty({
    description: 'OAuth access token from provider',
    required: false,
    example: 'ya29.a0AfH6SMC...',
  })
  @IsString()
  @IsOptional()
  accessToken?: string;

  @ApiProperty({
    description: 'OAuth ID token from provider (JWT)',
    required: false,
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ij...',
  })
  @IsString()
  @IsOptional()
  idToken?: string;

  @ApiProperty({
    description: 'OAuth authorization code from provider (Google server-side flow)',
    required: false,
    example: '4/0Af...',
  })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiProperty({
    description: 'Redirect URI used to obtain the authorization code',
    required: false,
    example: 'fretiko:/oauth2redirect/google',
  })
  @IsString()
  @IsOptional()
  redirectUri?: string;

  @ApiProperty({
    description: 'First name from the provider',
    required: false,
    example: 'Jane',
  })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({
    description: 'Last name from the provider',
    required: false,
    example: 'Doe',
  })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({
    description: 'Terms and conditions accepted',
    required: false,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    return value;
  })
  hasAcceptedTerms?: boolean;

  @ApiProperty({
    description: 'User date of birth (optional for social)',
    required: false,
    example: '1990-01-01',
  })
  @IsString()
  @IsOptional()
  dateOfBirth?: string;

  @ApiProperty({
    description: 'User gender (optional for social)',
    required: false,
    example: 'female',
  })
  @IsString()
  @IsOptional()
  @Matches(/^(male|female|other|prefer_not_to_say)$/, { message: 'Invalid gender option' })
  gender?: string;

  @ApiProperty({
    description: 'User role (defaults to citizen)',
    required: false,
    example: 'citizen',
  })
  @IsString()
  @IsOptional()
  @Matches(/^(citizen|vendor|rider)$/, { message: 'Invalid role option' })
  user_role?: string;

  @ApiProperty({
    description: 'Whether the user wants to be a seller (vendor)',
    required: false,
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    return value;
  })
  is_seller?: boolean;

  @ApiProperty({
    description: 'Whether the user wants to be a rider',
    required: false,
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    return value;
  })
  is_rider?: boolean;

  @ApiProperty({
    description: 'Referral code from referral link',
    required: false,
    example: 'ABC123',
  })
  @IsString()
  @IsOptional()
  referralCode?: string;
}

export class SocialAuthResponse {
  @ApiProperty({
    description: 'Whether the operation was successful',
    example: true,
  })
  success!: boolean;

  @ApiProperty({
    description: 'Response message',
    example: 'Authentication successful',
  })
  message!: string;

  @ApiProperty({
    description: 'User data',
    required: false,
  })
  user?: {
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

  @ApiProperty({
    description: 'Access token',
    required: false,
  })
  accessToken?: string;

  @ApiProperty({
    description: 'Refresh token',
    required: false,
  })
  refreshToken?: string;

  @ApiProperty({
    description: 'ID token from the provider (returned with requiresProfile so the app can finalize)',
    required: false,
  })
  idToken?: string;

  @ApiProperty({
    description: 'Whether this is a new user signup',
    required: false,
  })
  isNewUser?: boolean;

  @ApiProperty({
    description: 'Whether user is suspended',
    required: false,
  })
  isSuspended?: boolean;

  @ApiProperty({
    description: 'Whether the user needs to complete their social profile',
    required: false,
  })
  requiresProfile?: boolean;
}

export class LinkSocialAccountDto {
  @ApiProperty({
    description: 'OAuth provider',
    enum: ['google', 'apple'],
    example: 'google',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(google|apple)$/, { message: 'Provider must be google or apple' })
  provider!: 'google' | 'apple';

  @ApiProperty({
    description: 'OAuth access token from provider',
    example: 'ya29.a0AfH6SMC...',
  })
  @IsString()
  @IsNotEmpty()
  accessToken!: string;

  @ApiProperty({
    description: 'OAuth ID token from provider (JWT)',
    required: false,
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ij...',
  })
  @IsString()
  @IsOptional()
  idToken?: string;
}

export class UnlinkSocialAccountDto {
  @ApiProperty({
    description: 'OAuth provider to unlink',
    enum: ['google', 'apple'],
    example: 'google',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(google|apple)$/, { message: 'Provider must be google or apple' })
  provider!: 'google' | 'apple';
}
