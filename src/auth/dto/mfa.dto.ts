import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class MfaSessionDto {
  @ApiProperty({ description: 'Supabase access token issued at sign-in, used only for MFA setup calls' })
  @IsString()
  @IsNotEmpty()
  supabaseAccessToken: string;

  @ApiProperty({ description: 'Supabase refresh token issued at sign-in, used only for MFA setup calls' })
  @IsString()
  @IsNotEmpty()
  supabaseRefreshToken: string;
}

export class MfaVerifyDto extends MfaSessionDto {
  @ApiProperty({ description: 'Factor ID returned from /auth/mfa/enroll' })
  @IsString()
  @IsNotEmpty()
  factorId: string;

  @ApiProperty({ description: '6-digit code from the authenticator app' })
  @IsString()
  @IsNotEmpty()
  code: string;
}

export class MfaUnenrollDto extends MfaSessionDto {
  @ApiProperty({ description: 'Factor ID to remove' })
  @IsString()
  @IsNotEmpty()
  factorId: string;
}

export class MfaLoginVerifyDto {
  @ApiProperty({ description: 'Supabase access token returned from /auth/signin when mfaRequired is true' })
  @IsString()
  @IsNotEmpty()
  supabaseAccessToken: string;

  @ApiProperty({ description: 'Supabase refresh token returned from /auth/signin when mfaRequired is true' })
  @IsString()
  @IsNotEmpty()
  supabaseRefreshToken: string;

  @ApiProperty({ description: 'Factor ID returned from /auth/signin when mfaRequired is true' })
  @IsString()
  @IsNotEmpty()
  factorId: string;

  @ApiProperty({ description: '6-digit code from the authenticator app, or a backup code if isBackupCode is true' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ description: 'Set to true if `code` is a backup/recovery code instead of a TOTP code', required: false })
  @IsBoolean()
  @IsOptional()
  isBackupCode?: boolean;

  @ApiProperty({ description: 'If true, issue a trusted-device token so this device skips MFA next time', required: false })
  @IsBoolean()
  @IsOptional()
  rememberDevice?: boolean;
}
