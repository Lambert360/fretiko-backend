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
        // Skip completed or cancelled plans
        if (plan.status === 'completed' || plan.status === 'cancelled') {
          continue;
        }

        // Support both old (due_date) and new (scheduledFor) formats
        const scheduledDate = plan.scheduledFor || plan.due_date;
        
        if (scheduledDate) {
          const dueDate = new Date(scheduledDate);
          const timeUntilDue = dueDate.getTime() - now.getTime();
          const minutesUntilDue = timeUntilDue / (1000 * 60);
          const hoursUntilDue = minutesUntilDue / 60;

          // Get reminder window (default 1440 minutes = 24 hours)
          const reminderBefore = plan.reminderBefore || 1440; // minutes

          // Check if reminder was already sent
          const reminderSent = plan.notes?.includes('REMINDER_SENT');

          // Send reminder if within reminder window and not yet sent
          if (minutesUntilDue > 0 && minutesUntilDue <= reminderBefore && !reminderSent) {
            const timeMessage = this.formatTimeUntil(minutesUntilDue);
            const activityEmoji = this.getActivityEmoji(plan.type);

            await this.notificationsService.createNotification({
              user_id: user.id,
              type: NotificationType.AI_REMINDER,
              priority: NotificationPriority.HIGH,
              title: `${activityEmoji} Reminder from IKO`,
              message: `Your ${plan.type || 'activity'} "${plan.title}" is ${timeMessage}!`,
              data: {
                action_type: 'open_ai_chat',
                source: 'iko_scheduler',
                plan_id: plan.id,
                plan_type: plan.type,
                check_type: 'plan_reminder'
              }
            });

            // Mark reminder as sent
            await this.markReminderAsSent(user.id, plan.id);

            this.logger.log(`Sent plan reminder to user ${user.id} for plan ${plan.id}`);
          }

          // Auto-update status to in_progress if time has arrived
          if (timeUntilDue <= 0 && timeUntilDue > -60 * 60 * 1000 && plan.status === 'pending') {
            await this.updatePlanStatus(user.id, plan.id, 'in_progress');
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error processing plan reminders for user ${user.id}:`, error);
    }
  }

  /**
   * Mark reminder as sent for a plan
   */
  private async markReminderAsSent(userId: string, planId: string) {
    try {
      // Get current context
      const { data: profile } = await this.supabase
        .from('user_profiles')
        .select('iko_context')
        .eq('id', userId)
        .single();

      if (!profile) return;

      const context = profile.iko_context || {};
      const ongoingPlans = context.ongoing_plans || [];

      // Update the specific plan
      const updatedPlans = ongoingPlans.map((plan: any) => {
        if (plan.id === planId) {
          return {
            ...plan,
            notes: (plan.notes || '') + ' REMINDER_SENT',
            updatedAt: new Date().toISOString(),
          };
        }
        return plan;
      });

      // Save updated context
      await this.supabase
        .from('user_profiles')
        .update({
          iko_context: {
            ...context,
            ongoing_plans: updatedPlans,
          },
        })
        .eq('id', userId);
    } catch (error) {
      this.logger.error(`Error marking reminder as sent for plan ${planId}:`, error);
    }
  }

  /**
   * Update plan status
   */
  private async updatePlanStatus(userId: string, planId: string, newStatus: string) {
    try {
      // Get current context
      const { data: profile } = await this.supabase
        .from('user_profiles')
        .select('iko_context')
        .eq('id', userId)
        .single();

      if (!profile) return;

      const context = profile.iko_context || {};
      const ongoingPlans = context.ongoing_plans || [];

      // Update the specific plan
      const updatedPlans = ongoingPlans.map((plan: any) => {
        if (plan.id === planId) {
          return {
            ...plan,
            status: newStatus,
            updatedAt: new Date().toISOString(),
          };
        }
        return plan;
      });

      // Save updated context
      await this.supabase
        .from('user_profiles')
        .update({
          iko_context: {
            ...context,
            ongoing_plans: updatedPlans,
          },
        })
        .eq('id', userId);

      this.logger.log(`Updated plan ${planId} status to ${newStatus} for user ${userId}`);
    } catch (error) {
      this.logger.error(`Error updating plan status for plan ${planId}:`, error);
    }
  }

  /**
   * Format time until due in a human-readable way
   */
  private formatTimeUntil(minutes: number): string {
    if (minutes < 60) {
      return `due in ${Math.round(minutes)} minutes`;
    } else if (minutes < 1440) {
      const hours = Math.round(minutes / 60);
      return `due in ${hours} hour${hours !== 1 ? 's' : ''}`;
    } else {
      const days = Math.round(minutes / 1440);
      return `due in ${days} day${days !== 1 ? 's' : ''}`;
    }
  }

  /**
   * Get emoji for activity type
   */
  private getActivityEmoji(type: string): string {
    const emojiMap: { [key: string]: string } = {
      'meal_plan': '🍽️',
      'reminder': '⏰',
      'purchase': '🛒',
      'event': '📅',
      'task': '✅',
    };
    return emojiMap[type] || '📌';
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