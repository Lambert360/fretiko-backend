import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';

/**
 * Admin Service
 * Platform-wide analytics and revenue tracking for administrators
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Verify user is an admin (check user_profiles.role)
   */
  async verifyAdmin(userId: string): Promise<boolean> {
    const { data: profile } = await this.supabase
      .from('user_profiles')
      .select('role, preferences')
      .eq('id', userId)
      .single();

    // Check if user has admin role
    const isAdmin = profile?.role === 'admin' || profile?.preferences?.isAdmin === true;
    
    if (!isAdmin) {
      this.logger.warn(`Unauthorized admin access attempt by user ${userId}`);
      throw new UnauthorizedException('Admin access required');
    }

    return true;
  }

  /**
   * Get platform-wide revenue analytics
   */
  async getPlatformRevenue(userId: string, dateRange?: { start: string; end: string }) {
    await this.verifyAdmin(userId);

    const startDate = dateRange?.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = dateRange?.end || new Date().toISOString();

    this.logger.log(`Fetching platform revenue from ${startDate} to ${endDate}`);

    // 1. Get all escrows with platform fees
    const { data: escrows } = await this.supabase
      .from('escrows')
      .select(`
        id,
        platform_amount,
        status,
        created_at,
        released_at,
        orders!inner(
          id,
          order_number,
          source,
          vendor_id,
          buyer_id
        )
      `)
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    // Calculate revenue by status
    const releasedEscrows = escrows?.filter(e => e.status === 'released') || [];
    const heldEscrows = escrows?.filter(e => e.status === 'held') || [];
    const refundedEscrows = escrows?.filter(e => e.status === 'refunded') || [];

    const totalPlatformFees = escrows?.reduce((sum, e) => sum + parseFloat(e.platform_amount || '0'), 0) || 0;
    const realizedRevenue = releasedEscrows.reduce((sum, e) => sum + parseFloat(e.platform_amount || '0'), 0);
    const pendingRevenue = heldEscrows.reduce((sum, e) => sum + parseFloat(e.platform_amount || '0'), 0);
    const lostRevenue = refundedEscrows.reduce((sum, e) => sum + parseFloat(e.platform_amount || '0'), 0);

    // 2. Calculate revenue by order source
    const revenueBySource = {
      regular: 0,
      live_stream: 0,
      auction: 0,
      service_booking: 0,
      invoice: 0,
    };

    escrows?.forEach(e => {
      const source = e.orders?.source || 'regular';
      const amount = parseFloat(e.platform_amount || '0');
      if (e.status === 'released') {
        revenueBySource[source] = (revenueBySource[source] || 0) + amount;
      }
    });

    // 3. Get top vendors by fees paid
    const vendorFees = {};
    escrows?.forEach(e => {
      const vendorId = e.orders?.vendor_id;
      if (!vendorId || e.status !== 'released') return;
      
      const amount = parseFloat(e.platform_amount || '0');
      vendorFees[vendorId] = (vendorFees[vendorId] || 0) + amount;
    });

    // Sort and get top 10 vendors
    const sortedVendors = Object.entries(vendorFees)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 10);

    // Get vendor details
    const topVendors = await Promise.all(
      sortedVendors.map(async ([vendorId, fees]) => {
        const { data: profile } = await this.supabase
          .from('user_profiles')
          .select('id, username, email, avatar_url')
          .eq('id', vendorId)
          .single();

        return {
          vendorId,
          vendorName: profile?.username || 'Unknown',
          vendorEmail: profile?.email,
          totalFeesPaid: fees,
        };
      })
    );

    // 4. Calculate transaction counts
    const transactionCounts = {
      total: escrows?.length || 0,
      released: releasedEscrows.length,
      held: heldEscrows.length,
      refunded: refundedEscrows.length,
    };

    // 5. Calculate average fee per transaction
    const averageFeePerTransaction = transactionCounts.released > 0
      ? realizedRevenue / transactionCounts.released
      : 0;

    // 6. Get daily revenue breakdown
    const dailyRevenue: Array<{ date: string; revenue: number }> = [];
    const dailyRevenueMap: Record<string, number> = {};

    releasedEscrows.forEach(e => {
      if (!e.released_at) return;
      const date = new Date(e.released_at).toISOString().split('T')[0];
      const amount = parseFloat(e.platform_amount || '0');
      dailyRevenueMap[date] = (dailyRevenueMap[date] || 0) + amount;
    });

    Object.entries(dailyRevenueMap)
      .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
      .forEach(([date, revenue]) => {
        dailyRevenue.push({ date, revenue: revenue as number });
      });

    return {
      summary: {
        totalPlatformFees,
        realizedRevenue,
        pendingRevenue,
        lostRevenue,
        averageFeePerTransaction,
      },
      transactionCounts,
      revenueBySource,
      topVendors,
      dailyRevenue,
      dateRange: { start: startDate, end: endDate },
    };
  }

  /**
   * Get escrow health metrics
   */
  async getEscrowHealth(userId: string) {
    await this.verifyAdmin(userId);

    this.logger.log('Fetching escrow health metrics');

    const { data: allEscrows } = await this.supabase
      .from('escrows')
      .select(`
        id,
        total_amount,
        status,
        created_at,
        released_at,
        auto_release_at,
        dispute_reason
      `);

    const heldEscrows = allEscrows?.filter(e => e.status === 'held') || [];
    const releasedEscrows = allEscrows?.filter(e => e.status === 'released') || [];
    const disputedEscrows = allEscrows?.filter(e => e.status === 'dispute') || [];
    const refundedEscrows = allEscrows?.filter(e => e.status === 'refunded') || [];

    // Calculate total funds in escrow
    const totalInEscrow = heldEscrows.reduce((sum, e) => sum + parseFloat(e.total_amount || '0'), 0);

    // Calculate average hold time
    const holdTimes = releasedEscrows
      .filter(e => e.created_at && e.released_at)
      .map(e => {
        const created = new Date(e.created_at).getTime();
        const released = new Date(e.released_at).getTime();
        return (released - created) / (1000 * 60 * 60); // Hours
      });

    const averageHoldTimeHours = holdTimes.length > 0
      ? holdTimes.reduce((sum, time) => sum + time, 0) / holdTimes.length
      : 0;

    // Check for overdue escrows (auto_release_at passed but still held)
    const now = new Date().getTime();
    const overdueEscrows = heldEscrows.filter(e => 
      e.auto_release_at && new Date(e.auto_release_at).getTime() < now
    );

    // Calculate dispute rate
    const totalEscrowsCount = allEscrows?.length || 0;
    const disputeRate = totalEscrowsCount > 0
      ? (disputedEscrows.length / totalEscrowsCount) * 100
      : 0;

    // Calculate refund rate
    const refundRate = totalEscrowsCount > 0
      ? (refundedEscrows.length / totalEscrowsCount) * 100
      : 0;

    return {
      totalInEscrow,
      escrowCounts: {
        total: totalEscrowsCount,
        held: heldEscrows.length,
        released: releasedEscrows.length,
        disputed: disputedEscrows.length,
        refunded: refundedEscrows.length,
        overdue: overdueEscrows.length,
      },
      metrics: {
        averageHoldTimeHours: Math.round(averageHoldTimeHours * 10) / 10,
        disputeRate: Math.round(disputeRate * 10) / 10,
        refundRate: Math.round(refundRate * 10) / 10,
      },
      overdueEscrows: overdueEscrows.map(e => ({
        escrowId: e.id,
        amount: parseFloat(e.total_amount || '0'),
        autoReleaseAt: e.auto_release_at,
        hoursOverdue: Math.round((now - new Date(e.auto_release_at).getTime()) / (1000 * 60 * 60)),
      })),
    };
  }

  /**
   * Get active disputes for admin resolution
   */
  async getActiveDisputes(userId: string) {
    await this.verifyAdmin(userId);

    this.logger.log('Fetching active disputes');

    const { data: disputes } = await this.supabase
      .from('disputes')
      .select(`
        *,
        order:orders!inner(
          id,
          order_number,
          total_amount,
          vendor_id,
          buyer_id
        ),
        complainant:user_profiles!complainant_id(username, email, phone),
        respondent:user_profiles!respondent_id(username, email, phone)
      `)
      .eq('status', 'open')
      .order('created_at', { ascending: false });

    return disputes?.map(d => ({
      disputeId: d.id,
      orderNumber: d.order?.order_number,
      orderAmount: d.order?.total_amount,
      disputeType: d.dispute_type,
      reason: d.reason,
      complainant: {
        id: d.complainant_id,
        name: d.complainant?.username,
        email: d.complainant?.email,
        phone: d.complainant?.phone,
      },
      respondent: {
        id: d.respondent_id,
        name: d.respondent?.username,
        email: d.respondent?.email,
        phone: d.respondent?.phone,
      },
      createdAt: d.created_at,
      evidence: d.evidence,
      adminNotes: d.admin_notes,
    })) || [];
  }

  /**
   * Get platform-wide statistics
   */
  async getPlatformStats(userId: string) {
    await this.verifyAdmin(userId);

    this.logger.log('Fetching platform statistics');

    // Get user counts
    const { count: totalUsers } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true });

    const { count: totalVendors } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .or('role.eq.vendor,preferences->>isVendor.eq.true');

    const { count: totalRiders } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .or('role.eq.rider,preferences->>isRider.eq.true');

    // Get order counts
    const { count: totalOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true });

    const { count: completedOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed');

    // Get wallet totals
    const { data: wallets } = await this.supabase
      .from('wallets')
      .select('available_balance, escrow_balance, pending_withdrawal');

    const totalWalletBalance = wallets?.reduce(
      (sum, w) => sum + parseFloat(w.available_balance || '0'),
      0
    ) || 0;

    const totalEscrowBalance = wallets?.reduce(
      (sum, w) => sum + parseFloat(w.escrow_balance || '0'),
      0
    ) || 0;

    const totalPendingWithdrawals = wallets?.reduce(
      (sum, w) => sum + parseFloat(w.pending_withdrawal || '0'),
      0
    ) || 0;

    return {
      users: {
        total: totalUsers || 0,
        vendors: totalVendors || 0,
        riders: totalRiders || 0,
      },
      orders: {
        total: totalOrders || 0,
        completed: completedOrders || 0,
        completionRate: totalOrders > 0 ? Math.round((completedOrders / totalOrders) * 100 * 10) / 10 : 0,
      },
      wallets: {
        totalBalance: totalWalletBalance,
        totalInEscrow: totalEscrowBalance,
        totalPendingWithdrawals: totalPendingWithdrawals,
      },
    };
  }
}

