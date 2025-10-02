/**
 * FRETIKO NOTIFICATIONS - Data Transfer Objects
 * Handles validation and typing for notification API requests/responses
 */

import { IsString, IsUUID, IsEnum, IsOptional, IsBoolean, IsArray, ValidateNested, IsDateString, IsObject, IsIn } from 'class-validator';
import { Type, Transform } from 'class-transformer';

// ============================================
// ENUMS - Match database constraints and frontend
// ============================================
export enum NotificationType {
  ORDER = 'order',
  SOCIAL = 'social',
  PROMOTION = 'promotion',
  SYSTEM = 'system',
  DELIVERY = 'delivery',
  LIVE = 'live',
  PAYMENT = 'payment',
  CHAT = 'chat',
  AI_CHECKIN = 'ai_checkin',
  AI_REMINDER = 'ai_reminder',
  AI_ENGAGEMENT = 'ai_engagement'
}

export enum NotificationPriority {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low'
}

export enum ActionButtonType {
  PRIMARY = 'primary',
  SECONDARY = 'secondary'
}

// ============================================
// NESTED DTOs
// ============================================
export class ActionButtonDto {
  @IsString()
  label: string;

  @IsEnum(ActionButtonType)
  type: ActionButtonType;
}

// ============================================
// CREATE NOTIFICATION DTO
// ============================================
export class CreateNotificationDto {
  @IsUUID()
  user_id: string;

  @IsEnum(NotificationType)
  type: NotificationType;

  @IsString()
  title: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, any>;

  @IsOptional()
  @IsString()
  avatar_url?: string;

  @IsOptional()
  @IsString()
  badge?: string;

  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @IsOptional()
  @IsBoolean()
  has_actions?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ActionButtonDto)
  action_buttons?: ActionButtonDto[];

  @IsOptional()
  @IsDateString()
  expires_at?: string;
}

// ============================================
// UPDATE NOTIFICATION DTO
// ============================================
export class UpdateNotificationDto {
  @IsOptional()
  @IsBoolean()
  is_read?: boolean;

  @IsOptional()
  @IsBoolean()
  is_deleted?: boolean;
}

// ============================================
// BULK UPDATE DTO
// ============================================
export class BulkUpdateNotificationsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  notification_ids: string[];

  @IsOptional()
  @IsBoolean()
  is_read?: boolean;

  @IsOptional()
  @IsBoolean()
  is_deleted?: boolean;
}

// ============================================
// NOTIFICATION QUERY/FILTER DTO
// ============================================
export class NotificationQueryDto {
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  is_read?: boolean;

  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @IsOptional()
  @IsString()
  limit?: string = '50';

  @IsOptional()
  @IsString()
  offset?: string = '0';

  @IsOptional()
  @IsIn(['created_at', 'priority', 'type'])
  sort_by?: string = 'created_at';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort_order?: string = 'desc';
}

// ============================================
// NOTIFICATION SETTINGS DTO
// ============================================
export class UpdateNotificationSettingsDto {
  @IsOptional()
  @IsBoolean()
  push_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  email_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  in_app_enabled?: boolean;

  // Type-specific preferences
  @IsOptional()
  @IsBoolean()
  order_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  social_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  promotion_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  system_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  delivery_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  live_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  payment_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  chat_notifications?: boolean;

  // Quiet hours
  @IsOptional()
  @IsBoolean()
  quiet_hours_enabled?: boolean;

  @IsOptional()
  @IsString()
  quiet_start_time?: string;

  @IsOptional()
  @IsString()
  quiet_end_time?: string;

  @IsOptional()
  @IsString()
  quiet_timezone?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  expo_push_tokens?: string[];
}

// ============================================
// RESPONSE DTOs
// ============================================
export class NotificationResponseDto {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, any>;
  avatar_url?: string;
  badge?: string;
  priority: NotificationPriority;
  is_read: boolean;
  is_deleted: boolean;
  has_actions: boolean;
  action_buttons?: ActionButtonDto[];
  created_at: Date;
  updated_at: Date;
  expires_at?: Date;
}

export class NotificationStatsResponseDto {
  total_notifications: number;
  unread_count: number;
  unread_orders: number;
  unread_social: number;
  unread_live: number;
  unread_delivery: number;
  unread_payment: number;
  unread_chat: number;
  latest_notification_at?: Date;
}

export class NotificationSettingsResponseDto {
  id: string;
  user_id: string;
  push_enabled: boolean;
  email_enabled: boolean;
  in_app_enabled: boolean;
  order_notifications: boolean;
  social_notifications: boolean;
  promotion_notifications: boolean;
  system_notifications: boolean;
  delivery_notifications: boolean;
  live_notifications: boolean;
  payment_notifications: boolean;
  chat_notifications: boolean;
  quiet_hours_enabled: boolean;
  quiet_start_time?: string;
  quiet_end_time?: string;
  quiet_timezone: string;
  expo_push_tokens: string[];
  created_at: Date;
  updated_at: Date;
}

// ============================================
// PAGINATED RESPONSE DTO
// ============================================
export class PaginatedNotificationsResponseDto {
  notifications: NotificationResponseDto[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}