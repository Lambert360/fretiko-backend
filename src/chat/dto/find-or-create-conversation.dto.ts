import { IsArray, IsString, IsOptional, IsIn } from 'class-validator';
import { ChatType } from './chat.dto';

export class FindOrCreateConversationDto {
  @IsArray()
  participantIds: string[];

  @IsString()
  @IsIn(['friend', 'vendor', 'support', 'ai', 'rider'])
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
  metadata?: any;
}