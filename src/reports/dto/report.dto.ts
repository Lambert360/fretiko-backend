import { IsNotEmpty, IsString, IsOptional, IsUUID, IsEnum, IsArray, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum ReportType {
  INCIDENT = 'incident',
  PERFORMANCE = 'performance',
  FINANCIAL = 'financial',
  USER_ACTIVITY = 'user_activity',
  OPERATIONAL = 'operational',
  OTHER = 'other',
}

export enum ReportVisibility {
  DEPARTMENT = 'department',
  ESCALATED = 'escalated',
  ALL = 'all',
}

export enum ReportStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  UNDER_REVIEW = 'under_review',
  REVIEWED = 'reviewed',
  ARCHIVED = 'archived',
}

export enum ReportPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export class ReportAttachmentDto {
  @IsString()
  type: string;

  @IsString()
  url: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  size?: string;
}

export class CreateReportDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsEnum(ReportType)
  reportType: ReportType;

  @IsNotEmpty()
  @IsString()
  content: string;

  @IsOptional()
  @IsObject()
  data?: any; // Structured data (charts, tables, etc.)

  @IsOptional()
  @IsEnum(ReportVisibility)
  visibility?: ReportVisibility;

  @IsOptional()
  @IsEnum(ReportPriority)
  priority?: ReportPriority;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportAttachmentDto)
  attachments?: ReportAttachmentDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateReportDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsEnum(ReportType)
  reportType?: ReportType;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsObject()
  data?: any;

  @IsOptional()
  @IsEnum(ReportVisibility)
  visibility?: ReportVisibility;

  @IsOptional()
  @IsEnum(ReportPriority)
  priority?: ReportPriority;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportAttachmentDto)
  attachments?: ReportAttachmentDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class ReviewReportDto {
  @IsEnum(ReportStatus)
  status: ReportStatus; // 'under_review' or 'reviewed'

  @IsOptional()
  @IsString()
  reviewNotes?: string;
}

export class ReportResponseDto {
  id: string;
  reportNumber: string;
  title: string;
  reportType: ReportType;
  content: string;
  data: any;
  createdBy: string;
  createdByName: string;
  departmentId: string | null;
  departmentName: string | null;
  visibility: ReportVisibility;
  status: ReportStatus;
  priority: ReportPriority;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  attachments: ReportAttachmentDto[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
}

export class ReportListFilterDto {
  @IsOptional()
  @IsEnum(ReportType)
  reportType?: ReportType;

  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @IsOptional()
  @IsEnum(ReportVisibility)
  visibility?: ReportVisibility;

  @IsOptional()
  @IsEnum(ReportPriority)
  priority?: ReportPriority;

  @IsOptional()
  @IsString()
  createdBy?: string; // Filter by creator

  @IsOptional()
  @IsString()
  departmentId?: string; // Filter by department

  @IsOptional()
  @IsString()
  search?: string; // Search in title/content

  @IsOptional()
  @IsString()
  tag?: string; // Filter by tag
}

export class ReportStatsDto {
  total: number;
  byStatus: {
    draft: number;
    submitted: number;
    under_review: number;
    reviewed: number;
    archived: number;
  };
  byType: {
    incident: number;
    performance: number;
    financial: number;
    user_activity: number;
    operational: number;
    other: number;
  };
  byPriority: {
    low: number;
    normal: number;
    high: number;
    critical: number;
  };
  pendingReview: number;
}
