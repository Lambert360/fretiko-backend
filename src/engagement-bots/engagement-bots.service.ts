import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { BotPersona, loadPersonas, ensureBotUser } from '../shared/bot-persona.util';

const LIKE_ONLY_WEIGHT = 0.55;
const LIKE_AND_COMMENT_WEIGHT = 0.3;
const LIKE_COMMENT_AND_SHARE_WEIGHT = 0.15;

const COMMENT_TEMPLATES = [
  'This is fire 🔥',
  'Nice one o!',
  'I like this',
  'Chai, this is interesting',
  'Wow, didn\u2019t know this',
  'Correct!',
  'This one na sense',
  'Interesting take',
  'Thanks for sharing this',
  'I dey feel this one',
  'Make e continue like this',
  'Great post 👏',
  'This na wetin I dey talk about',
  'Very true',
  'Love this energy',
  'Good stuff, keep it up',
  'This got me thinking',
  'Facts',
  'God bless the person that made this',
  'Sharing this to my people',
];

const REPLY_TEMPLATES = [
  'Exactly my thoughts',
  'Abeg you don talk am well',
  'I agree with you 100%',
  'This is so true',
  'Well said',
  'Na so e be',
  'You just said it all',
  'Thank you for this',
  'True talk',
  'I feel the same way',
];

@Injectable()
export class EngagementBotsService {
  private readonly logger = new Logger(EngagementBotsService.name);
  private supabaseClient: any;
  private engagementPersonas: BotPersona[] = [];
  private contentPersonas: BotPersona[] = [];
  private engagementUserIds: Map<string, string> = new Map();
  private contentUserIds: Set<string> = new Set();

  constructor(private readonly configService: ConfigService) {
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

  async initializeBotUsers(): Promise<number> {
    for (const persona of this.engagementPersonas) {
      const id = await ensureBotUser(this.supabaseClient, persona);
      if (id) {
        this.engagementUserIds.set(persona.username, id);
      }
    }

    for (const persona of this.contentPersonas) {
      const { data: profile } = await this.supabaseClient
        .from('user_profiles')
        .select('id')
        .eq('username', persona.username)
        .single();
      if (profile) {
        this.contentUserIds.add(profile.id);
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
      .select('id, user_id, created_at')
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

  async engageWithPost(botUserId: string, postId: string): Promise<string[]> {
    const performed: string[] = [];
    const actions = this.pickActions();

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
      const { data: comment, error } = await this.supabaseClient
        .from('post_interactions')
        .insert({
          post_id: postId,
          user_id: botUserId,
          interaction_type: 'comment',
          content: this.randomPick(COMMENT_TEMPLATES),
        })
        .select()
        .single();
      if (!error) {
        performed.push('comment');

        if (Math.random() < 0.4) {
          const replyBot = this.randomPick(Array.from(this.engagementUserIds.values()));
          if (replyBot && replyBot !== botUserId) {
            const { error: replyError } = await this.supabaseClient.from('post_interactions').insert({
              post_id: postId,
              user_id: replyBot,
              interaction_type: 'comment',
              content: this.randomPick(REPLY_TEMPLATES),
              parent_comment_id: comment.id,
            });
            if (!replyError) performed.push('reply');
          }
        }
      } else if (error.code !== '23505') {
        this.logger.warn(`Comment failed: ${error.message}`);
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
