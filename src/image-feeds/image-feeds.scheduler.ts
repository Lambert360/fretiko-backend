import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ImageFeedsService, BotPersona } from './image-feeds.service';
import { EngagementBotsService } from '../engagement-bots/engagement-bots.service';

@Injectable()
export class ImageFeedsScheduler implements OnModuleInit {
  private readonly logger = new Logger(ImageFeedsScheduler.name);
  private personaUserIds: Map<string, string> = new Map();
  private rotationIndex = 0;
  private isProcessing = false;
  private lastPostTime: Date = new Date(0);

  constructor(
    private readonly imageFeedsService: ImageFeedsService,
    private readonly engagementBotsService: EngagementBotsService,
  ) {}

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
    this.logger.log('Image Feeds Scheduler initialized');
  }

  private async initializeBotUsers(): Promise<void> {
    const personas = this.imageFeedsService.getPersonas();
    for (const persona of personas) {
      const id = await this.imageFeedsService.ensureBotUser(persona);
      if (id) {
        this.personaUserIds.set(persona.username, id);
      }
    }
    this.logger.log(`Initialized ${this.personaUserIds.size}/${personas.length} bot users`);
  }

  @Cron('*/5 * * * *')
  async postCycle() {
    const config = this.imageFeedsService.getConfig();
    if (!config.settings.enable_auto_posting) return;
    if (this.isProcessing) return;

    const now = new Date();
    const minutesSinceLastPost = (now.getTime() - this.lastPostTime.getTime()) / (1000 * 60);
    if (minutesSinceLastPost < config.settings.post_interval_minutes) return;

    const personas = this.imageFeedsService.getPersonas();
    if (personas.length === 0 || this.personaUserIds.size === 0) return;

    this.isProcessing = true;
    try {
      const persona = this.nextPersona(personas);
      const botUserId = this.personaUserIds.get(persona.username);
      if (!botUserId) return;

      const post = await this.imageFeedsService.createImagePost(persona, botUserId);
      this.lastPostTime = now;
      await this.seedEngagement(post, botUserId);
    } catch (error) {
      this.logger.error('Error in image post cycle', error.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  private nextPersona(personas: BotPersona[]): BotPersona {
    const persona = personas[this.rotationIndex % personas.length];
    this.rotationIndex++;
    return persona;
  }

  async manualPostOnce(): Promise<{ success: boolean; message: string; persona?: string }> {
    const personas = this.imageFeedsService.getPersonas();
    if (personas.length === 0 || this.personaUserIds.size === 0) {
      return { success: false, message: 'No bot personas initialized' };
    }

    const persona = this.nextPersona(personas);
    const botUserId = this.personaUserIds.get(persona.username);
    if (!botUserId) {
      return { success: false, message: `No user id for persona ${persona.username}` };
    }

    try {
      const post = await this.imageFeedsService.createImagePost(persona, botUserId);
      this.lastPostTime = new Date();
      await this.seedEngagement(post, botUserId);
      return { success: true, message: `Posted as ${persona.username}`, persona: persona.username };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  getStatus() {
    return {
      botsInitialized: this.personaUserIds.size,
      lastPostTime: this.lastPostTime,
      nextPersonaIndex: this.rotationIndex % Math.max(this.imageFeedsService.getPersonas().length, 1),
    };
  }
}
