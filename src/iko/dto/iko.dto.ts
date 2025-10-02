import { IsString, IsOptional, IsBoolean, IsObject, IsArray, IsEnum, IsDateString } from 'class-validator';

// Base interfaces for Iko preferences and context
export interface IkoPreferences {
  budget_ranges: {
    [category: string]: number; // e.g., "shopping": 500, "services": 200
  };
  favorite_categories: string[];
  preferred_times: {
    [activity: string]: string; // e.g., "services": "weekends", "shopping": "evening"
  };
  communication_style: 'formal' | 'friendly' | 'casual' | 'professional';
  location_preferences: 'nearby' | 'city_wide' | 'no_preference' | string;
  notification_preferences: {
    proactive_suggestions: boolean;
    price_alerts: boolean;
    plan_reminders: boolean;
  };
}

export interface IkoContext {
  first_interaction: boolean;
  last_conversation: string | null;
  ongoing_plans: Array<{
    id: string;
    type: string;
    title: string;
    description?: string;
    scheduledFor?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    createdAt: string;
    updatedAt?: string;
    notes?: string;
  }>;
  learned_patterns: {
    [key: string]: any; // Flexible storage for AI learning
  };
  conversation_count: number;
  preferences_learned: boolean;
  last_interaction_type?: 'text' | 'voice' | 'call';
  last_interaction_summary?: string;
}

// DTOs for API operations
export class UpdateIkoPreferencesDto {
  @IsOptional()
  @IsObject()
  budget_ranges?: { [category: string]: number };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  favorite_categories?: string[];

  @IsOptional()
  @IsObject()
  preferred_times?: { [activity: string]: string };

  @IsOptional()
  @IsEnum(['formal', 'friendly', 'casual', 'professional'])
  communication_style?: 'formal' | 'friendly' | 'casual' | 'professional';

  @IsOptional()
  @IsString()
  location_preferences?: string;

  @IsOptional()
  @IsObject()
  notification_preferences?: {
    proactive_suggestions?: boolean;
    price_alerts?: boolean;
    plan_reminders?: boolean;
  };
}

export class UpdateIkoContextDto {
  @IsOptional()
  @IsBoolean()
  first_interaction?: boolean;

  @IsOptional()
  @IsString()
  last_conversation?: string;

  @IsOptional()
  @IsArray()
  ongoing_plans?: Array<{
    id: string;
    type: string;
    title: string;
    description?: string;
    scheduledFor?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    createdAt: string;
    updatedAt?: string;
    notes?: string;
  }>;

  @IsOptional()
  @IsObject()
  learned_patterns?: { [key: string]: any };

  @IsOptional()
  conversation_count?: number;

  @IsOptional()
  @IsBoolean()
  preferences_learned?: boolean;

  @IsOptional()
  @IsEnum(['text', 'voice', 'call'])
  last_interaction_type?: 'text' | 'voice' | 'call';

  @IsOptional()
  @IsString()
  last_interaction_summary?: string;
}

export class CreateOngoingPlanDto {
  @IsString()
  type: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  scheduledFor?: string;

  @IsOptional()
  @IsEnum(['pending', 'in_progress', 'completed', 'cancelled'])
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export class UpdateOngoingPlanDto {
  @IsOptional()
  @IsEnum(['pending', 'in_progress', 'completed', 'cancelled'])
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  scheduledFor?: string;
}

export class RecordConversationDto {
  @IsEnum(['text', 'voice', 'call'])
  interactionType: 'text' | 'voice' | 'call';

  @IsOptional()
  @IsString()
  summary?: string;
}

// Response DTOs
export class IkoUserProfileDto {
  userId: string;
  username: string;
  location?: string;
  memberSince: string;
  preferences: IkoPreferences;
  context: IkoContext;
}

export class IkoPreferencesResponseDto {
  preferences: IkoPreferences;
  lastUpdated: string;
}

export class IkoContextResponseDto {
  context: IkoContext;
  lastUpdated: string;
}