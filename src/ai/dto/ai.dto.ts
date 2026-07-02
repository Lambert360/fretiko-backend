import { IsString, IsOptional, IsObject, IsEnum, IsArray, IsUUID, IsNumber, Min } from 'class-validator';

export enum AiIntent {
  PRODUCT_SEARCH = 'product_search',
  VENDOR_SEARCH = 'vendor_search',
  COMPARISON = 'comparison',
  TRENDING = 'trending',
  GENERAL_CHAT = 'general_chat',
  UNKNOWN = 'unknown',
}

export enum AiResponseType {
  TEXT = 'text',
  PRODUCTS = 'products',
  VENDORS = 'vendors',
  COMPARISON = 'comparison',
  TRENDING = 'trending',
  ACTIONS = 'actions',
  THINKING = 'thinking',
}

export class ChatMessageDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsEnum(['text', 'voice'])
  inputType?: 'text' | 'voice' = 'text';

  @IsOptional()
  @IsObject()
  context?: Record<string, any>;
}

export class StreamingResponseDto {
  type: AiResponseType;
  content?: string;
  data?: any;
  actions?: AiAction[];
  metadata?: any;
}

export interface AiAction {
  id: string;
  type: 'save' | 'follow' | 'alert' | 'draft' | 'compare' | 'view' | 'cart';
  label: string;
  payload: Record<string, any>;
  requiresConfirmation?: boolean;
}

export interface AiToolCall {
  tool: string;
  parameters: Record<string, any>;
  result: any;
  latencyMs: number;
}

export interface ToolExecutionResult {
  toolName: string;
  result: any;
  latencyMs: number;
  error?: string;
}

export interface AiRequestMetadata {
  userId: string;
  intent: AiIntent;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  latencyMs: number;
  estimatedCost: number;
  success: boolean;
  errorMessage?: string;
}

export interface ProductSearchToolParams {
  query: string;
  category?: string;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
  page?: number;
}

export interface VendorSearchToolParams {
  query: string;
  category?: string;
  location?: string;
  isVerified?: boolean;
  limit?: number;
  page?: number;
}

export class CreatePriceAlertDto {
  @IsString()
  productQuery: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetPrice?: number;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface LlmResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  rawResponse: any;
}
