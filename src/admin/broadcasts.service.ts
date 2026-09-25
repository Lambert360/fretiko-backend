/**
 * BROADCASTS SERVICE
 * Admin-triggered (and cron auto-sent) promotional broadcasts to vendors
 * or all users.
 *
 * Delivery reuses the existing notification machinery:
 *   - in-app + push via NotificationHelperService.sendBroadcastNotification
 *     (type='promotion' → gated by promotion_notifications + push_enabled
 *     + quiet hours)
 *   - email via EmailNotificationService.sendUserEmail
 *     (type='promotion' → gated by email_enabled + email_promotion_notifications,
 *     deduped per send via email_reminders reminder_type='broadcast')
 *
 * Guardrails:
 *   - Global frequency cap: a user receives at most one broadcast every
 *     BROADCAST_FREQ_CAP_HOURS hours (checked on the in-app row's
 *     data.broadcast_send_id marker).
 *   - Per-template suppression: skip_if_listed_within_days skips vendors
 *     who created a product recently (don't nag active listers).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { EmailNotificationService } from '../notifications/email-notification.service';
import { broadcastEmail } from '../notifications/email-templates';

export type BroadcastAudience = 'vendors' | 'all_users';

export interface BroadcastDraft {
  subject: string;
  title: string;
  body: string;
  cta_label?: string | null;
  cta_url?: string | null;
}

export interface SendBroadcastInput {
  templateId?: string;
  draft?: BroadcastDraft;
  audience?: BroadcastAudience;
  sendPush?: boolean;
  sendEmail?: boolean;
  /** Values for {{custom1}} / {{custom2}} placeholders */
  variables?: Record<string, string>;
}

const BROADCAST_FREQ_CAP_HOURS = 48;
const PAGE_SIZE = 500;
const SEND_CONCURRENCY = 25;

@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);
  private supabase;
  private tableMissingWarned = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly notificationHelper: NotificationHelperService,
    private readonly emailNotificationService: EmailNotificationService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  // ============================================
  // TEMPLATE CRUD
  // ============================================

  async listTemplates() {
    const { data, error } = await this.supabase
      .from('broadcast_templates')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw this.tableError(error);
    return data;
  }

  async createTemplate(dto: Partial<any>, staffId?: string) {
    const { data, error } = await this.supabase
      .from('broadcast_templates')
      .insert({ ...dto, created_by: staffId || null })
      .select()
      .single();
    if (error) throw this.tableError(error);
    return data;
  }

  async updateTemplate(id: string, dto: Partial<any>) {
    const { data, error } = await this.supabase
      .from('broadcast_templates')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw this.tableError(error);
    return data;
  }

  async deleteTemplate(id: string) {
    const { error } = await this.supabase
      .from('broadcast_templates')
      .delete()
      .eq('id', id);
    if (error) throw this.tableError(error);
    return { success: true };
  }

  // ============================================
  // AUDIENCE
  // ============================================

  async getAudienceCount(audience: BroadcastAudience): Promise<number> {
    let query = this.supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true });
    if (audience === 'vendors') {
      query = query.or('user_role.eq.vendor,is_seller.eq.true');
    }
    const { count, error } = await query;
    if (error) throw this.tableError(error);
    return count || 0;
  }

  private async *iterAudience(audience: BroadcastAudience) {
    let from = 0;
    for (;;) {
      let query = this.supabase
        .from('user_profiles')
        .select('id, display_name, username')
        .range(from, from + PAGE_SIZE - 1);
      if (audience === 'vendors') {
        query = query.or('user_role.eq.vendor,is_seller.eq.true');
      }
      const { data, error } = await query;
      if (error) throw this.tableError(error);
      if (!data || data.length === 0) return;
      yield data as Array<{ id: string; display_name?: string; username?: string }>;
      if (data.length < PAGE_SIZE) return;
      from += PAGE_SIZE;
    }
  }

  // ============================================
  // SEND
  // ============================================

  async listSends(page = 1, limit = 20) {
    const from = (page - 1) * limit;
    const { data, error, count } = await this.supabase
      .from('broadcast_sends')
      .select('*, template:broadcast_templates(name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);
    if (error) throw this.tableError(error);
    return { sends: data, total: count || 0, page, limit };
  }

  /**
   * Create a broadcast_sends row, then fan out asynchronously.
   * Returns the send row immediately with status 'running'.
   */
  async sendBroadcast(input: SendBroadcastInput, staffId?: string, trigger: 'manual' | 'auto' = 'manual') {
    const resolved = await this.resolveContent(input);
    if ('error' in resolved) return resolved;

    const { template, content, audience, sendPush, sendEmail } = resolved;

    const { data: send, error } = await this.supabase
      .from('broadcast_sends')
      .insert({
        template_id: template?.id || null,
        trigger,
        sent_by: staffId || null,
        audience,
        subject: content.subject,
        title: content.title,
        body: content.body,
        cta_label: content.cta_label || null,
        cta_url: content.cta_url || null,
        status: 'running',
      })
      .select()
      .single();
    if (error) throw this.tableError(error);

    void this.runBroadcast(send.id, {
      audience,
      content,
      sendPush,
      sendEmail,
      variables: input.variables || {},
      skipIfListedWithinDays: template?.skip_if_listed_within_days || null,
    }).catch(async (err) => {
      this.logger.error(`Broadcast ${send.id} failed:`, err);
      await this.supabase
        .from('broadcast_sends')
        .update({ status: 'failed', completed_at: new Date().toISOString() })
        .eq('id', send.id);
    });

    return send;
  }

  /**
   * Synchronous single-user test send — bypasses frequency cap and
   * suppression rules so admins can preview delivery.
   */
  async testBroadcast(input: SendBroadcastInput, userId: string) {
    const resolved = await this.resolveContent(input);
    if ('error' in resolved) return resolved;

    const { content, sendPush, sendEmail } = resolved;
    const rendered = this.render(content, 'Test', input.variables || {});

    const delivered = await this.deliverToUser(userId, rendered, sendPush, sendEmail, null);
    return { success: true, userId, delivered };
  }

  // ============================================
  // AUTO-SEND (cron entry point)
  // ============================================

  async runAutoBroadcasts(): Promise<number> {
    const { data: templates, error } = await this.supabase
      .from('broadcast_templates')
      .select('*')
      .eq('is_active', true)
      .not('auto_cadence_days', 'is', null);
    if (error) {
      this.tableError(error); // logs + warns once if table missing
      return 0;
    }

    const now = Date.now();
    let launched = 0;

    for (const tpl of templates || []) {
      const due =
        !tpl.last_auto_sent_at ||
        now - new Date(tpl.last_auto_sent_at).getTime() >= tpl.auto_cadence_days * 86400_000;
      if (!due) continue;

      // Claim the slot up front so overlapping sweeps don't double-send
      await this.supabase
        .from('broadcast_templates')
        .update({ last_auto_sent_at: new Date().toISOString() })
        .eq('id', tpl.id);

      const send = await this.sendBroadcast(
        { templateId: tpl.id },
        undefined,
        'auto',
      );
      if (send && !('error' in send)) launched++;
    }

    return launched;
  }

  // ============================================
  // INTERNALS
  // ============================================

  private async resolveContent(input: SendBroadcastInput) {
    let template: any = null;
    if (input.templateId) {
      const { data, error } = await this.supabase
        .from('broadcast_templates')
        .select('*')
        .eq('id', input.templateId)
        .single();
      if (error || !data) return { error: 'Template not found' } as const;
      template = data;
    }

    const content: BroadcastDraft = input.draft || {
      subject: template.subject,
      title: template.title,
      body: template.body,
      cta_label: template.cta_label,
      cta_url: template.cta_url,
    };
    if (!content.title || !content.body || !content.subject) {
      return { error: 'Broadcast requires subject, title and body' } as const;
    }

    return {
      template,
      content,
      audience: input.audience || template?.audience || 'vendors',
      sendPush: input.sendPush ?? template?.send_push ?? true,
      sendEmail: input.sendEmail ?? template?.send_email ?? true,
    } as const;
  }

  private render(content: BroadcastDraft, name: string, variables: Record<string, string>) {
    const interpolate = (s: string) =>
      s
        .replace(/\{\{\s*name\s*\}\}/gi, name)
        .replace(/\{\{\s*custom1\s*\}\}/gi, variables.custom1 || '')
        .replace(/\{\{\s*custom2\s*\}\}/gi, variables.custom2 || '');
    return {
      subject: interpolate(content.subject),
      title: interpolate(content.title),
      body: interpolate(content.body),
      cta_label: content.cta_label ? interpolate(content.cta_label) : undefined,
      cta_url: content.cta_url || undefined,
    };
  }

  /** True when the user already received a broadcast within the cap window. */
  private async underFreqCap(userId: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - BROADCAST_FREQ_CAP_HOURS * 3600_000).toISOString();
    const { data } = await this.supabase
      .from('notifications')
      .select('id')
      .eq('user_id', userId)
      .eq('type', 'promotion')
      .not('data->>broadcast_send_id', 'is', null)
      .gt('created_at', cutoff)
      .limit(1);
    return !!data?.length;
  }

  /** True when the vendor listed a product inside the suppression window. */
  private async suppressedByActivity(userId: string, days: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const { data } = await this.supabase
      .from('products')
      .select('id')
      .eq('user_id', userId)
      .gt('created_at', cutoff)
      .limit(1);
    return !!data?.length;
  }

  /**
   * Deliver one rendered broadcast to one user.
   * sendId null = test send (no dedup key, no freq-cap bookkeeping needed).
   */
  private async deliverToUser(
    userId: string,
    rendered: ReturnType<BroadcastsService['render']>,
    sendPush: boolean,
    sendEmail: boolean,
    sendId: string | null,
  ): Promise<{ notification: boolean; email: boolean }> {
    const notification = await this.notificationHelper.sendBroadcastNotification(userId, {
      title: rendered.title,
      message: rendered.body,
      ctaLabel: rendered.cta_label,
      data: sendId ? { broadcast: true, broadcast_send_id: sendId } : { broadcast: true, test: true },
      sendPush,
      sendEmail: false, // email leg handled below with broadcast subject + dedup
    });

    let email = false;
    if (sendEmail) {
      email = await this.emailNotificationService.sendUserEmail(userId, {
        subject: rendered.subject,
        category: 'promotion',
        reminder: sendId
          ? { type: 'broadcast', entityType: 'broadcast_send', entityId: sendId }
          : undefined,
        buildHtml: () =>
          broadcastEmail({
            heading: rendered.title,
            body: rendered.body,
            ctaLabel: rendered.cta_label,
            ctaUrl: rendered.cta_url,
            appUrl: this.emailNotificationService.appUrl(),
          }),
      });
    }

    return { notification, email };
  }

  private async runBroadcast(
    sendId: string,
    cfg: {
      audience: BroadcastAudience;
      content: BroadcastDraft;
      sendPush: boolean;
      sendEmail: boolean;
      variables: Record<string, string>;
      skipIfListedWithinDays: number | null;
    },
  ) {
    let targeted = 0;
    let sent = 0;
    let suppressed = 0;
    let failed = 0;

    for await (const page of this.iterAudience(cfg.audience)) {
      for (let i = 0; i < page.length; i += SEND_CONCURRENCY) {
        const chunk = page.slice(i, i + SEND_CONCURRENCY);
        targeted += chunk.length;
        const results = await Promise.allSettled(
          chunk.map(async (user): Promise<'sent' | 'suppressed' | 'failed'> => {
            if (await this.underFreqCap(user.id)) return 'suppressed';
            if (cfg.skipIfListedWithinDays &&
                (await this.suppressedByActivity(user.id, cfg.skipIfListedWithinDays))) {
              return 'suppressed';
            }
            const name = user.display_name || user.username || 'there';
            const rendered = this.render(cfg.content, name, cfg.variables);
            const { notification, email } = await this.deliverToUser(
              user.id, rendered, cfg.sendPush, cfg.sendEmail, sendId,
            );
            return notification || email ? 'sent' : 'failed';
          }),
        );
        for (const r of results) {
          if (r.status === 'rejected' || r.value === 'failed') failed++;
          else if (r.value === 'suppressed') suppressed++;
          else sent++;
        }
      }

      // Persist counters per page so the admin UI shows live progress
      await this.supabase
        .from('broadcast_sends')
        .update({ targeted, sent, suppressed, failed })
        .eq('id', sendId);
    }

    await this.supabase
      .from('broadcast_sends')
      .update({ targeted, sent, suppressed, failed, status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', sendId);

    this.logger.log(
      `Broadcast ${sendId} complete: ${sent}/${targeted} sent, ${suppressed} suppressed, ${failed} failed`,
    );
  }

  private tableError(error: any): Error {
    if (error?.code === 'PGRST205' || error?.code === '42P01') {
      if (!this.tableMissingWarned) {
        this.tableMissingWarned = true;
        this.logger.warn('broadcast tables missing — apply migration 231 to enable broadcasts');
      }
      return new Error('Broadcast system not deployed yet (migration 231)');
    }
    return error instanceof Error ? error : new Error(String(error?.message || error));
  }
}
