import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { BotPersona, loadPersonas, ensureBotUser } from '../shared/bot-persona.util';
import { LlmService, ModelTier } from '../ai/core/llm.service';
import {
  buildCommentPrompt,
  fallbackComment,
  fallbackReply,
  sanitizeComment,
} from './bot-comment.util';

const LIKE_ONLY_WEIGHT = 0.55;
const LIKE_AND_COMMENT_WEIGHT = 0.3;
const LIKE_COMMENT_AND_SHARE_WEIGHT = 0.15;

@Injectable()
export class EngagementBotsService {
  private readonly logger = new Logger(EngagementBotsService.name);
  private supabaseClient: any;
  private engagementPersonas: BotPersona[] = [];
  private contentPersonas: BotPersona[] = [];
  private engagementUserIds: Map<string, string> = new Map();
  private contentUserIds: Set<string> = new Set();

  constructor(
    private readonly configService: ConfigService,
    private readonly llmService: LlmService,
  ) {
    this.supabaseClient = createServiceSupabaseClient(this.configService);
    this.loadPersonaFiles();
  }

  private loadPersonaFiles(): void {
    try {
      this.engagementPersonas = loadPersonas('engagement-bots.json');
      this.logger.log(`Loaded ${this.engagementPersonas.length} engagement bot personas`);
    } catch (error: any) {
      this.logger.error('Failed to load engagement-bots.json', error.message);
      this.engagementPersonas = [];
    }

    try {
      this.contentPersonas = loadPersonas('content-bots.json');
    } catch (error: any) {
      this.logger.error('Failed to load content-bots.json', error.message);
      this.contentPersonas = [];
    }
  }

  getEngagementPersonas(): BotPersona[] {
    return this.engagementPersonas;
  }

  private initPromise: Promise<number> | null = null;

  async initializeBotUsers(): Promise<number> {
    if (!this.initPromise) {
      this.initPromise = this.doInitializeBotUsers().catch((error) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async doInitializeBotUsers(): Promise<number> {
    for (const persona of this.engagementPersonas) {
      const id = await ensureBotUser(this.supabaseClient, persona);
      if (id) {
        this.engagementUserIds.set(persona.username, id);
      }
    }

    for (const persona of this.contentPersonas) {
      const id = await ensureBotUser(this.supabaseClient, persona);
      if (id) {
        this.contentUserIds.add(id);
      }
    }

    this.logger.log(
      `Engagement: initialized ${this.engagementUserIds.size}/${this.engagementPersonas.length} bot users, ` +
        `resolved ${this.contentUserIds.size}/${this.contentPersonas.length} content bot ids`,
    );
    return this.engagementUserIds.size;
  }

  getInitializedCount(): number {
    return this.engagementUserIds.size;
  }

  getContentBotIds(): string[] {
    return Array.from(this.contentUserIds);
  }

  getEngagementUserIds(): Map<string, string> {
    return this.engagementUserIds;
  }

  async fetchRecentContentBotPosts(limit = 30): Promise<any[]> {
    const contentIds = this.getContentBotIds();
    if (contentIds.length === 0) return [];

    const { data, error } = await this.supabaseClient
      .from('posts')
      .select('id, user_id, created_at, content')
      .in('user_id', contentIds)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      this.logger.warn('Failed to fetch recent content bot posts', error.message);
      return [];
    }
    return data || [];
  }

  private randomPick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  private pickActions(): { like: boolean; comment: boolean; share: boolean } {
    const r = Math.random();
    if (r < LIKE_ONLY_WEIGHT) return { like: true, comment: false, share: false };
    if (r < LIKE_ONLY_WEIGHT + LIKE_AND_COMMENT_WEIGHT) return { like: true, comment: true, share: false };
    return { like: true, comment: true, share: true };
  }

  private hashSeed(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  async getPostContent(postId: string): Promise<string> {
    const { data, error } = await this.supabaseClient
      .from('posts')
      .select('content')
      .eq('id', postId)
      .single();
    if (error || !data?.content) return '';
    return String(data.content);
  }

  async composeComment(postContent: string, botUserId: string, parentComment?: string): Promise<string | null> {
    const content = (postContent || '').trim();
    if (!content) return null;

    const seed = this.hashSeed(`${botUserId}:${content.slice(0, 80)}:${parentComment || ''}`);

    try {
      const prompt = buildCommentPrompt(content, parentComment);
      const result = await this.llmService.chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        ModelTier.FAST,
        { temperature: 0.85, maxTokens: 80 },
      );
      const cleaned = sanitizeComment(result.content, content);
      if (cleaned) return cleaned;
    } catch (error: any) {
      this.logger.warn(`Contextual comment LLM failed, using post-specific fallback: ${error.message}`);
    }

    return parentComment ? fallbackReply(content, parentComment, seed) : fallbackComment(content, seed);
  }

  // Called right after a content bot creates a post so it doesn't sit with
  // zero engagement until the next scheduled cycle picks it up.
  async seedEngagementForPost(
    postId: string,
    authorId: string,
    minLikes = 4,
    maxLikes = 9,
    postContent?: string,
  ): Promise<number> {
    if (this.engagementUserIds.size === 0) {
      await this.initializeBotUsers();
    }

    const candidates = Array.from(this.engagementUserIds.values()).filter((id) => id !== authorId);
    if (candidates.length === 0) return 0;

    const likeCount = minLikes + Math.floor(Math.random() * (maxLikes - minLikes + 1));
    const shuffled = [...candidates].sort(() => Math.random() - 0.5).slice(0, likeCount);

    let liked = 0;
    for (const botUserId of shuffled) {
      const { error } = await this.supabaseClient.from('post_interactions').insert({
        post_id: postId,
        user_id: botUserId,
        interaction_type: 'like',
      });
      if (!error) liked++;
      else if (error.code !== '23505') this.logger.warn(`Seed like failed: ${error.message}`);
    }

    if (Math.random() < 0.6 && shuffled.length > 0) {
      const commenter = shuffled[0];
      const sourceContent = postContent || (await this.getPostContent(postId));
      const commentText = await this.composeComment(sourceContent, commenter);
      if (commentText) {
        const { error } = await this.supabaseClient.from('post_interactions').insert({
          post_id: postId,
          user_id: commenter,
          interaction_type: 'comment',
          content: commentText,
        });
        if (error && error.code !== '23505') this.logger.warn(`Seed comment failed: ${error.message}`);
      }
    }

    return liked;
  }

  async engageWithPost(botUserId: string, postId: string, postContent?: string): Promise<string[]> {
    const performed: string[] = [];
    const actions = this.pickActions();
    const content = postContent ?? (await this.getPostContent(postId));

    if (actions.like) {
      const { error } = await this.supabaseClient.from('post_interactions').insert({
        post_id: postId,
        user_id: botUserId,
        interaction_type: 'like',
      });
      if (!error) performed.push('like');
      else if (error.code !== '23505') this.logger.warn(`Like failed: ${error.message}`);
    }

    if (actions.comment) {
      const commentText = await this.composeComment(content, botUserId);
      if (commentText) {
        const { data: comment, error } = await this.supabaseClient
          .from('post_interactions')
          .insert({
            post_id: postId,
            user_id: botUserId,
            interaction_type: 'comment',
            content: commentText,
          })
          .select()
          .single();
        if (!error) {
          performed.push('comment');

          if (Math.random() < 0.4) {
            const replyBot = this.randomPick(Array.from(this.engagementUserIds.values()));
            if (replyBot && replyBot !== botUserId) {
              const replyText = await this.composeComment(content, replyBot, commentText);
              if (replyText) {
                const { error: replyError } = await this.supabaseClient.from('post_interactions').insert({
                  post_id: postId,
                  user_id: replyBot,
                  interaction_type: 'comment',
                  content: replyText,
                  parent_comment_id: comment.id,
                });
                if (!replyError) performed.push('reply');
              }
            }
          }
        } else if (error.code !== '23505') {
          this.logger.warn(`Comment failed: ${error.message}`);
        }
      }
    }

    if (actions.share) {
      const { error } = await this.supabaseClient.from('post_interactions').insert({
        post_id: postId,
        user_id: botUserId,
        interaction_type: 'share',
      });
      if (!error) performed.push('share');
      else if (error.code !== '23505') this.logger.warn(`Share failed: ${error.message}`);
    }

    return performed;
  }
}
