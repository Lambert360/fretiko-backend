import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { RssFeedsService } from './rss-feeds.service';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { BotPersona, loadPersonas, ensureBotUser } from '../shared/bot-persona.util';
import { EngagementBotsService } from '../engagement-bots/engagement-bots.service';

const RSS_NICHE_TO_BOT_NICHE: Record<string, string> = {
  nature: 'nature_environment',
  animals: 'animals_wildlife',
};

@Injectable()
export class RssFeedsScheduler implements OnModuleInit {
  private readonly logger = new Logger(RssFeedsScheduler.name);
  private personas: BotPersona[] = [];
  private personaUserIds: Map<string, string> = new Map();
  private rotationIndex = 0;
  private nicheRotation = new Map<string, number>();
  private isProcessing = false;
  private postQueue: any[] = [];
  private lastPostTime: Date = new Date(0);
  private supabaseClient: any;

  constructor(
    private readonly rssFeedsService: RssFeedsService,
    private readonly configService: ConfigService,
    private readonly engagementBotsService: EngagementBotsService,
  ) {
    this.supabaseClient = createServiceSupabaseClient(this.configService);
  }

  private async seedEngagement(post: any, botUserId: string): Promise<void> {
    if (!post?.id) return;
    try {
      const liked = await this.engagementBotsService.seedEngagementForPost(
        post.id,
        botUserId,
        4,
        9,
        post.content,
      );
      if (liked > 0) this.logger.log(`Seeded ${liked} likes on post ${post.id}`);
    } catch (error: any) {
      this.logger.warn(`Failed to seed engagement for post ${post.id}: ${error.message}`);
    }
  }

  async onModuleInit() {
    await this.initializeBotUsers();
    this.logger.log('RSS Feeds Scheduler initialized');
  }

  private async initializeBotUsers(): Promise<void> {
    try {
      this.personas = loadPersonas('content-bots.json');
    } catch (error) {
      this.logger.error('Could not load content-bots.json, falling back to no RSS bots', error.message);
      this.personas = [];
      return;
    }

    for (const persona of this.personas) {
      const id = await ensureBotUser(this.supabaseClient, persona);
      if (id) {
        this.personaUserIds.set(persona.username, id);
      }
    }
    this.logger.log(`RSS: initialized ${this.personaUserIds.size}/${this.personas.length} content bot users`);
  }

  private nextBotUserId(): string | null {
    if (this.personas.length === 0) return null;
    for (let i = 0; i < this.personas.length; i++) {
      const persona = this.personas[this.rotationIndex % this.personas.length];
      this.rotationIndex++;
      const id = this.personaUserIds.get(persona.username);
      if (id) return id;
    }
    return null;
  }

  private nextBotUserIdForNiche(rssNiche?: string): string | null {
    if (!rssNiche) return this.nextBotUserId();

    const botNiche = RSS_NICHE_TO_BOT_NICHE[rssNiche] || rssNiche;
    const matching = this.personas.filter(
      (persona) => persona.niche === botNiche && this.personaUserIds.has(persona.username),
    );

    if (matching.length === 0) return this.nextBotUserId();

    const current = this.nicheRotation.get(botNiche) || 0;
    const persona = matching[current % matching.length];
    this.nicheRotation.set(botNiche, current + 1);
    return this.personaUserIds.get(persona.username) || this.nextBotUserId();
  }

  @Cron('*/30 * * * *')
  async fetchNewRssContent() {
    if (this.personaUserIds.size === 0) {
      this.logger.warn('No content bot users initialized, skipping RSS fetch');
      return;
    }

    const config = this.rssFeedsService.getConfig();
    if (!config.settings.enable_auto_posting) {
      this.logger.log('Auto-posting is disabled');
      return;
    }

    if (this.isProcessing) {
      this.logger.log('Already processing RSS feeds, skipping...');
      return;
    }

    try {
      this.isProcessing = true;
      this.logger.log('Starting RSS feed fetch...');

      const newItems = await this.rssFeedsService.getNewItems();
      
      if (newItems.length === 0) {
        this.logger.log('No new RSS items found');
        return;
      }

      this.postQueue.push(...newItems);
      this.logger.log(`Added ${newItems.length} items to post queue. Queue size: ${this.postQueue.length}`);

    } catch (error) {
      this.logger.error('Error fetching RSS content', error.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  @Cron('*/5 * * * *')
  async postQueuedContent() {
    if (this.personaUserIds.size === 0 || this.postQueue.length === 0) {
      return;
    }

    const config = this.rssFeedsService.getConfig();
    if (!config.settings.enable_auto_posting) {
      return;
    }

    const now = new Date();
    const minutesSinceLastPost = (now.getTime() - this.lastPostTime.getTime()) / (1000 * 60);

    if (minutesSinceLastPost < config.settings.post_interval_minutes) {
      this.logger.log(`Waiting ${config.settings.post_interval_minutes - minutesSinceLastPost} more minutes before next post`);
      return;
    }

    try {
      const item = this.postQueue.shift();
      const botUserId = this.nextBotUserIdForNiche(item?.niche);
      if (!botUserId) {
        if (item) this.postQueue.unshift(item);
        return;
      }

      this.logger.log(`Posting RSS item: ${item.title}`);
      const post = await this.rssFeedsService.createPostFromRssItem(item, botUserId);

      this.lastPostTime = now;
      await this.seedEngagement(post, botUserId);
      this.logger.log(`Successfully posted. ${this.postQueue.length} items remaining in queue`);

    } catch (error) {
      this.logger.error('Error posting queued content', error.stack);
    }
  }

  async manualFetchAndPost(): Promise<{ success: boolean; message: string; posted?: number }> {
    if (this.personaUserIds.size === 0) {
      return { success: false, message: 'No content bot users initialized' };
    }

    try {
      const newItems = await this.rssFeedsService.getNewItems();
      
      if (newItems.length === 0) {
        return { success: true, message: 'No new items to post', posted: 0 };
      }

      let posted = 0;
      for (const item of newItems.slice(0, 5)) {
        const botUserId = this.nextBotUserIdForNiche(item.niche);
        if (!botUserId) continue;
        try {
          const post = await this.rssFeedsService.createPostFromRssItem(item, botUserId);
          posted++;
          await this.seedEngagement(post, botUserId);
        } catch (error) {
          this.logger.error(`Failed to post item: ${item.title}`, error.message);
        }
      }

      return {
        success: true,
        message: `Posted ${posted} out of ${newItems.length} new items`,
        posted,
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  getQueueStatus(): { queueSize: number; lastPostTime: Date; botsInitialized: number } {
    return {
      queueSize: this.postQueue.length,
      lastPostTime: this.lastPostTime,
      botsInitialized: this.personaUserIds.size,
    };
  }

  clearQueue(): void {
    this.postQueue = [];
    this.logger.log('Post queue cleared');
  }
}
