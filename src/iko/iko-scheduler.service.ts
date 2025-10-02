import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient } from '../shared/supabase.client';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType, NotificationPriority } from '../notifications/dto/notification.dto';
import { IkoService } from './iko.service';

/**
 * Iko Scheduler Service
 *
 * Handles automated Iko AI check-ins and reminders:
 * - Check for users who need check-ins
 * - Send AI reminders for ongoing plans
 * - Process scheduled tasks
 * - Proactive user engagement
 */
@Injectable()
export class IkoSchedulerService {
  private readonly logger = new Logger(IkoSchedulerService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationsService: NotificationsService,
    private ikoService: IkoService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
  }

  /**
   * Check for users who need AI check-ins (every hour)
   */
  @Cron(CronExpression.EVERY_HOUR)
  async performUserCheckIns() {
    try {
      this.logger.log('Performing Iko user check-ins...');

      const now = new Date();
      const checkThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

      // Find users who haven't interacted with Iko in the last 24 hours
      // but have ongoing plans or unfinished conversations
      const { data: usersNeedingCheckIn, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id,
          username,
          push_token,
          iko_context
        `)
        .not('iko_context->ongoing_plans', 'is', null)
        .not('iko_context->ongoing_plans', 'eq', '[]');

      if (error) {
        this.logger.error('Error fetching users for check-in:', error);
        return;
      }

      for (const user of usersNeedingCheckIn || []) {
        await this.sendUserCheckIn(user);
      }

      this.logger.log(`Completed check-ins for ${usersNeedingCheckIn?.length || 0} users`);
    } catch (error) {
      this.logger.error('Error in performUserCheckIns:', error);
    }
  }

  /**
   * Process ongoing plan reminders (every 2 hours)
   */
  @Cron('0 */2 * * *') // Every 2 hours
  async processOngoingPlanReminders() {
    try {
      this.logger.log('Processing ongoing plan reminders...');

      const now = new Date();

      // Find users with active ongoing plans
      const { data: usersWithPlans, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id,
          username,
          push_token,
          iko_context
        `)
        .not('iko_context->ongoing_plans', 'is', null)
        .not('iko_context->ongoing_plans', 'eq', '[]');

      if (error) {
        this.logger.error('Error fetching users with plans:', error);
        return;
      }

      for (const user of usersWithPlans || []) {
        await this.processUserPlanReminders(user, now);
      }

      this.logger.log(`Processed plan reminders for ${usersWithPlans?.length || 0} users`);
    } catch (error) {
      this.logger.error('Error in processOngoingPlanReminders:', error);
    }
  }

  /**
   * Weekly engagement check (every Sunday at 10 AM)
   */
  @Cron('0 10 * * 0') // Every Sunday at 10 AM
  async weeklyEngagementCheck() {
    try {
      this.logger.log('Performing weekly engagement check...');

      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Find users who haven't used Iko in a week
      const { data: inactiveUsers, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id,
          username,
          push_token,
          iko_context
        `)
        .gte('iko_context->conversation_count', 1); // Only users who have used Iko before

      if (error) {
        this.logger.error('Error fetching inactive users:', error);
        return;
      }

      for (const user of inactiveUsers || []) {
        await this.sendWeeklyEngagement(user);
      }

      this.logger.log(`Sent weekly engagement to ${inactiveUsers?.length || 0} users`);
    } catch (error) {
      this.logger.error('Error in weeklyEngagementCheck:', error);
    }
  }

  /**
   * Send check-in notification to user
   */
  private async sendUserCheckIn(user: any) {
    try {
      const ikoContext = user.iko_context || {};
      const ongoingPlans = ikoContext.ongoing_plans || [];
      const hasUnfinishedPlans = ongoingPlans.some((plan: any) => plan.status !== 'completed');

      if (hasUnfinishedPlans) {
        // Create AI check-in notification
        await this.notificationsService.createNotification({
          user_id: user.id,
          type: NotificationType.AI_CHECKIN,
          priority: NotificationPriority.MEDIUM,
          title: '👋 Iko checking in!',
          message: "I noticed you have some ongoing plans. Need help completing them or want to add something new?",
          data: {
            action_type: 'open_ai_chat',
            source: 'iko_scheduler',
            check_type: 'ongoing_plans'
          }
        });

        this.logger.log(`Sent check-in notification to user ${user.id}`);
      }
    } catch (error) {
      this.logger.error(`Error sending check-in to user ${user.id}:`, error);
    }
  }

  /**
   * Process plan reminders for a user
   */
  private async processUserPlanReminders(user: any, now: Date) {
    try {
      const ikoContext = user.iko_context || {};
      const ongoingPlans = ikoContext.ongoing_plans || [];

      for (const plan of ongoingPlans) {
        // Check if plan has a due date approaching
        if (plan.due_date && plan.status !== 'completed') {
          const dueDate = new Date(plan.due_date);
          const timeUntilDue = dueDate.getTime() - now.getTime();
          const hoursUntilDue = timeUntilDue / (1000 * 60 * 60);

          // Send reminder if due within 24 hours
          if (hoursUntilDue > 0 && hoursUntilDue <= 24) {
            await this.notificationsService.createNotification({
              user_id: user.id,
              type: NotificationType.AI_REMINDER,
              priority: NotificationPriority.HIGH,
              title: '⏰ Plan reminder from Iko',
              message: `Your plan "${plan.title}" is due ${hoursUntilDue < 1 ? 'soon' : 'in ' + Math.round(hoursUntilDue) + ' hours'}!`,
              data: {
                action_type: 'open_ai_chat',
                source: 'iko_scheduler',
                plan_id: plan.id,
                check_type: 'plan_reminder'
              }
            });

            this.logger.log(`Sent plan reminder to user ${user.id} for plan ${plan.id}`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error processing plan reminders for user ${user.id}:`, error);
    }
  }

  /**
   * Send weekly engagement notification
   */
  private async sendWeeklyEngagement(user: any) {
    try {
      const messages = [
        "🌟 Missing our chats! What's new this week?",
        "💭 Thinking of you! Any plans I can help with?",
        "🎯 Ready to tackle some goals together?",
        "🛍️ Found some amazing deals you might like!",
        "📅 Want to plan something fun for the week ahead?"
      ];

      const randomMessage = messages[Math.floor(Math.random() * messages.length)];

      await this.notificationsService.createNotification({
        user_id: user.id,
        type: NotificationType.AI_ENGAGEMENT,
        priority: NotificationPriority.LOW,
        title: 'Iko misses you! 🤖',
        message: randomMessage,
        data: {
          action_type: 'open_ai_chat',
          source: 'iko_scheduler',
          check_type: 'weekly_engagement'
        }
      });

      this.logger.log(`Sent weekly engagement to user ${user.id}`);
    } catch (error) {
      this.logger.error(`Error sending weekly engagement to user ${user.id}:`, error);
    }
  }

  /**
   * Clean up old Iko data (monthly on 1st at 2 AM)
   */
  @Cron('0 2 1 * *') // Monthly on 1st at 2 AM
  async cleanupOldData() {
    try {
      this.logger.log('Cleaning up old Iko data...');

      const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      // Archive old completed plans
      const { error: updateError } = await this.supabase
        .from('user_profiles')
        .update({
          iko_context: this.supabase.rpc('filter_old_completed_plans', {
            cutoff_date: threeMonthsAgo.toISOString()
          })
        })
        .not('iko_context->ongoing_plans', 'is', null);

      if (updateError) {
        this.logger.error('Error cleaning up old plans:', updateError);
      } else {
        this.logger.log('Successfully cleaned up old completed plans');
      }
    } catch (error) {
      this.logger.error('Error in cleanupOldData:', error);
    }
  }
}