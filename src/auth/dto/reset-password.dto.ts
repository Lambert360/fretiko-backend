import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsNotEmpty } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Email address for password reset',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsString()
  @IsNotEmpty()
  email: string;
}
