import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, SupabaseClient } from '../shared/supabase.client';
import { RewardsService } from '../rewards/rewards.service';

export interface LiveSalesEventConfig {
  id: string;
  watch_rewards_enabled: boolean;
  watch_time_minutes: number;
  freti_per_reward: number;
  daily_cap_per_user: number;
  per_stream_cap_per_user: number;
  notifications_enabled: boolean;
  leaderboard_enabled: boolean;
  default_order_weight: number;
  default_viewer_weight: number;
  default_revenue_weight: number;
  special_event_enabled: boolean;
  special_event_name?: string;
  special_event_start_at?: string;
  special_event_end_at?: string;
  special_event_order_weight: number;
  special_event_viewer_weight: number;
  special_event_revenue_weight: number;
  created_at: string;
  updated_at: string;
}

export interface UpdateEventConfigDto {
  watch_rewards_enabled?: boolean;
  watch_time_minutes?: number;
  freti_per_reward?: number;
  daily_cap_per_user?: number;
  per_stream_cap_per_user?: number;
  notifications_enabled?: boolean;
  leaderboard_enabled?: boolean;
  default_order_weight?: number;
  default_viewer_weight?: number;
  default_revenue_weight?: number;
  special_event_enabled?: boolean;
  special_event_name?: string;
  special_event_start_at?: string;
  special_event_end_at?: string;
  special_event_order_weight?: number;
  special_event_viewer_weight?: number;
  special_event_revenue_weight?: number;
}

export interface ViewerRewardProgress {
  stream_id: string;
  user_id: string;
  session_start: string;
  minutes_accrued: number;
  total_credited_freti: number;
  watch_time_minutes: number;
  seconds_remaining: number;
}

export interface VendorLeaderboardEntry {
  vendor_id: string;
  vendor_name: string;
  avatar_url?: string;
  rank: number;
  score: number;
  total_streams: number;
  total_orders: number;
  total_viewers: number;
  total_revenue: number;
  orders_per_stream: number;
  avg_viewers_per_stream: number;
  revenue_per_stream: number;
  is_live?: boolean;
  stream_id?: string;
}

@Injectable()
export class LiveSalesGamificationService {
  private readonly logger = new Logger(LiveSalesGamificationService.name);
  private readonly supabase: SupabaseClient;
  private readonly GRACE_PERIOD_SECONDS = 30;

  constructor(
    private readonly configService: ConfigService,
    private readonly rewardsService: RewardsService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  // =====================
  // CONFIG
  // =====================

  async getEventConfig(): Promise<LiveSalesEventConfig | null> {
    try {
      const { data, error } = await this.supabase
        .from('live_sales_event_config')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      return data as LiveSalesEventConfig | null;
    } catch (error) {
      this.logger.error('Error fetching live sales event config:', error);
      throw new BadRequestException('Failed to fetch live sales event config');
    }
  }

  async updateEventConfig(staffId: string, dto: UpdateEventConfigDto): Promise<LiveSalesEventConfig> {
    // Verify staff permissions can be added here if needed
    const config = await this.getEventConfig();
    if (!config) {
      throw new NotFoundException('Live sales event config not found');
    }

    const update: any = { updated_at: new Date().toISOString() };

    if (dto.watch_rewards_enabled !== undefined) update.watch_rewards_enabled = dto.watch_rewards_enabled;
    if (dto.watch_time_minutes !== undefined) update.watch_time_minutes = dto.watch_time_minutes;
    if (dto.freti_per_reward !== undefined) update.freti_per_reward = dto.freti_per_reward;
    if (dto.daily_cap_per_user !== undefined) update.daily_cap_per_user = dto.daily_cap_per_user;
    if (dto.per_stream_cap_per_user !== undefined) update.per_stream_cap_per_user = dto.per_stream_cap_per_user;
    if (dto.notifications_enabled !== undefined) update.notifications_enabled = dto.notifications_enabled;
    if (dto.leaderboard_enabled !== undefined) update.leaderboard_enabled = dto.leaderboard_enabled;
    if (dto.default_order_weight !== undefined) update.default_order_weight = dto.default_order_weight;
    if (dto.default_viewer_weight !== undefined) update.default_viewer_weight = dto.default_viewer_weight;
    if (dto.default_revenue_weight !== undefined) update.default_revenue_weight = dto.default_revenue_weight;
    if (dto.special_event_enabled !== undefined) update.special_event_enabled = dto.special_event_enabled;
    if (dto.special_event_name !== undefined) update.special_event_name = dto.special_event_name;
    if (dto.special_event_start_at !== undefined) update.special_event_start_at = dto.special_event_start_at;
    if (dto.special_event_end_at !== undefined) update.special_event_end_at = dto.special_event_end_at;
    if (dto.special_event_order_weight !== undefined) update.special_event_order_weight = dto.special_event_order_weight;
    if (dto.special_event_viewer_weight !== undefined) update.special_event_viewer_weight = dto.special_event_viewer_weight;
    if (dto.special_event_revenue_weight !== undefined) update.special_event_revenue_weight = dto.special_event_revenue_weight;

    try {
      const { data, error } = await this.supabase
        .from('live_sales_event_config')
        .update(update)
        .eq('id', config.id)
        .select()
        .single();

      if (error) throw error;
      return data as LiveSalesEventConfig;
    } catch (error) {
      this.logger.error('Error updating live sales event config:', error);
      throw new BadRequestException('Failed to update live sales event config');
    }
  }

  // =====================
  // VIEWER JOIN / LEAVE (grace period)
  // =====================

  async onViewerJoin(streamId: string, userId: string, accessToken?: string): Promise<void> {
    try {
      const now = new Date().toISOString();

      const { data: existing, error: fetchError } = await this.supabase
        .from('live_stream_viewer_reward_progress')
        .select('*')
        .eq('stream_id', streamId)
        .eq('user_id', userId)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') {
        this.logger.warn(`Error fetching viewer reward progress: ${fetchError.message}`);
      }

      if (existing && existing.session_start) {
        // If the viewer has a recent session with less than GRACE_PERIOD_SECONDS elapsed, resume it
        const lastActive = existing.updated_at || existing.session_start;
        const elapsedSeconds = (new Date(now).getTime() - new Date(lastActive).getTime()) / 1000;

        if (elapsedSeconds <= this.GRACE_PERIOD_SECONDS) {
          const { error } = await this.supabase
            .from('live_stream_viewer_reward_progress')
            .update({ updated_at: now })
            .eq('id', existing.id);

          if (error) this.logger.warn(`Error resuming viewer progress: ${error.message}`);
          return;
        }
      }

      // Reset or create progress
      const { error } = await this.supabase
        .from('live_stream_viewer_reward_progress')
        .upsert({
          stream_id: streamId,
          user_id: userId,
          session_start: now,
          minutes_accrued: 0,
          last_credited_at: null,
          total_credited_freti: 0,
          updated_at: now,
        }, {
          onConflict: 'stream_id,user_id',
        });

      if (error) this.logger.warn(`Error upserting viewer progress: ${error.message}`);
    } catch (error) {
      this.logger.error(`Error in onViewerJoin for stream ${streamId} user ${userId}:`, error);
    }
  }

  async onViewerLeave(streamId: string, userId: string): Promise<void> {
    try {
      // Do not delete immediately; the batch job will delete after the grace period expires
      const { error } = await this.supabase
        .from('live_stream_viewer_reward_progress')
        .update({ updated_at: new Date().toISOString() })
        .eq('stream_id', streamId)
        .eq('user_id', userId);

      if (error) this.logger.warn(`Error updating viewer leave progress: ${error.message}`);
    } catch (error) {
      this.logger.error(`Error in onViewerLeave for stream ${streamId} user ${userId}:`, error);
    }
  }

  // =====================
  // VIEWER PROGRESS (PUBLIC)
  // =====================

  async getViewerProgress(streamId: string, userId: string): Promise<ViewerRewardProgress | null> {
    const config = await this.getEventConfig();
    if (!config || !config.watch_rewards_enabled) return null;

    try {
      const { data: progress, error } = await this.supabase
        .from('live_stream_viewer_reward_progress')
        .select('*')
        .eq('stream_id', streamId)
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        this.logger.warn(`Error fetching progress: ${error.message}`);
      }

      if (!progress) return null;

      const now = new Date().getTime();
      const sessionStart = new Date(progress.session_start).getTime();
      const elapsedSeconds = Math.floor((now - sessionStart) / 1000);
      const targetSeconds = config.watch_time_minutes * 60;

      const secondsSinceLastCredit = progress.last_credited_at
        ? Math.floor((now - new Date(progress.last_credited_at).getTime()) / 1000)
        : elapsedSeconds;

      const secondsRemaining = Math.max(0, targetSeconds - secondsSinceLastCredit);

      return {
        stream_id: streamId,
        user_id: userId,
        session_start: progress.session_start,
        minutes_accrued: Math.floor(elapsedSeconds / 60),
        total_credited_freti: progress.total_credited_freti || 0,
        watch_time_minutes: config.watch_time_minutes,
        seconds_remaining: secondsRemaining,
      };
    } catch (error) {
      this.logger.error(`Error fetching viewer progress:`, error);
      return null;
    }
  }

  // =====================
  // WATCH REWARDS BATCH
  // =====================

  @Cron(CronExpression.EVERY_5_MINUTES)
  async processWatchRewardsBatch(): Promise<void> {
    const config = await this.getEventConfig();
    if (!config || !config.watch_rewards_enabled) return;

    this.logger.log('Processing watch rewards batch...');
    const now = new Date();

    try {
      // Fetch active viewer progress rows that have not left the stream beyond the grace period
      const { data: activeViewers, error } = await this.supabase
        .from('live_stream_viewer_reward_progress')
        .select('*, stream:live_streams!stream_id(id, vendor_id, title, status)')
        .gt('updated_at', new Date(now.getTime() - this.GRACE_PERIOD_SECONDS * 1000 * 2).toISOString());

      if (error) throw error;
      if (!activeViewers || activeViewers.length === 0) return;

      for (const viewer of activeViewers) {
        // Check stream is still live
        if (viewer.stream?.status !== 'live') {
          // Clean up progress for non-live streams
          await this.supabase
            .from('live_stream_viewer_reward_progress')
            .delete()
            .eq('id', viewer.id);
          continue;
        }

        const sessionStart = new Date(viewer.session_start).getTime();
        const elapsedSeconds = Math.floor((now.getTime() - sessionStart) / 1000);
        const elapsedMinutes = Math.floor(elapsedSeconds / 60);
        const watchTimeMinutes = config.watch_time_minutes;

        if (elapsedMinutes <= (viewer.minutes_accrued || 0)) continue;

        // Determine how many completed intervals have passed
        const completedIntervals = Math.floor(elapsedMinutes / watchTimeMinutes);
        const lastCreditedInterval = viewer.last_credited_at
          ? Math.floor(viewer.minutes_accrued / watchTimeMinutes)
          : 0;

        const newIntervals = completedIntervals - lastCreditedInterval;
        if (newIntervals <= 0) continue;

        const perIntervalFreti = config.freti_per_reward;
        const totalFretiToCredit = newIntervals * perIntervalFreti;

        // Check caps
        const streamFreti = viewer.total_credited_freti || 0;
        if (config.per_stream_cap_per_user > 0 && streamFreti + totalFretiToCredit > config.per_stream_cap_per_user) {
          continue; // Skip per-stream cap exceeded
        }

        if (config.daily_cap_per_user > 0) {
          const dailyTotal = await this.getDailyWatchRewardTotal(viewer.user_id);
          if (dailyTotal + totalFretiToCredit > config.daily_cap_per_user) {
            continue;
          }
        }

        // Credit the reward
        const result = await this.rewardsService.creditLiveWatchReward(
          viewer.user_id,
          totalFretiToCredit,
          viewer.stream_id,
          viewer.stream?.title,
        );

        if (result.success) {
          const minutesToSet = completedIntervals * watchTimeMinutes;
          const totalCredited = streamFreti + totalFretiToCredit;

          await this.supabase
            .from('live_stream_viewer_reward_progress')
            .update({
              minutes_accrued: minutesToSet,
              last_credited_at: now.toISOString(),
              total_credited_freti: totalCredited,
              updated_at: now.toISOString(),
            })
            .eq('id', viewer.id);

          // Emit notification to the viewer if enabled
          if (config.notifications_enabled) {
            // TODO: emit via WebSocket or push notification
          }
        }
      }

      this.logger.log('Watch rewards batch complete');
    } catch (error) {
      this.logger.error('Error processing watch rewards batch:', error);
    }
  }

  private async getDailyWatchRewardTotal(userId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data, error } = await this.supabase
      .from('rewards_transactions')
      .select('available_delta')
      .eq('user_id', userId)
      .eq('transaction_type', 'live_watch_reward')
      .gte('created_at', startOfDay.toISOString());

    if (error) {
      this.logger.warn(`Error fetching daily watch reward total: ${error.message}`);
      return 0;
    }

    return (data || []).reduce((sum, tx) => sum + (tx.available_delta || 0), 0);
  }

  // Clean up stale progress after grace period
  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupStaleViewerProgress(): Promise<void> {
    const cutoff = new Date(new Date().getTime() - this.GRACE_PERIOD_SECONDS * 1000).toISOString();

    try {
      const { error } = await this.supabase
        .from('live_stream_viewer_reward_progress')
        .delete()
        .lt('updated_at', cutoff);

      if (error) this.logger.warn(`Error cleaning stale progress: ${error.message}`);
    } catch (error) {
      this.logger.error('Error cleaning stale viewer progress:', error);
    }
  }

  // =====================
  // VENDOR LEADERBOARD
  // =====================

  async getLeaderboard(
    period: 'daily' | 'weekly' | 'monthly' | 'event',
    eventName?: string,
    limit = 50,
  ): Promise<VendorLeaderboardEntry[]> {
    const config = await this.getEventConfig();
    if (!config || !config.leaderboard_enabled) return [];

    try {
      let query = this.supabase
        .from('vendor_leaderboard_cache')
        .select('*')
        .eq('period', period)
        .order('rank', { ascending: true })
        .limit(limit);

      if (period === 'event' && eventName) {
        query = query.eq('event_name', eventName);
      }

      const { data, error } = await query;
      if (error) throw error;

      const vendorIds = (data || []).map((entry: any) => entry.vendor_id);
      const liveStreamMap = new Map<string, string>();

      if (vendorIds.length > 0) {
        const { data: liveStreams, error: liveError } = await this.supabase
          .from('live_streams')
          .select('id, vendor_id')
          .eq('status', 'live')
          .in('vendor_id', vendorIds);

        if (liveError) {
          this.logger.error('Error fetching live streams for leaderboard:', liveError);
        } else {
          for (const stream of liveStreams || []) {
            if (!liveStreamMap.has(stream.vendor_id)) {
              liveStreamMap.set(stream.vendor_id, stream.id);
            }
          }
        }
      }

      return (data || []).map((entry: any) => ({
        vendor_id: entry.vendor_id,
        vendor_name: entry.vendor_name,
        avatar_url: entry.avatar_url,
        rank: entry.rank,
        score: entry.score,
        total_streams: entry.total_streams,
        total_orders: entry.total_orders,
        total_viewers: entry.total_viewers,
        total_revenue: entry.total_revenue,
        orders_per_stream: entry.orders_per_stream,
        avg_viewers_per_stream: entry.avg_viewers_per_stream,
        revenue_per_stream: entry.revenue_per_stream,
        is_live: liveStreamMap.has(entry.vendor_id),
        stream_id: liveStreamMap.get(entry.vendor_id),
      }));
    } catch (error) {
      this.logger.error('Error fetching leaderboard:', error);
      throw new BadRequestException('Failed to fetch leaderboard');
    }
  }

  @Cron('0 */15 * * * *')
  async recalculateLeaderboards(): Promise<void> {
    const config = await this.getEventConfig();
    if (!config || !config.leaderboard_enabled) return;

    this.logger.log('Recalculating vendor leaderboards...');

    try {
      await this.recalculatePeriod('daily', config);
      await this.recalculatePeriod('weekly', config);
      await this.recalculatePeriod('monthly', config);

      if (config.special_event_enabled && this.isSpecialEventActive(config)) {
        await this.recalculateSpecialEvent(config);
      }

      this.logger.log('Leaderboard recalculation complete');
    } catch (error) {
      this.logger.error('Error recalculating leaderboards:', error);
    }
  }

  private async recalculatePeriod(
    period: 'daily' | 'weekly' | 'monthly',
    config: LiveSalesEventConfig,
  ): Promise<void> {
    const { start, end } = this.getPeriodBounds(period);

    const vendors = await this.aggregateVendorStats(start, end);
    const scored = this.computeScores(
      vendors,
      config.default_order_weight,
      config.default_viewer_weight,
      config.default_revenue_weight,
    );

    await this.upsertLeaderboardCache(scored, period, start, end);
  }

  private async recalculateSpecialEvent(config: LiveSalesEventConfig): Promise<void> {
    if (!config.special_event_start_at || !config.special_event_end_at) return;

    const start = new Date(config.special_event_start_at);
    const end = new Date(config.special_event_end_at);

    const vendors = await this.aggregateVendorStats(start, end);
    const scored = this.computeScores(
      vendors,
      config.special_event_order_weight,
      config.special_event_viewer_weight,
      config.special_event_revenue_weight,
    );

    await this.upsertLeaderboardCache(scored, 'event', start, end, config.special_event_name);
  }

  private isSpecialEventActive(config: LiveSalesEventConfig): boolean {
    if (!config.special_event_enabled || !config.special_event_start_at || !config.special_event_end_at) return false;
    const now = new Date().getTime();
    const start = new Date(config.special_event_start_at).getTime();
    const end = new Date(config.special_event_end_at).getTime();
    return now >= start && now <= end;
  }

  private getPeriodBounds(period: 'daily' | 'weekly' | 'monthly'): { start: Date; end: Date } {
    const now = new Date();
    let start = new Date(now);

    if (period === 'daily') {
      start.setHours(0, 0, 0, 0);
    } else if (period === 'weekly') {
      const day = start.getDay();
      start.setDate(start.getDate() - day);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }

    return { start, end: now };
  }

  private async aggregateVendorStats(start: Date, end: Date): Promise<any[]> {
    const { data: streams, error } = await this.supabase
      .from('live_streams')
      .select(`
        id,
        vendor_id,
        title,
        started_at,
        ended_at,
        total_viewers,
        total_sales,
        products:live_stream_products!stream_id(sold_count),
        transactions:live_stream_transactions!stream_id(id, total_amount, status)
      `)
      .gte('started_at', start.toISOString())
      .lte('started_at', end.toISOString())
      .eq('status', 'ended');

    if (error) throw error;

    const vendorMap = new Map<string, any>();

    for (const stream of streams || []) {
      const vendorId = stream.vendor_id;
      if (!vendorMap.has(vendorId)) {
        vendorMap.set(vendorId, {
          vendor_id: vendorId,
          total_streams: 0,
          total_orders: 0,
          total_viewers: 0,
          total_revenue: 0,
        });
      }

      const v = vendorMap.get(vendorId);
      v.total_streams += 1;
      v.total_viewers += stream.total_viewers || 0;
      v.total_revenue += stream.total_sales || 0;

      for (const product of stream.products || []) {
        v.total_orders += product.sold_count || 0;
      }

      for (const tx of stream.transactions || []) {
        if (tx.status === 'paid' || tx.status === 'completed') {
          v.total_revenue += tx.total_amount || 0;
        }
      }
    }

    return Array.from(vendorMap.values());
  }

  private computeScores(
    vendors: any[],
    orderWeight: number,
    viewerWeight: number,
    revenueWeight: number,
  ): any[] {
    if (vendors.length === 0) return [];

    const maxOrders = Math.max(...vendors.map(v => v.total_orders / v.total_streams || 0), 1);
    const maxViewers = Math.max(...vendors.map(v => v.total_viewers / v.total_streams || 0), 1);
    const maxRevenue = Math.max(...vendors.map(v => v.total_revenue / v.total_streams || 0), 1);

    const scored = vendors.map(v => {
      const ordersPerStream = v.total_orders / v.total_streams || 0;
      const avgViewers = v.total_viewers / v.total_streams || 0;
      const revenuePerStream = v.total_revenue / v.total_streams || 0;

      const normalizedOrders = (ordersPerStream / maxOrders) * 100;
      const normalizedViewers = (avgViewers / maxViewers) * 100;
      const normalizedRevenue = (revenuePerStream / maxRevenue) * 100;

      const score =
        (normalizedOrders * orderWeight / 100) +
        (normalizedViewers * viewerWeight / 100) +
        (normalizedRevenue * revenueWeight / 100);

      return { ...v, orders_per_stream: ordersPerStream, avg_viewers_per_stream: avgViewers, revenue_per_stream: revenuePerStream, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map((v, idx) => ({ ...v, rank: idx + 1 }));
  }

  private async upsertLeaderboardCache(
    scored: any[],
    period: string,
    start: Date,
    end: Date,
    eventName?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    // Fetch vendor profiles
    const vendorIds = scored.map(s => s.vendor_id);
    const { data: profiles, error } = await this.supabase
      .from('user_profiles')
      .select('id, username, avatar_url')
      .in('id', vendorIds);

    if (error) throw error;

    const profileMap = new Map((profiles || []).map(p => [p.id, p]));

    const rows = scored.map(s => ({
      vendor_id: s.vendor_id,
      period,
      period_start: start.toISOString().split('T')[0],
      period_end: end.toISOString().split('T')[0],
      event_name: eventName || null,
      rank: s.rank,
      score: s.score,
      total_streams: s.total_streams,
      total_orders: s.total_orders,
      total_viewers: s.total_viewers,
      total_revenue: s.total_revenue,
      orders_per_stream: s.orders_per_stream,
      avg_viewers_per_stream: s.avg_viewers_per_stream,
      revenue_per_stream: s.revenue_per_stream,
      vendor_name: profileMap.get(s.vendor_id)?.username || 'Unknown Vendor',
      avatar_url: profileMap.get(s.vendor_id)?.avatar_url || null,
      updated_at: now,
    }));

    const { error: upsertError } = await this.supabase
      .from('vendor_leaderboard_cache')
      .upsert(rows, { onConflict: 'vendor_id,period,period_start,period_end,event_name' });

    if (upsertError) throw upsertError;
  }
}
