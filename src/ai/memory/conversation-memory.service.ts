import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { createServiceSupabaseClient } from '../../shared/supabase.client';

export interface AiConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface AiConversation {
  id: string;
  userId: string;
  messages: AiConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ConversationMemoryService {
  private readonly logger = new Logger(ConversationMemoryService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async getOrCreateConversation(userId: string, conversationId?: string): Promise<{ id: string; messages: AiConversationMessage[] }> {
    if (conversationId) {
      const { data, error } = await this.supabase
        .from('ai_conversations')
        .select('id, messages')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .single();

      if (!error && data) {
        return {
          id: data.id,
          messages: data.messages || [],
        };
      }
    }

    // Create new conversation
    const newId = randomUUID();
    const { error } = await this.supabase
      .from('ai_conversations')
      .insert({
        id: newId,
        user_id: userId,
        messages: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

    if (error) {
      this.logger.error('Failed to create AI conversation:', error);
      // Return in-memory fallback
      return { id: newId, messages: [] };
    }

    return { id: newId, messages: [] };
  }

  async addMessage(
    userId: string,
    conversationId: string | undefined,
    role: 'user' | 'assistant' | 'system',
    content: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    const conversation = await this.getOrCreateConversation(userId, conversationId);
    const message: AiConversationMessage = {
      role,
      content,
      timestamp: new Date().toISOString(),
      metadata,
    };

    const messages = [...conversation.messages, message];
    // Keep last 50 messages to manage context size
    const trimmedMessages = messages.slice(-50);

    const { error } = await this.supabase
      .from('ai_conversations')
      .update({
        messages: trimmedMessages,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);

    if (error) {
      this.logger.error('Failed to add AI conversation message:', error);
    }

    return conversation.id;
  }

  async getRecentMessages(userId: string, conversationId: string, limit = 10): Promise<AiConversationMessage[]> {
    const { data, error } = await this.supabase
      .from('ai_conversations')
      .select('messages')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return [];
    }

    return (data.messages || []).slice(-limit);
  }

  async getConversations(userId: string, limit = 20): Promise<{ id: string; updatedAt: string; preview: string }[]> {
    const { data, error } = await this.supabase
      .from('ai_conversations')
      .select('id, updated_at, messages')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error || !data) {
      return [];
    }

    return data.map((conv: any) => {
      const messages = conv.messages || [];
      const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user');
      return {
        id: conv.id,
        updatedAt: conv.updated_at,
        preview: lastUserMessage?.content?.substring(0, 100) || 'New conversation',
      };
    });
  }
}
