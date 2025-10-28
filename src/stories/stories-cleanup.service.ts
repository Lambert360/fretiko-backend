import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class StoriesCleanupService {
  private readonly logger = new Logger(StoriesCleanupService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  /**
   * Cleanup expired stories
   * Runs daily at 2 AM
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupExpiredStories() {
    try {
      this.logger.log('🧹 Starting expired stories cleanup...');

      // Call the database function
      const { data, error } = await this.supabase.rpc('cleanup_expired_stories');

      if (error) {
        this.logger.error('❌ Cleanup failed:', error);
        throw error;
      }

      const deletedCount = data || 0;
      this.logger.log(`✅ Cleanup complete: ${deletedCount} expired stories removed`);

      return { success: true, deletedCount };
    } catch (error) {
      this.logger.error('❌ Error during cleanup:', error);
      throw error;
    }
  }

  /**
   * Manual cleanup trigger (for testing or admin use)
   */
  async triggerManualCleanup() {
    this.logger.log('🔧 Manual cleanup triggered');
    return await this.cleanupExpiredStories();
  }
}

