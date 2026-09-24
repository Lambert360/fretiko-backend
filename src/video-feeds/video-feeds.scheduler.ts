import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { VideoFeedsService, BotPersona } from './video-feeds.service';
import { EngagementBotsService } from '../engagement-bots/engagement-bots.service';

@Injectable()
export class VideoFeedsScheduler implements OnModuleInit {
  private readonly logger = new Logger(VideoFeedsScheduler.name);
  private personaUserIds: Map<string, string> = new Map();
  private rotationIndex = 0;
  private isProcessing = false;
  private lastPostTime: Date = new Date(0);

  constructor(
    private readonly videoFeedsService: VideoFeedsService,
    private readonly engagementBotsService: EngagementBotsService,
  ) {}

  private async seedEngagement(post: any, botUserId: string): Promise<void> {
    if (!post?.id) return;
    try {
      const result = await this.engagementBotsService.seedEngagementForPost(
        post.id,
        botUserId,
        50,
        80,
        50,
        65,
        post.content,
      );
      this.logger.log(`Seeded ${result.liked} likes and ${result.commented} comments on post ${post.id}`);
    } catch (error: any) {
      this.logger.warn(`Failed to seed engagement for post ${post.id}: ${error.message}`);
    }
  }

  onModuleInit() {
    void this.initializeBotUsers()
      .then(() => this.logger.log('Video Feeds Scheduler initialized'))
      .catch((error: any) => this.logger.error('Failed to initialize video feed bot users', error?.stack));
  }

  private async initializeBotUsers(): Promise<void> {
    const personas = this.videoFeedsService.getPersonas();
    for (const persona of personas) {
      const id = await this.videoFeedsService.ensureBotUser(persona);
      if (id) {
        this.personaUserIds.set(persona.username, id);
      }
    }
    this.logger.log(`Initialized ${this.personaUserIds.size}/${personas.length} bot users`);
  }

  @Cron('*/5 * * * *')
  async postCycle() {
    const config = this.videoFeedsService.getConfig();
    if (!config.settings.enable_auto_posting) return;
    if (this.isProcessing) return;

    const now = new Date();
    const minutesSinceLastPost = (now.getTime() - this.lastPostTime.getTime()) / (1000 * 60);
    if (minutesSinceLastPost < config.settings.post_interval_minutes) return;

    const personas = this.videoFeedsService.getPersonas();
    if (personas.length === 0 || this.personaUserIds.size === 0) return;

    this.isProcessing = true;
    try {
      const persona = this.nextPersona(personas);
      const botUserId = this.personaUserIds.get(persona.username);
      if (!botUserId) return;

      const post = await this.videoFeedsService.createVideoPost(persona, botUserId);
      this.lastPostTime = now;
      await this.seedEngagement(post, botUserId);
    } catch (error) {
      this.logger.error('Error in video post cycle', error.stack);
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
    const personas = this.videoFeedsService.getPersonas();
    if (personas.length === 0 || this.personaUserIds.size === 0) {
      return { success: false, message: 'No bot personas initialized' };
    }

    const persona = this.nextPersona(personas);
    const botUserId = this.personaUserIds.get(persona.username);
    if (!botUserId) {
      return { success: false, message: `No user id for persona ${persona.username}` };
    }

    try {
      const post = await this.videoFeedsService.createVideoPost(persona, botUserId);
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
      nextPersonaIndex: this.rotationIndex % Math.max(this.videoFeedsService.getPersonas().length, 1),
    };
  }
}
