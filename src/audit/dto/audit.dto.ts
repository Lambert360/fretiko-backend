import { IsNotEmpty, IsString, IsOptional, IsUUID, IsEnum, IsObject } from 'class-validator';

export enum AuditAction {
  // User actions
  SUSPEND_USER = 'suspend_user',
  UNSUSPEND_USER = 'unsuspend_user',
  DELETE_USER = 'delete_user',
  EDIT_USER = 'edit_user',

  // Content moderation
  APPROVE_PRODUCT = 'approve_product',
  REJECT_PRODUCT = 'reject_product',
  REMOVE_PRODUCT = 'remove_product',
  APPROVE_SERVICE = 'approve_service',
  REJECT_SERVICE = 'reject_service',
  REMOVE_SERVICE = 'remove_service',
  REMOVE_STORY = 'remove_story',
  END_LIVE_STREAM = 'end_live_stream',
  APPROVE_AUCTION = 'approve_auction',
  REJECT_AUCTION = 'reject_auction',

  // Disputes
  RESOLVE_DISPUTE = 'resolve_dispute',
  ESCALATE_DISPUTE = 'escalate_dispute',

  // Finance
  PROCESS_PAYOUT = 'process_payout',
  MANAGE_ESCROW = 'manage_escrow',
  PROCESS_REFUND = 'process_refund',

  // Logistics
  ASSIGN_DELIVERY = 'assign_delivery',
  MANAGE_RIDER = 'manage_rider',

  // Staff management
  CREATE_STAFF = 'create_staff',
  EDIT_STAFF = 'edit_staff',
  DELETE_STAFF = 'delete_staff',
  CHANGE_PASSWORD = 'change_password',

  // Department management
  CREATE_DEPARTMENT = 'create_department',
  EDIT_DEPARTMENT = 'edit_department',

  // Communication
  SEND_MEMO = 'send_memo',
  CREATE_REPORT = 'create_report',
  REVIEW_REPORT = 'review_report',

  // Other
  LOGIN = 'login',
  LOGOUT = 'logout',
  EXPORT_DATA = 'export_data',
  
  // Logistics partnership actions
  CREATE = 'create',
  UPDATE = 'update',
  VERIFY = 'verify',
  REJECT = 'reject',
}

export enum AuditEntityType {
  USER = 'user',
  PRODUCT = 'product',
  SERVICE = 'service',
  STORY = 'story',
  LIVE_STREAM = 'live_stream',
  AUCTION = 'auction',
  ORDER = 'order',
  DISPUTE = 'dispute',
  WALLET = 'wallet',
  ESCROW = 'escrow',
  RIDER = 'rider',
  DELIVERY = 'delivery',
  STAFF = 'staff',
  DEPARTMENT = 'department',
  MEMO = 'memo',
  REPORT = 'report',
  
  // Logistics partnership entities
  LOGISTICS_PARTNERSHIP = 'logistics_partnership',
  RIDER_VERIFICATION = 'rider_verification',
}

export enum AuditStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  PENDING = 'pending',
}

export class LogAuditDto {
  @IsNotEmpty()
  @IsUUID()
  staffId: string;

  @IsEnum(AuditAction)
  action: AuditAction;

  @IsEnum(AuditEntityType)
  entityType: AuditEntityType;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsObject()
  details?: any;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  userAgent?: string;

  @IsOptional()
  @IsEnum(AuditStatus)
  status?: AuditStatus;

  @IsOptional()
  @IsString()
  errorMessage?: string;
}

export class AuditLogResponseDto {
  id: string;
  staffId: string;
  staffName: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  details: any;
  ipAddress: string | null;
  userAgent: string | null;
  status: AuditStatus;
  errorMessage: string | null;
  createdAt: Date;
}

export class AuditLogFilterDto {
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @IsOptional()
  @IsEnum(AuditEntityType)
  entityType?: AuditEntityType;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsEnum(AuditStatus)
  status?: AuditStatus;

  @IsOptional()
  @IsString()
  startDate?: string; // ISO date string

  @IsOptional()
  @IsString()
  endDate?: string; // ISO date string
}

export class AuditStatsDto {
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  byAction: Record<string, number>;
  byEntityType: Record<string, number>;
  topStaff: Array<{
    staffId: string;
    staffName: string;
    actionCount: number;
  }>;
  recentActions: AuditLogResponseDto[];
}
