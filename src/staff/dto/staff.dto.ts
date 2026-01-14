import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, IsEnum, MinLength, IsBoolean } from 'class-validator';

export enum StaffRole {
  SUPER_ADMIN = 'super_admin',
  DEPARTMENT_HEAD = 'department_head',
  STAFF = 'staff',
}

export class StaffLoginDto {
  @IsNotEmpty()
  @IsString()
  staffIdOrEmail: string; // Can be staff_id or email

  @IsNotEmpty()
  @IsString()
  password: string;
}

export class CreateStaffDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  password: string; // Will be hashed before storage

  @IsNotEmpty()
  @IsString()
  fullName: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsEnum(StaffRole)
  role: StaffRole;
}

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ModifyStaffDto {
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;
}

export class UpdateMyProfileDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class ChangePasswordDto {
  @IsNotEmpty()
  @IsString()
  currentPassword: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  newPassword: string;
}

export class StaffResponseDto {
  id: string;
  staffId: string;
  email: string;
  fullName: string;
  departmentId: string | null;
  departmentName?: string;
  departmentPermissions?: string[];
  role: StaffRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
  isSuspended?: boolean;
  suspendedAt?: Date | null;
  suspendedBy?: string | null;
  suspensionReason?: string | null;
  deletedAt?: Date | null;
  avatarUrl?: string | null;
}

export class SuspendStaffDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class DeleteStaffDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class StaffLoginResponseDto {
  accessToken: string;
  refreshToken: string;
  staff: StaffResponseDto;
}
