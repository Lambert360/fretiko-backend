/**
 * FRETIKO EMAIL NOTIFICATION SERVICE
 * Sends transactional email reminders via Resend.
 *
 * - Resolves recipient addresses from Supabase Auth (auth.admin.getUserById)
 * - Gates sends on notification_settings.email_enabled plus the per-category
 *   email_*_notifications flag added by migration 230
 * - Dedups scheduled reminders through the email_reminders table; a claimed
 *   row is rolled back when the send fails so the next sweep retries
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationsService } from './notifications.service';

export type EmailCategory =
  | 'auction'
  | 'order'
  | 'payment'
  | 'delivery'
  | 'promotion'
  | 'live'
  | 'social'
  | 'system';

export interface ReminderKey {
  /** e.g. 'auction_win_checkout_24h' */
  type: string;
  /** e.g. 'auction_win' */
  entityType: string;
  entityId: string;
}

export interface SendUserEmailOptions {
  subject: string;
  category: EmailCategory;
  /** Builds the full HTML body; receives the user's display name if found */
  buildHtml: (ctx: { name?: string }) => string;
  /** Dedup key — when set, the email is sent at most once per entity
   *  (or once per resendAfterHours window) */
  reminder?: ReminderKey;
  /** Minimum hours between sends for the same reminder key (outbid etc.) */
  resendAfterHours?: number;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CATEGORY_FLAG: Record<EmailCategory, string> = {
  auction: 'email_auction_notifications',
  order: 'email_order_notifications',
  payment: 'email_payment_notifications',
  delivery: 'email_delivery_notifications',
  promotion: 'email_promotion_notifications',
  live: 'email_live_notifications',
  social: 'email_social_notifications',
  system: 'email_system_notifications',
};

@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);
  private supabase;
  private remindedTableMissing = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Base URL used for CTA links in emails.
   */
  appUrl(): string {
    return this.configService.get<string>('FRONTEND_URL') || 'https://fretiko.com';
  }

  /**
   * Resolve a user's email address from Supabase Auth.
   */
  async getUserEmail(userId: string): Promise<string | null> {
    const ctx = await this.getUserContext(userId);
    return ctx?.email || null;
  }

  /**
   * Email + display name in one auth lookup. Names live in auth.users
   * user_metadata (first_name/display_name) — user_profiles only carries
   * username, which is the fallback.
   */
  private async getUserContext(userId: string): Promise<{ email: string; name?: string } | null> {
    try {
      const { data: authUser, error } = await this.supabase.auth.admin.getUserById(userId);
      if (error || !authUser?.user?.email) {
        this.logger.warn(`No auth user/email for ${userId}: ${error?.message || 'not found'}`);
        return null;
      }
      const meta = authUser.user.user_metadata || {};
      const name: string | undefined =
        meta.first_name || meta.given_name || meta.display_name ||
        meta.full_name || meta.name || undefined;
      return { email: authUser.user.email, name };
    } catch (error) {
      this.logger.error(`Error fetching email for ${userId}: ${errMsg(error)}`);
      return null;
    }
  }

  private async getUsernameFallback(userId: string): Promise<string | undefined> {
    try {
      const { data } = await this.supabase
        .from('user_profiles')
        .select('username, display_name')
        .eq('id', userId)
        .maybeSingle();
      return data?.username || data?.display_name || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Master email_enabled switch plus the per-category flag.
   * Missing settings rows default to enabled (auto-created on demand).
   */
  private async isEmailEnabled(userId: string, category: EmailCategory): Promise<boolean> {
    try {
      const settings = await this.notificationsService.getUserSettings(userId);
      if (settings.email_enabled === false) return false;
      const flag = CATEGORY_FLAG[category];
      if (flag && (settings as any)[flag] === false) return false;
      return true;
    } catch (error) {
      // Fail closed on reads — a settings lookup error should not spam users
      this.logger.warn(`Email preference check failed for ${userId}: ${errMsg(error)}`);
      return false;
    }
  }

  /**
   * Claim the reminder slot before sending. Returns false when the reminder
   * was already sent (or is inside its resend cooldown). The claim is rolled
   * back by releaseReminder() when the actual send fails.
   *
   * If migration 230 has not been applied yet (email_reminders missing) we
   * fail closed — never send undeduped reminders on a fixed cron.
   */
  private async claimReminder(
    userId: string,
    reminder: ReminderKey,
    resendAfterHours?: number,
  ): Promise<boolean> {
    try {
      const { data: existing } = await this.supabase
        .from('email_reminders')
        .select('id, sent_at')
        .eq('user_id', userId)
        .eq('reminder_type', reminder.type)
        .eq('entity_type', reminder.entityType)
        .eq('entity_id', reminder.entityId)
        .maybeSingle();

      if (existing) {
        if (!resendAfterHours) return false;
        const cutoff = Date.now() - resendAfterHours * 3600_000;
        if (new Date(existing.sent_at).getTime() > cutoff) return false;
        await this.supabase
          .from('email_reminders')
          .update({ sent_at: new Date().toISOString() })
          .eq('id', existing.id);
        return true;
      }

      const { error } = await this.supabase.from('email_reminders').insert({
        user_id: userId,
        reminder_type: reminder.type,
        entity_type: reminder.entityType,
        entity_id: reminder.entityId,
      });

      if (error) {
        // 23505 = unique violation — another worker claimed it first
        if (error.code === '23505') return false;
        // PGRST205/42P01 = table missing — migration 230 not deployed yet
        if (error.code === 'PGRST205' || error.code === '42P01') {
          if (!this.remindedTableMissing) {
            this.remindedTableMissing = true;
            this.logger.warn('email_reminders table missing — apply migration 230 to enable email reminders');
          }
          return false;
        }
        this.logger.warn(`Failed to claim email reminder: ${error.message}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(`Reminder claim failed: ${errMsg(error)}`);
      return false;
    }
  }

  private async releaseReminder(userId: string, reminder: ReminderKey): Promise<void> {
    try {
      await this.supabase
        .from('email_reminders')
        .delete()
        .eq('user_id', userId)
        .eq('reminder_type', reminder.type)
        .eq('entity_type', reminder.entityType)
        .eq('entity_id', reminder.entityId);
    } catch {
      /* best-effort rollback */
    }
  }

  /**
   * Low-level Resend send. Follows the same fetch pattern as
   * auth/email.service.ts — no SDK dependency.
   */
  async sendRawEmail(to: string, subject: string, html: string): Promise<boolean> {
    const resendApiKey = this.configService.get<string>('RESEND_API_KEY');
    const resendFromEmail = this.configService.get<string>('RESEND_FROM_EMAIL');

    if (!resendApiKey || !resendFromEmail) {
      this.logger.warn('Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL) — skipping email');
      return false;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `Fretiko <${resendFromEmail}>`,
          to: [to],
          subject,
          html,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => null);
        this.logger.error(`Resend API error ${response.status}: ${JSON.stringify(result)}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Resend send failed: ${errMsg(error)}`);
      return false;
    }
  }

  /**
   * Send a templated email to a user: preference check → dedup claim →
   * resolve address + name → send → release claim on failure.
   */
  async sendUserEmail(userId: string, opts: SendUserEmailOptions): Promise<boolean> {
    try {
      if (!(await this.isEmailEnabled(userId, opts.category))) return false;

      if (opts.reminder) {
        const claimed = await this.claimReminder(userId, opts.reminder, opts.resendAfterHours);
        if (!claimed) return false;
      }

      const ctx = await this.getUserContext(userId);
      if (!ctx) {
        if (opts.reminder) await this.releaseReminder(userId, opts.reminder);
        return false;
      }

      const name = ctx.name || (await this.getUsernameFallback(userId));
      const html = opts.buildHtml({ name });
      const sent = await this.sendRawEmail(ctx.email, opts.subject, html);

      if (!sent && opts.reminder) {
        await this.releaseReminder(userId, opts.reminder);
      } else if (sent) {
        this.logger.log(`Sent '${opts.reminder?.type || opts.subject}' email to ${ctx.email}`);
      }
      return sent;
    } catch (error) {
      this.logger.error(`sendUserEmail failed for ${userId}: ${errMsg(error)}`);
      if (opts.reminder) await this.releaseReminder(userId, opts.reminder);
      return false;
    }
  }
}
