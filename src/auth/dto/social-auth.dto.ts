import { IsEmail, IsString, IsOptional, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SocialAuthDto {
  @ApiProperty({
    description: 'OAuth provider',
    enum: ['google', 'apple'],
    example: 'google',
  })
  @IsString()
  @IsNotEmpty()
  provider: 'google' | 'apple';

  @ApiProperty({
    description: 'OAuth access token from provider',
    example: 'ya29.a0AfH6SMC...',
  })
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @ApiProperty({
    description: 'OAuth ID token from provider (JWT)',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ij...',
  })
  @IsString()
  @IsOptional()
  idToken?: string;
}

export class SocialAuthResponse {
  @ApiProperty({
    description: 'Whether the operation was successful',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Response message',
    example: 'Authentication successful',
  })
  message: string;

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
    description: 'Whether this is a new user signup',
    required: false,
  })
  isNewUser?: boolean;

  @ApiProperty({
    description: 'Whether user is suspended',
    required: false,
  })
  isSuspended?: boolean;
}

export class LinkSocialAccountDto {
  @ApiProperty({
    description: 'OAuth provider',
    enum: ['google', 'apple'],
    example: 'google',
  })
  @IsString()
  @IsNotEmpty()
  provider: 'google' | 'apple';

  @ApiProperty({
    description: 'OAuth access token from provider',
    example: 'ya29.a0AfH6SMC...',
  })
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @ApiProperty({
    description: 'OAuth ID token from provider (JWT)',
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
  provider: 'google' | 'apple';
}
