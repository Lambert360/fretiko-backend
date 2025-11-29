import { IsNotEmpty, IsString, IsOptional, IsUUID, IsEnum, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum RecipientType {
  DEPARTMENT = 'department',
  STAFF = 'staff',
  ALL = 'all',
}

export enum MemoPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

export class MemoAttachmentDto {
  @IsString()
  type: string; // 'image', 'pdf', 'document'

  @IsString()
  url: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  size?: string;
}

export class SendMemoDto {
  @IsNotEmpty()
  @IsString()
  subject: string;

  @IsNotEmpty()
  @IsString()
  body: string;

  @IsEnum(RecipientType)
  recipientType: RecipientType;

  @IsOptional()
  @IsUUID()
  recipientId?: string; // Required if recipientType is 'department' or 'staff'

  @IsOptional()
  @IsEnum(MemoPriority)
  priority?: MemoPriority;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MemoAttachmentDto)
  attachments?: MemoAttachmentDto[];

  @IsOptional()
  @IsUUID()
  parentMemoId?: string; // For replies
}

export class MarkMemoReadDto {
  @IsUUID()
  memoId: string;
}

export class MemoResponseDto {
  id: string;
  subject: string;
  body: string;
  senderId: string;
  senderName: string;
  senderDepartmentId: string | null;
  senderDepartmentName: string | null;
  recipientType: RecipientType;
  recipientId: string | null;
  recipientName?: string; // Department name or staff name
  priority: MemoPriority;
  isRead: boolean;
  readAt: Date | null;
  readBy: string | null;
  attachments: MemoAttachmentDto[];
  parentMemoId: string | null;
  replies?: MemoResponseDto[]; // For threaded view
  replyCount?: number;
  createdAt: Date;
}

export class MemoListFilterDto {
  @IsOptional()
  @IsEnum(RecipientType)
  recipientType?: RecipientType;

  @IsOptional()
  @IsEnum(MemoPriority)
  priority?: MemoPriority;

  @IsOptional()
  @IsString()
  isRead?: string; // 'true' or 'false'

  @IsOptional()
  @IsString()
  search?: string; // Search in subject/body
}

export class MemoStatsDto {
  total: number;
  unread: number;
  urgent: number;
  byPriority: {
    low: number;
    normal: number;
    high: number;
    urgent: number;
  };
  byRecipientType: {
    department: number;
    staff: number;
    all: number;
  };
}
