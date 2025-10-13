import { IsString, IsOptional, IsUUID, IsEnum, IsBoolean, IsArray, IsNumber, IsDateString, ValidateNested, IsObject } from 'class-validator';
import { Type, Transform } from 'class-transformer';

// Enums matching database
export enum MessageType {
  TEXT = 'text',
  IMAGE = 'image',
  AUDIO = 'audio',
  VIDEO = 'video',
  FILE = 'file',
  LIVESTREAM = 'livestream',
  AUCTION = 'auction',
  SYSTEM = 'system',
  INVOICE = 'invoice', // Keep invoice as it's already in the database
}

export enum MessageStatus {
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
}

export enum ChatType {
  FRIEND = 'friend',
  VENDOR = 'vendor',
  SUPPORT = 'support',
  AI = 'ai',
  RIDER = 'rider',
}

export enum CallType {
  AUDIO = 'audio',
  VIDEO = 'video',
}

export enum CallStatus {
  CALLING = 'calling',
  CONNECTED = 'connected',
  ENDED = 'ended',
  MISSED = 'missed',
  DECLINED = 'declined',
}

export enum AuctionStatus {
  ACTIVE = 'active',
  ENDED = 'ended',
  CANCELLED = 'cancelled',
}

export enum LivestreamStatus {
  LIVE = 'live',
  ENDED = 'ended',
  SCHEDULED = 'scheduled',
}

// Create Conversation DTO
export class CreateConversationDto {
  @IsEnum(ChatType)
  chatType: ChatType;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;

  @IsArray()
  @IsUUID('4', { each: true })
  participantIds: string[];

  @IsOptional()
  metadata?: any;
}

// Send Message DTO
export class SendMessageDto {
  @IsUUID()
  conversationId: string;

  @IsEnum(MessageType)
  messageType: MessageType;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  mediaUrl?: string;

  @IsOptional()
  @IsUUID()
  replyToId?: string;

  @IsOptional()
  fileMetadata?: {
    name: string;
    size: number;
    type: string;
    mimeType: string;
  };

  @IsOptional()
  metadata?: any;

  @IsOptional()
  @IsUUID()
  actualSenderId?: string;

  @IsOptional()
  @IsBoolean()
  isAIResponse?: boolean;

  @IsOptional()
  @IsObject()
  productData?: any; // Using any to avoid strict validation on nested object
}

// Update Message Status DTO
export class UpdateMessageStatusDto {
  @IsUUID()
  messageId: string;

  @IsEnum(MessageStatus)
  status: MessageStatus;
}

// File Upload DTO
export class FileUploadDto {
  @IsUUID()
  messageId: string;

  @IsString()
  fileName: string;

  @IsNumber()
  fileSize: number;

  @IsString()
  fileType: string;

  @IsString()
  mimeType: string;

  @IsString()
  storagePath: string;

  @IsString()
  publicUrl: string;

  @IsOptional()
  metadata?: any;
}

// Create Livestream DTO
export class CreateLivestreamDto {
  @IsUUID()
  conversationId: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @IsOptional()
  @IsDateString()
  scheduledFor?: string;

  @IsOptional()
  metadata?: any;
}

// Update Livestream DTO
export class UpdateLivestreamDto {
  @IsOptional()
  @IsEnum(LivestreamStatus)
  status?: LivestreamStatus;

  @IsOptional()
  @IsString()
  streamUrl?: string;

  @IsOptional()
  @IsNumber()
  viewerCount?: number;

  @IsOptional()
  metadata?: any;
}

// Create Auction DTO
export class CreateAuctionDto {
  @IsUUID()
  conversationId: string;

  @IsString()
  itemName: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Transform(({ value }) => parseFloat(value))
  startingPrice: number;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseFloat(value))
  buyNowPrice?: number;

  @IsArray()
  @IsString({ each: true })
  imageUrls: string[];

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  condition?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsDateString()
  endsAt: string;

  @IsOptional()
  metadata?: any;
}

// Place Bid DTO
export class PlaceBidDto {
  @IsUUID()
  auctionId: string;

  @IsNumber()
  @Transform(({ value }) => parseFloat(value))
  bidAmount: number;

  @IsOptional()
  @IsBoolean()
  isAutoBid?: boolean;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseFloat(value))
  maxAutoBid?: number;
}

// Start Call DTO
export class StartCallDto {
  @IsUUID()
  conversationId: string;

  @IsEnum(CallType)
  callType: CallType;

  @IsArray()
  @IsUUID('4', { each: true })
  participantIds: string[];
}

// Update Call DTO
export class UpdateCallDto {
  @IsOptional()
  @IsEnum(CallStatus)
  status?: CallStatus;

  @IsOptional()
  @IsString()
  endReason?: string;

  @IsOptional()
  @IsNumber()
  duration?: number;

  @IsOptional()
  metadata?: any;
}

// Join Call DTO
export class JoinCallDto {
  @IsUUID()
  callSessionId: string;

  @IsOptional()
  @IsBoolean()
  isMuted?: boolean;

  @IsOptional()
  @IsBoolean()
  isVideoEnabled?: boolean;
}

// AI Research Request DTO
export class AIResearchRequestDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  researchType?: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

// Activity Planning DTO
export class CreateActivityPlanDto {
  @IsUUID()
  conversationId: string;

  @IsString()
  activityType: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  plannedDate?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  participantIds?: string[];

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseFloat(value))
  budget?: number;

  @IsOptional()
  metadata?: any;
}

// Query DTOs
export class GetConversationsDto {
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value))
  page?: number = 1;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value))
  limit?: number = 20;

  @IsOptional()
  @IsEnum(ChatType)
  chatType?: ChatType;

  @IsOptional()
  @IsString()
  search?: string;
}

export class GetMessagesDto {
  @IsUUID()
  conversationId: string;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value))
  page?: number = 1;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value))
  limit?: number = 50;

  @IsOptional()
  @IsDateString()
  before?: string;

  @IsOptional()
  @IsDateString()
  after?: string;

  @IsOptional()
  @IsEnum(MessageType)
  messageType?: MessageType;
}

// Response DTOs
export class ConversationResponseDto {
  id: string;
  chatType: ChatType;
  name?: string;
  description?: string;
  avatarUrl?: string;
  isGroup: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  participants: ParticipantResponseDto[];
  lastMessage?: MessageResponseDto;
  unreadCount: number;
  isOnline?: boolean;
  isAI?: boolean;
  isPinned?: boolean;
  verified?: boolean;
  metadata?: any;
}

export class ParticipantResponseDto {
  id: string;
  userId: string;
  role: string;
  joinedAt: string;
  isMuted: boolean;
  isPinned: boolean;
  lastReadAt: string;
  user: {
    id: string;
    username: string;
    avatarUrl?: string;
  };
}

export class MessageResponseDto {
  id: string;
  conversationId: string;
  senderId: string;
  messageType: MessageType;
  content?: string;
  mediaUrl?: string;
  fileMetadata?: any;
  createdAt: string;
  updatedAt: string;
  editedAt?: string;
  isDeleted: boolean;
  replyToId?: string;
  replyTo?: MessageResponseDto;
  sender: {
    id: string;
    username: string;
    avatarUrl?: string;
  };
  status?: MessageStatus;
  metadata?: any;
  productData?: {
    id: string;
    name: string;
    price: number;
    image: string;
    vendor_username?: string;
  };
}

export class LivestreamResponseDto {
  id: string;
  messageId: string;
  streamerId: string;
  conversationId: string;
  title: string;
  description?: string;
  status: LivestreamStatus;
  thumbnailUrl?: string;
  streamUrl?: string;
  viewerCount: number;
  maxViewers: number;
  startedAt?: string;
  endedAt?: string;
  scheduledFor?: string;
  createdAt: string;
  updatedAt: string;
  streamer: {
    id: string;
    username: string;
    avatarUrl?: string;
  };
  isViewerJoined?: boolean;
  metadata?: any;
}

export class AuctionResponseDto {
  id: string;
  messageId: string;
  sellerId: string;
  conversationId: string;
  itemName: string;
  description?: string;
  startingPrice: number;
  currentPrice: number;
  buyNowPrice?: number;
  status: AuctionStatus;
  imageUrls: string[];
  category?: string;
  condition?: string;
  location?: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
  winnerId?: string;
  totalBids: number;
  seller: {
    id: string;
    username: string;
    avatarUrl?: string;
  };
  highestBid?: {
    id: string;
    bidderId: string;
    bidAmount: number;
    placedAt: string;
    bidder: {
      id: string;
      username: string;
    };
  };
  userBidCount?: number;
  metadata?: any;
}

export class CallSessionResponseDto {
  id: string;
  conversationId: string;
  initiatorId: string;
  callType: CallType;
  status: CallStatus;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  duration: number;
  endReason?: string;
  participants: CallParticipantResponseDto[];
  initiator: {
    id: string;
    username: string;
    avatarUrl?: string;
  };
  metadata?: any;
}

export class CallParticipantResponseDto {
  id: string;
  userId: string;
  joinedAt: string;
  leftAt?: string;
  isMuted: boolean;
  isVideoEnabled: boolean;
  connectionQuality: string;
  user: {
    id: string;
    username: string;
    avatarUrl?: string;
  };
}