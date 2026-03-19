import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsNotEmpty } from 'class-validator';

export class AdminForgotPasswordDto {
  @ApiProperty({
    description: 'Email address for admin password reset',
    example: 'admin@fretiko.com',
  })
  @IsEmail()
  @IsString()
  @IsNotEmpty()
  email: string;
}

export class AdminConfirmResetPasswordDto {
  @ApiProperty({
    description: 'Email address for admin password reset',
    example: 'admin@fretiko.com',
  })
  @IsEmail()
  @IsString()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: '6-digit reset token sent to email',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({
    description: 'New password for admin account',
    example: 'NewSecurePassword123!',
  })
  @IsString()
  @IsNotEmpty()
  newPassword: string;
}
