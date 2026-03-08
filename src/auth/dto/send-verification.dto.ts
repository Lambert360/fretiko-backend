import { IsEmail, IsNotEmpty, IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendVerificationDto {
  @ApiProperty({
    description: 'Email address to send verification to',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'User ID for verification',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'IP address of the request',
    required: false,
  })
  @IsString()
  @IsOptional()
  ipAddress?: string;

  @ApiProperty({
    description: 'User agent string',
    required: false,
  })
  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class ResendVerificationDto {
  @ApiProperty({
    description: 'Email address to resend verification to',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'IP address of the request',
    required: false,
  })
  @IsString()
  @IsOptional()
  ipAddress?: string;

  @ApiProperty({
    description: 'User agent string',
    required: false,
  })
  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class VerifyEmailDto {
  @ApiProperty({
    description: 'Email verification token',
    example: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({
    description: 'User ID for verification',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'IP address of the request',
    required: false,
  })
  @IsString()
  @IsOptional()
  ipAddress?: string;

  @ApiProperty({
    description: 'User agent string',
    required: false,
  })
  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class CheckEmailAvailabilityDto {
  @ApiProperty({
    description: 'Email address to check availability for',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
