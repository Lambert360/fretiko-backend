import { IsEmail, IsNotEmpty, IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyTokenDto {
  @ApiProperty({
    description: '6-digit verification token sent to email',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({
    description: 'Email address for verification',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'IP address of verification request',
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

export class ResendTokenDto {
  @ApiProperty({
    description: 'Email address to resend verification token',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'IP address of resend request',
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
