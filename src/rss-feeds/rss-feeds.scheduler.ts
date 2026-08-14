import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RssFeedsService } from './rss-feeds.service';
import { SupabaseService } from '../shared/supabase.service';

@Injectable()
export class RssFeedsScheduler implements OnModuleInit {
  private readonly logger = new Logger(RssFeedsScheduler.name);
  private botUserId: string | null = null;
  private isProcessing = false;
  private postQueue: any[] = [];
  private lastPostTime: Date = new Date(0);

  constructor(
    private readonly rssFeedsService: RssFeedsService,
    private readonly supabaseService: SupabaseService,
  ) {}

  async onModuleInit() {
    await this.initializeBotUser();
    this.logger.log('RSS Feeds Scheduler initialized');
  }

  private async initializeBotUser(): Promise<void> {
    try {
      const { data: botUser, error } = await this.supabaseService.client
        .from('users')
        .select('id')
        .eq('email', 'rss-bot@fretiko.com')
        .single();

      if (error || !botUser) {
        this.logger.log('Creating RSS bot user...');
        const { data: newBot, error: createError } = await this.supabaseService.client
          .from('users')
          .insert({
            email: 'rss-bot@fretiko.com',
            username: 'FretikoCurator',
            first_name: 'Fretiko',
            last_name: 'Curator',
            bio: 'Automated content curator bringing you the latest from around the web',
            is_verified: true,
            is_bot: true,
          })
          .select()
          .single();

        if (createError) {
          this.logger.error('Failed to create bot user', createError);
          return;
        }

        this.botUserId = newBot.id;
        this.logger.log(`RSS bot user created with ID: ${this.botUserId}`);
      } else {
        this.botUserId = botUser.id;
        this.logger.log(`RSS bot user found with ID: ${this.botUserId}`);
      }
    } catch (error) {
      this.logger.error('Error initializing bot user', error.stack);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async fetchNewRssContent() {
    if (!this.botUserId) {
      this.logger.warn('Bot user not initialized, skipping RSS fetch');
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

  @Cron('*/30 * * * *')
  async postQueuedContent() {
    if (!this.botUserId || this.postQueue.length === 0) {
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
      
      this.logger.log(`Posting RSS item: ${item.title}`);
      await this.rssFeedsService.createPostFromRssItem(item, this.botUserId);
      
      this.lastPostTime = now;
      this.logger.log(`Successfully posted. ${this.postQueue.length} items remaining in queue`);

    } catch (error) {
      this.logger.error('Error posting queued content', error.stack);
    }
  }

  async manualFetchAndPost(): Promise<{ success: boolean; message: string; posted?: number }> {
    if (!this.botUserId) {
      return { success: false, message: 'Bot user not initialized' };
    }

    try {
      const newItems = await this.rssFeedsService.getNewItems();
      
      if (newItems.length === 0) {
        return { success: true, message: 'No new items to post', posted: 0 };
      }

      let posted = 0;
      for (const item of newItems.slice(0, 5)) {
        try {
          await this.rssFeedsService.createPostFromRssItem(item, this.botUserId);
          posted++;
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

  getQueueStatus(): { queueSize: number; lastPostTime: Date; botUserId: string | null } {
    return {
      queueSize: this.postQueue.length,
      lastPostTime: this.lastPostTime,
      botUserId: this.botUserId,
    };
  }

  clearQueue(): void {
    this.postQueue = [];
    this.logger.log('Post queue cleared');
  }
}
