import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EngagementBotsService } from './engagement-bots.service';

const BOTS_PER_CYCLE = 6;
const ENABLE_AUTO_ENGAGEMENT = true;

@Injectable()
export class EngagementBotsScheduler implements OnModuleInit {
  private readonly logger = new Logger(EngagementBotsScheduler.name);
  private isProcessing = false;
  private rotationIndex = 0;
  private lastCycleTime: Date = new Date(0);
  private lastCycleStats = { engagementsPerformed: 0, postsTouched: 0 };

  constructor(private readonly engagementBotsService: EngagementBotsService) {}

  async onModuleInit() {
    await this.engagementBotsService.initializeBotUsers();
    this.logger.log('Engagement Bots Scheduler initialized');
  }

  @Cron('*/3 * * * *')
  async engagementCycle() {
    if (!ENABLE_AUTO_ENGAGEMENT) return;
    if (this.isProcessing) return;

    this.isProcessing = true;
    try {
      const result = await this.runCycle();
      this.lastCycleStats = result;
      this.lastCycleTime = new Date();
    } catch (error: any) {
      this.logger.error('Error in engagement cycle', error.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  private async runCycle(): Promise<{ engagementsPerformed: number; postsTouched: number }> {
    const personas = this.engagementBotsService.getEngagementPersonas();
    const userIds = this.engagementBotsService.getEngagementUserIds();
    if (personas.length === 0 || userIds.size === 0) {
      return { engagementsPerformed: 0, postsTouched: 0 };
    }

    const posts = await this.engagementBotsService.fetchRecentContentBotPosts(30);
    if (posts.length === 0) {
      return { engagementsPerformed: 0, postsTouched: 0 };
    }

    let engagementsPerformed = 0;
    const touchedPosts = new Set<string>();

    for (let i = 0; i < BOTS_PER_CYCLE; i++) {
      const persona = personas[this.rotationIndex % personas.length];
      this.rotationIndex++;

      const botUserId = userIds.get(persona.username);
      if (!botUserId) continue;

      const post = posts[Math.floor(Math.random() * posts.length)];
      if (post.user_id === botUserId) continue;

      try {
        const performed = await this.engagementBotsService.engageWithPost(botUserId, post.id);
        if (performed.length > 0) {
          engagementsPerformed += performed.length;
          touchedPosts.add(post.id);
        }
      } catch (error: any) {
        this.logger.warn(`Engagement failed for ${persona.username} on post ${post.id}: ${error.message}`);
      }
    }

    this.logger.log(`Engagement cycle: ${engagementsPerformed} interactions across ${touchedPosts.size} posts`);
    return { engagementsPerformed, postsTouched: touchedPosts.size };
  }

  async manualEngageNow(): Promise<{ success: boolean; message: string; engagementsPerformed?: number; postsTouched?: number }> {
    try {
      const result = await this.runCycle();
      this.lastCycleStats = result;
      this.lastCycleTime = new Date();
      return {
        success: true,
        message: `Performed ${result.engagementsPerformed} interactions across ${result.postsTouched} posts`,
        ...result,
      };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  getStatus() {
    return {
      botsInitialized: this.engagementBotsService.getInitializedCount(),
      lastCycleTime: this.lastCycleTime,
      lastCycleStats: this.lastCycleStats,
    };
  }
}
