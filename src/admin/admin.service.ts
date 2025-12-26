import { Injectable, Logger, UnauthorizedException, NotFoundException, Inject, forwardRef, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditEntityType, AuditStatus } from '../audit/dto/audit.dto';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { WalletService } from '../wallet/wallet.service';
import { EmailService } from '../shared/email.service';

/**
 * Admin Service
 * Platform-wide analytics and revenue tracking for administrators
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => AuditService))
    private auditService: AuditService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => WalletService))
    private walletService: WalletService,
    private emailService: EmailService,
  ) {
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
   * Get platform revenue for staff (staff version)
   */
  async getPlatformRevenueForStaff(staffId: string, dateRange?: { start: string; end: string }) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);

    const startDate = dateRange?.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = dateRange?.end || new Date().toISOString();

    this.logger.log(`Staff ${staffId} fetching platform revenue from ${startDate} to ${endDate}`);

    // 1. Get all escrows with platform fees
    // Use released_at for date filtering to match when revenue was actually realized
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
      .not('released_at', 'is', null) // Only include escrows that have been released
      .gte('released_at', startDate)
      .lte('released_at', endDate);

    // Calculate revenue by status
    // Since we filtered by released_at, all escrows should be released
    const realizedRevenue = escrows?.reduce((sum, e) => {
      if (e.status === 'released') {
        return sum + parseFloat(e.platform_amount || '0');
      }
      return sum;
    }, 0) || 0;

    // For pending and lost revenue, query separately using created_at
    // (since they haven't been released yet or were refunded before release)
    const { data: heldEscrowsInRange } = await this.supabase
      .from('escrows')
      .select('platform_amount')
      .eq('status', 'held')
      .gte('created_at', startDate)
      .lte('created_at', endDate);
    
    const { data: refundedEscrowsInRange } = await this.supabase
      .from('escrows')
      .select('platform_amount')
      .eq('status', 'refunded')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    const pendingRevenue = heldEscrowsInRange?.reduce((sum, e) => sum + parseFloat(e.platform_amount || '0'), 0) || 0;
    const lostRevenue = refundedEscrowsInRange?.reduce((sum, e) => sum + parseFloat(e.platform_amount || '0'), 0) || 0;
    const totalPlatformFees = realizedRevenue + pendingRevenue + lostRevenue;

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
    const vendorFees: Record<string, { fees: number; orderCount: number }> = {};
    escrows?.forEach(e => {
      const vendorId = e.orders?.vendor_id;
      if (!vendorId || e.status !== 'released') return;
      
      const amount = parseFloat(e.platform_amount || '0');
      if (!vendorFees[vendorId]) {
        vendorFees[vendorId] = { fees: 0, orderCount: 0 };
      }
      vendorFees[vendorId].fees += amount;
      vendorFees[vendorId].orderCount += 1;
    });

    // Sort and get top 10 vendors
    const sortedVendors = Object.entries(vendorFees)
      .sort(([, a], [, b]) => b.fees - a.fees)
      .slice(0, 10);

    // Get vendor details
    const topVendors = await Promise.all(
      sortedVendors.map(async ([vendorId, data]) => {
        const { data: profile } = await this.supabase
          .from('user_profiles')
          .select('id, username, preferences')
          .eq('id', vendorId)
          .single();

        return {
          vendorId,
          vendorName: profile?.preferences?.fullName || profile?.username || 'Unknown',
          totalFees: data.fees,
          orderCount: data.orderCount,
        };
      })
    );

    return {
      totalPlatformFees,
      realizedRevenue,
      pendingRevenue,
      lostRevenue,
      revenueBySource,
      topVendors,
    };
  }

  /**
   * Get escrow health for staff (staff version)
   */
  async getEscrowHealthForStaff(staffId: string) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);

    this.logger.log(`Staff ${staffId} fetching escrow health metrics`);

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

    return {
      totalInEscrow,
      overdueEscrows: overdueEscrows.length,
      disputeRate: Math.round(disputeRate * 100) / 100,
      averageHoldTime: Math.round(averageHoldTimeHours * 10) / 10,
      escrowsByStatus: {
        held: heldEscrows.length,
        released: releasedEscrows.length,
        refunded: refundedEscrows.length,
        disputed: disputedEscrows.length,
      },
    };
  }

  /**
   * Get payouts for staff
   */
  async getPayoutsForStaff(
    staffId: string,
    filters: { status?: string; page?: number; limit?: number },
  ) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);
    
    // Fetch payouts from database
    this.logger.log(`Finance staff ${staffId} fetching payouts with filters:`, filters);
    
    let query = this.supabase
      .from('payout_requests')
      .select(`
        id,
        user_id,
        freti_amount,
        estimated_local_amount,
        local_currency,
        status,
        external_payout_id,
        requested_at,
        processed_at,
        paid_at,
        failure_reason,
        retry_count,
        created_at,
        updated_at,
        user:user_profiles!payout_requests_user_id_fkey(
          id,
          username,
          email,
          first_name,
          last_name
        )
      `)
      .order('created_at', { ascending: false });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const offset = (page - 1) * limit;

    // Get total count
    const { count } = await this.supabase
      .from('payout_requests')
      .select('*', { count: 'exact', head: true })
      .then((result) => ({ count: result.count || 0 }));

    const { data: payouts, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      this.logger.error(`Failed to fetch payouts: ${error.message}`);
      throw new Error(`Failed to fetch payouts: ${error.message}`);
    }

    return {
      payouts: payouts || [],
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    };
  }

  /**
   * Process payout for staff
   */
  async processPayoutForStaff(staffId: string, payoutId: string) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);
    
    // TODO: Implement payout processing (manual retry, etc.)
    this.logger.log(`Finance staff ${staffId} processing payout ${payoutId}`);
    
    return { message: 'Payout processed successfully' };
  }

  /**
   * Manually refund a failed withdrawal (Finance staff only)
   * POST /admin/finance/withdrawals/:payoutId/refund
   */
  async refundWithdrawalManually(
    staffId: string,
    payoutId: string,
    reason: string,
  ): Promise<{ success: boolean; message: string }> {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);

    this.logger.log(`Finance staff ${staffId} attempting manual refund for withdrawal ${payoutId}`);

    try {
      // Get payout request
      const { data: payout, error: payoutError } = await this.supabase
        .from('payout_requests')
        .select('*')
        .eq('id', payoutId)
        .single();

      if (payoutError || !payout) {
        throw new NotFoundException(`Payout request ${payoutId} not found`);
      }

      // Only allow refund for failed or pending withdrawals with funds stuck
      if (payout.status === 'paid') {
        throw new BadRequestException('Cannot refund a completed payout');
      }

      if (payout.status === 'cancelled') {
        throw new BadRequestException('Payout is already cancelled');
      }

      // Get wallet to check current state
      const wallet = await this.walletService.getWallet(payout.user_id);

      // Check if funds are in pending_withdrawal (they should be if withdrawal failed)
      if (wallet.pendingWithdrawal < payout.freti_amount) {
        this.logger.warn(
          `Payout ${payoutId}: Funds not fully in pending_withdrawal. Current: ${wallet.pendingWithdrawal}, Expected: ${payout.freti_amount}`
        );
      }

      // Refund funds from pending_withdrawal back to available_balance
      // Using withdrawal_burn type with positive availableDelta to refund funds
      const refundIdempotencyKey = `manual_refund_${payoutId}_${Date.now()}_${staffId}`;
      
      await this.walletService.createLedgerEntry(
        {
          walletId: wallet.id,
          transactionType: 'admin_adjustment', // Use admin_adjustment for manual refunds
          availableDelta: payout.freti_amount, // Refund to available
          escrowDelta: 0,
          pendingWithdrawalDelta: -payout.freti_amount, // Remove from pending
          referenceType: 'payout_request',
          referenceId: payoutId,
          idempotencyKey: refundIdempotencyKey,
          description: `Manual refund by finance staff. Reason: ${reason}`,
          metadata: {
            refunded_by: staffId,
            refund_reason: reason,
            refund_type: 'manual_admin_refund',
            original_status: payout.status,
            original_payout_id: payoutId,
          },
        },
        payout.user_id
      );

      // Update payout status
      await this.supabase
        .from('payout_requests')
        .update({
          status: 'cancelled',
          failure_reason: `Manually refunded by finance staff. ${reason}`,
          metadata: {
            ...payout.metadata,
            refunded_by: staffId,
            refund_reason: reason,
            refunded_at: new Date().toISOString(),
            manual_refund: true,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', payoutId);

      // Send notification to user
      await this.notificationHelper.notifySystemUpdate(
        payout.user_id,
        'Withdrawal Refunded',
        `Your withdrawal of ₣${payout.freti_amount} FRETI has been refunded to your available balance by our finance team. Reason: ${reason}`,
        { payoutId, amount: payout.freti_amount, type: 'wallet_withdrawal_refunded' }
      );

      // Log audit trail
      await this.auditService.logAction({
        staffId: staffId,
        action: AuditAction.PROCESS_REFUND,
        entityType: AuditEntityType.WALLET,
        entityId: payoutId,
        details: {
          description: `Finance staff manually refunded withdrawal ${payoutId}. Amount: ₣${payout.freti_amount}. Reason: ${reason}`,
          payoutId,
          amount: payout.freti_amount,
          reason,
          refundedUserId: payout.user_id,
        },
      });

      this.logger.log(`✅ Finance staff ${staffId} successfully refunded withdrawal ${payoutId}`);

      return {
        success: true,
        message: `Withdrawal ${payoutId} refunded successfully. ₣${payout.freti_amount} FRETI has been returned to user's available balance.`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to refund withdrawal ${payoutId}:`, error);
      throw error;
    }
  }

  /**
   * Get reconciliation alerts for finance team
   * These alerts track when fallback exchange rates are used instead of Flutterwave's actual rates
   */
  async getReconciliationAlertsForStaff(
    staffId: string,
    filters: {
      status?: 'pending' | 'reviewed' | 'resolved' | 'dismissed';
      severity?: 'low' | 'medium' | 'high' | 'critical';
      page?: number;
      limit?: number;
      startDate?: string;
      endDate?: string;
    },
  ) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);

    this.logger.log(`Staff ${staffId} fetching reconciliation alerts with filters:`, filters);

    let query = this.supabase
      .from('reconciliation_alerts')
      .select(`
        id,
        deposit_id,
        user_id,
        local_amount,
        local_currency,
        fallback_rate_used,
        estimated_freti_amount,
        actual_freti_amount,
        actual_rate,
        amount_discrepancy,
        discrepancy_percentage,
        alert_type,
        alert_severity,
        alert_reason,
        status,
        resolved_by,
        resolved_at,
        resolution_notes,
        metadata,
        created_at,
        updated_at,
        deposits!inner(
          id,
          status,
          external_payment_id,
          initiated_at,
          completed_at
        )
      `)
      .order('created_at', { ascending: false });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    if (filters.severity) {
      query = query.eq('alert_severity', filters.severity);
    }

    if (filters.startDate) {
      query = query.gte('created_at', filters.startDate);
    }

    if (filters.endDate) {
      query = query.lte('created_at', filters.endDate);
    }

    const { data: alerts, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch reconciliation alerts: ${error.message}`);
      throw new Error(`Failed to fetch reconciliation alerts: ${error.message}`);
    }

    // Get user data for all alerts
    const userIds = alerts?.map(a => a.user_id).filter(Boolean) || [];
    const { data: users } = userIds.length > 0
      ? await this.supabase
          .from('user_profiles')
          .select('id, username, preferences')
          .in('id', userIds)
      : { data: [] };

    const userMap = new Map(users?.map(u => [u.id, u]) || []);

    // Get resolver data if any alerts are resolved
    const resolverIds = alerts?.map(a => a.resolved_by).filter(Boolean) || [];
    const { data: resolvers } = resolverIds.length > 0
      ? await this.supabase
          .from('user_profiles')
          .select('id, username, preferences')
          .in('id', resolverIds)
      : { data: [] };

    const resolverMap = new Map(resolvers?.map(r => [r.id, r]) || []);

    // Apply pagination
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit;
    const paginatedAlerts = (alerts || []).slice(from, to);

    // Format response
    const formattedAlerts = paginatedAlerts.map(alert => {
      const user = userMap.get(alert.user_id) as { username?: string; preferences?: { fullName?: string } } | undefined;
      const resolver = alert.resolved_by ? resolverMap.get(alert.resolved_by) as { username?: string; preferences?: { fullName?: string } } | undefined : null;

      return {
        id: alert.id,
        depositId: alert.deposit_id,
        userId: alert.user_id,
        userName: user?.username || 'Unknown',
        userFullName: user?.preferences?.fullName || null,
        localAmount: parseFloat(alert.local_amount),
        localCurrency: alert.local_currency,
        fallbackRateUsed: parseFloat(alert.fallback_rate_used),
        estimatedFretiAmount: parseFloat(alert.estimated_freti_amount),
        actualFretiAmount: alert.actual_freti_amount ? parseFloat(alert.actual_freti_amount) : null,
        actualRate: alert.actual_rate ? parseFloat(alert.actual_rate) : null,
        amountDiscrepancy: alert.amount_discrepancy ? parseFloat(alert.amount_discrepancy) : null,
        discrepancyPercentage: alert.discrepancy_percentage ? parseFloat(alert.discrepancy_percentage) : null,
        alertType: alert.alert_type,
        alertSeverity: alert.alert_severity,
        alertReason: alert.alert_reason,
        status: alert.status,
        resolvedBy: alert.resolved_by,
        resolvedByName: resolver?.username || null,
        resolvedAt: alert.resolved_at,
        resolutionNotes: alert.resolution_notes,
        metadata: alert.metadata || {},
        deposit: alert.deposits,
        createdAt: alert.created_at,
        updatedAt: alert.updated_at,
      };
    });

    return {
      alerts: formattedAlerts,
      pagination: {
        page,
        limit,
        total: alerts?.length || 0,
        totalPages: Math.ceil((alerts?.length || 0) / limit),
      },
      summary: {
        total: alerts?.length || 0,
        pending: alerts?.filter(a => a.status === 'pending').length || 0,
        reviewed: alerts?.filter(a => a.status === 'reviewed').length || 0,
        resolved: alerts?.filter(a => a.status === 'resolved').length || 0,
        bySeverity: {
          low: alerts?.filter(a => a.alert_severity === 'low').length || 0,
          medium: alerts?.filter(a => a.alert_severity === 'medium').length || 0,
          high: alerts?.filter(a => a.alert_severity === 'high').length || 0,
          critical: alerts?.filter(a => a.alert_severity === 'critical').length || 0,
        },
      },
    };
  }

  /**
   * Update reconciliation alert status (resolve, review, dismiss)
   */
  async updateReconciliationAlertStatus(
    staffId: string,
    alertId: string,
    status: 'reviewed' | 'resolved' | 'dismissed',
    resolutionNotes?: string,
  ) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);

    this.logger.log(`Staff ${staffId} updating reconciliation alert ${alertId} to status ${status}`);

    const updateData: any = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (status === 'resolved' || status === 'reviewed') {
      updateData.resolved_by = staffId;
      updateData.resolved_at = new Date().toISOString();
      if (resolutionNotes) {
        updateData.resolution_notes = resolutionNotes;
      }
    }

    const { data, error } = await this.supabase
      .from('reconciliation_alerts')
      .update(updateData)
      .eq('id', alertId)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to update reconciliation alert: ${error.message}`);
      throw new Error(`Failed to update reconciliation alert: ${error.message}`);
    }

    return {
      id: data.id,
      status: data.status,
      resolvedBy: data.resolved_by,
      resolvedAt: data.resolved_at,
      resolutionNotes: data.resolution_notes,
      updatedAt: data.updated_at,
    };
  }

  /**
   * Get deposits and transactions for staff
   */
  async getDepositsForStaff(
    staffId: string,
    filters: {
      paymentMethod?: string;
      status?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);

    this.logger.log(`Staff ${staffId} fetching deposits with filters:`, filters);

    // First, get all deposits matching status and payment method filters
    let query = this.supabase
      .from('deposits')
      .select(`
        id,
        user_id,
        freti_amount,
        local_amount,
        local_currency,
        status,
        metadata,
        initiated_at,
        completed_at,
        created_at,
        updated_at
      `)
      .order('created_at', { ascending: false });

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.paymentMethod) {
      // Payment method is stored in metadata
      query = query.contains('metadata', { payment_method: filters.paymentMethod });
    }

    const { data: allDeposits, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch deposits: ${error.message}`);
      throw new Error(`Failed to fetch deposits: ${error.message}`);
    }

    // Get user data for all deposits
    const userIds = allDeposits?.map(d => d.user_id).filter(Boolean) || [];
    const { data: users } = userIds.length > 0
      ? await this.supabase
          .from('user_profiles')
          .select('id, username, preferences')
          .in('id', userIds)
      : { data: [] };

    const userMap = new Map(users?.map(u => [u.id, u]) || []);

    // Filter by search if provided
    let filteredDeposits = allDeposits || [];
    if (filters.search) {
      filteredDeposits = filteredDeposits.filter(deposit => {
        const user = userMap.get(deposit.user_id) as { username?: string; preferences?: { fullName?: string } } | undefined;
        const username = user?.username || '';
        const fullName = user?.preferences?.fullName || '';
        const searchLower = filters.search?.toLowerCase() || '';
        return username.toLowerCase().includes(searchLower) || 
               fullName.toLowerCase().includes(searchLower);
      });
    }

    // Apply pagination after filtering
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit;
    const paginatedDeposits = filteredDeposits.slice(from, to);

    // Get total count (after search filter)
    const totalCount = filteredDeposits.length;

    // Transform to deposit format
    const transformedDeposits = paginatedDeposits.map(deposit => {
      const user = userMap.get(deposit.user_id) as { username?: string; preferences?: { fullName?: string } } | undefined;
      const paymentMethod = deposit.metadata?.payment_method || 
                           deposit.metadata?.method || 
                           deposit.metadata?.channel || 
                           'Unknown';
      
      const userName = user?.preferences?.fullName || user?.username || 'Unknown User';
      
      return {
        id: deposit.id,
        userId: deposit.user_id,
        userName,
        amount: parseFloat(deposit.freti_amount || '0'),
        localAmount: parseFloat(deposit.local_amount || '0'),
        localCurrency: deposit.local_currency || 'USD',
        status: deposit.status,
        paymentMethod: paymentMethod,
        initiatedAt: deposit.initiated_at,
        completedAt: deposit.completed_at,
        createdAt: deposit.created_at,
        updatedAt: deposit.updated_at,
      };
    });

    return {
      deposits: transformedDeposits,
      total: totalCount,
      page,
      limit,
    };
  }

  /**
   * Get total platform funds for staff
   */
  async getTotalPlatformFundsForStaff(staffId: string) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);

    this.logger.log(`Staff ${staffId} fetching total platform funds`);

    // Get all wallet balances
    const { data: wallets, error: walletsError } = await this.supabase
      .from('wallets')
      .select('available_balance, escrow_balance, pending_withdrawal');

    if (walletsError) {
      this.logger.error(`Failed to fetch wallets: ${walletsError.message}`);
      throw new Error(`Failed to fetch wallets: ${walletsError.message}`);
    }

    const totalAvailable = wallets?.reduce(
      (sum, w) => sum + parseFloat(w.available_balance || '0'),
      0
    ) || 0;

    const totalEscrow = wallets?.reduce(
      (sum, w) => sum + parseFloat(w.escrow_balance || '0'),
      0
    ) || 0;

    const totalPendingWithdrawal = wallets?.reduce(
      (sum, w) => sum + parseFloat(w.pending_withdrawal || '0'),
      0
    ) || 0;

    const totalFunds = totalAvailable + totalEscrow + totalPendingWithdrawal;

    // Get total deposits (completed)
    const { count: totalDepositsCount } = await this.supabase
      .from('deposits')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed');

    const { data: completedDeposits } = await this.supabase
      .from('deposits')
      .select('freti_amount')
      .eq('status', 'completed');

    const totalDeposited = completedDeposits?.reduce(
      (sum, d) => sum + parseFloat(d.freti_amount || '0'),
      0
    ) || 0;

    return {
      totalFunds,
      totalAvailable,
      totalEscrow,
      totalPendingWithdrawal,
      totalDeposited,
      totalDepositsCount: totalDepositsCount || 0,
    };
  }

  /**
   * Get user balances sorted by available funds (highest to lowest)
   */
  async getUserBalancesForStaff(
    staffId: string,
    filters: {
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    // Verify staff has finance permission
    await this.verifyFinanceStaff(staffId);

    this.logger.log(`Staff ${staffId} fetching user balances with filters:`, filters);

    // Get all wallets with user information
    let query = this.supabase
      .from('wallets')
      .select(`
        id,
        user_id,
        available_balance,
        escrow_balance,
        pending_withdrawal,
        user:user_profiles!user_id(id, username, preferences)
      `)
      .order('available_balance', { ascending: false });

    const { data: wallets, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch wallets: ${error.message}`);
      throw new Error(`Failed to fetch wallets: ${error.message}`);
    }

    // Transform and filter wallets
    let userBalances = wallets?.map(wallet => {
      const user = wallet.user as { id?: string; username?: string; preferences?: { fullName?: string } } | null;
      const availableBalance = parseFloat(wallet.available_balance || '0');
      const escrowBalance = parseFloat(wallet.escrow_balance || '0');
      const pendingWithdrawal = parseFloat(wallet.pending_withdrawal || '0');
      const totalBalance = availableBalance + escrowBalance + pendingWithdrawal;

      const userName = user?.preferences?.fullName || user?.username || 'Unknown User';
      const username = user?.username || 'N/A';

      return {
        userId: wallet.user_id,
        userName,
        username,
        availableBalance,
        escrowBalance,
        pendingWithdrawal,
        totalBalance,
        walletId: wallet.id,
      };
    }) || [];

    // Filter by search if provided
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      userBalances = userBalances.filter(balance => {
        const userName = balance.userName.toLowerCase();
        const username = balance.username.toLowerCase();
        return userName.includes(searchLower) || username.includes(searchLower);
      });
    }

    // Sort by available balance (highest to lowest)
    userBalances.sort((a, b) => b.availableBalance - a.availableBalance);

    // Apply pagination
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit;
    const paginatedBalances = userBalances.slice(from, to);

    return {
      balances: paginatedBalances,
      total: userBalances.length,
      page,
      limit,
    };
  }

  /**
   * Get platform stats for staff
   */
  async getPlatformStatsForStaff(staffId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching platform statistics`);

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

    // Calculate completion rate
    const completionRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;

    // Get total revenue from released escrows (ALL-TIME - no date filter)
    // This represents the total platform revenue ever earned
    const { data: releasedEscrows } = await this.supabase
      .from('escrows')
      .select('platform_amount')
      .eq('status', 'released')
      .not('released_at', 'is', null); // Only count escrows that have been released

    const totalRevenue = releasedEscrows?.reduce(
      (sum, e) => sum + parseFloat(e.platform_amount || '0'),
      0
    ) || 0;

    // Get active disputes
    const { count: activeDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .in('status', ['open', 'under_review']);

    return {
      totalUsers: totalUsers || 0,
      vendors: totalVendors || 0,
      riders: totalRiders || 0,
      totalOrders: totalOrders || 0,
      completionRate: Math.round(completionRate * 10) / 10,
      totalRevenue,
      activeDisputes: activeDisputes || 0,
    };
  }

  /**
   * Get analytics summary for staff
   */
  async getAnalyticsSummaryForStaff(staffId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching analytics summary`);

    // Get total orders
    const { count: totalOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true });

    // Get total revenue from released escrows (ALL-TIME - consistent with getPlatformStatsForStaff)
    // This represents the total platform revenue ever earned
    const { data: releasedEscrows } = await this.supabase
      .from('escrows')
      .select('platform_amount')
      .eq('status', 'released')
      .not('released_at', 'is', null); // Only count escrows that have been released

    const totalRevenue = releasedEscrows?.reduce(
      (sum, e) => sum + parseFloat(e.platform_amount || '0'),
      0
    ) || 0;

    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    // Get total users
    const { count: totalUsers } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true });

    // Get top categories from order_items
    // Query order_items directly to get category revenue
    const { data: orderItems } = await this.supabase
      .from('order_items')
      .select('order_id, category, total_price')
      .limit(10000); // Reasonable limit for category aggregation

    const categoryRevenue: Record<string, { orderCount: number; revenue: number }> = {};
    const processedOrders = new Set<string>();
    
    (orderItems || []).forEach(item => {
      const category = item.category || 'uncategorized';
      if (!categoryRevenue[category]) {
        categoryRevenue[category] = { orderCount: 0, revenue: 0 };
      }
      // Count unique orders per category
      if (!processedOrders.has(`${category}-${item.order_id}`)) {
        categoryRevenue[category].orderCount += 1;
        processedOrders.add(`${category}-${item.order_id}`);
      }
      categoryRevenue[category].revenue += parseFloat(item.total_price || '0');
    });

    const topCategories = Object.entries(categoryRevenue)
      .map(([category, data]) => ({
        category,
        orderCount: data.orderCount,
        revenue: data.revenue,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Get top vendors
    const { data: escrows } = await this.supabase
      .from('escrows')
      .select(`
        platform_amount,
        orders!inner(
          vendor_id
        )
      `)
      .eq('status', 'released');

    const vendorRevenue: Record<string, { orderCount: number; revenue: number }> = {};
    escrows?.forEach(escrow => {
      const vendorId = escrow.orders?.vendor_id;
      if (!vendorId) return;
      
      if (!vendorRevenue[vendorId]) {
        vendorRevenue[vendorId] = { orderCount: 0, revenue: 0 };
      }
      vendorRevenue[vendorId].orderCount += 1;
      vendorRevenue[vendorId].revenue += parseFloat(escrow.platform_amount || '0');
    });

    // Get vendor names
    const vendorIds = Object.keys(vendorRevenue).slice(0, 10);
    const topVendors = await Promise.all(
      vendorIds.map(async (vendorId) => {
        const { data: profile } = await this.supabase
          .from('user_profiles')
          .select('id, username, preferences')
          .eq('id', vendorId)
          .single();

        return {
          vendorId,
          vendorName: profile?.preferences?.fullName || profile?.username || 'Unknown',
          orderCount: vendorRevenue[vendorId].orderCount,
          revenue: vendorRevenue[vendorId].revenue,
        };
      })
    );

    topVendors.sort((a, b) => b.revenue - a.revenue);

    return {
      totalOrders: totalOrders || 0,
      totalRevenue,
      totalUsers: totalUsers || 0,
      averageOrderValue: Math.round(averageOrderValue * 100) / 100,
      topCategories,
      topVendors,
    };
  }

  /**
   * Get time series data for staff
   */
  async getTimeSeriesForStaff(
    staffId: string,
    dateRange?: { start?: string; end?: string },
    period: 'daily' | 'weekly' | 'monthly' = 'daily',
  ) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    const startDate = dateRange?.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = dateRange?.end || new Date().toISOString().split('T')[0];

    this.logger.log(`Staff ${staffId} fetching time series from ${startDate} to ${endDate} with period: ${period}`);

    // Get orders in date range
    const { data: orders } = await this.supabase
      .from('orders')
      .select('id, total, created_at')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    // Get released escrows for revenue
    const { data: escrows } = await this.supabase
      .from('escrows')
      .select('platform_amount, released_at')
      .eq('status', 'released')
      .gte('released_at', startDate)
      .lte('released_at', endDate);

    // Get new users
    const { data: users } = await this.supabase
      .from('user_profiles')
      .select('id, created_at')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    // Helper function to get period key based on period type
    const getPeriodKey = (dateString: string): string => {
      const date = new Date(dateString);
      
      switch (period) {
        case 'daily':
          return date.toISOString().split('T')[0]; // YYYY-MM-DD
          
        case 'weekly':
          // Get Monday of the week
          const monday = new Date(date);
          const day = monday.getDay();
          const diff = monday.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
          monday.setDate(diff);
          monday.setHours(0, 0, 0, 0);
          return monday.toISOString().split('T')[0]; // Monday date as key
          
        case 'monthly':
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          return `${year}-${month}`; // YYYY-MM
          
        default:
          return date.toISOString().split('T')[0];
      }
    };

    // Helper function to format date for display
    const formatPeriodDate = (key: string): string => {
      switch (period) {
        case 'daily':
          return key; // Already YYYY-MM-DD
          
        case 'weekly':
          // Return the Monday date as display
          return key;
          
        case 'monthly':
          // Return first day of month for consistency
          return `${key}-01`;
          
        default:
          return key;
      }
    };

    // Group by period
    const periodData: Record<string, { orders: number; revenue: number; users: number }> = {};

    orders?.forEach(order => {
      const key = getPeriodKey(order.created_at);
      if (!periodData[key]) {
        periodData[key] = { orders: 0, revenue: 0, users: 0 };
      }
      periodData[key].orders += 1;
    });

    escrows?.forEach(escrow => {
      if (!escrow.released_at) return;
      const key = getPeriodKey(escrow.released_at);
      if (!periodData[key]) {
        periodData[key] = { orders: 0, revenue: 0, users: 0 };
      }
      periodData[key].revenue += parseFloat(escrow.platform_amount || '0');
    });

    users?.forEach(user => {
      const key = getPeriodKey(user.created_at);
      if (!periodData[key]) {
        periodData[key] = { orders: 0, revenue: 0, users: 0 };
      }
      periodData[key].users += 1;
    });

    // Convert to array and sort by date
    const timeSeries = Object.entries(periodData)
      .map(([key, data]) => ({
        date: formatPeriodDate(key),
        orders: data.orders,
        revenue: data.revenue,
        users: data.users,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return timeSeries;
  }

  /**
   * Get logistics stats for staff
   */
  async getLogisticsStatsForStaff(staffId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching logistics statistics`);

    // Get total riders
    const { count: totalRiders } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('is_rider', true);

    // Get active riders (online and available)
    const { count: activeRiders } = await this.supabase
      .from('rider_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('is_online', true)
      .eq('is_available', true);

    // Get total deliveries (orders with delivery type)
    const { count: totalDeliveries } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('delivery_type', 'delivery');

    // Get deliveries by status
    const { count: pendingDeliveries } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('delivery_type', 'delivery')
      .in('status', ['pending', 'confirmed']);

    const { count: inTransitDeliveries } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('delivery_type', 'delivery')
      .in('status', ['out_for_delivery', 'in_transit']);

    const { count: completedDeliveries } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('delivery_type', 'delivery')
      .eq('status', 'delivered');

    // Calculate average delivery time (from created_at to delivered_at)
    const { data: deliveredOrders } = await this.supabase
      .from('orders')
      .select('created_at, delivered_at')
      .eq('delivery_type', 'delivery')
      .eq('status', 'delivered')
      .not('delivered_at', 'is', null);

    const deliveryTimes = deliveredOrders
      ?.filter(o => o.delivered_at && o.created_at)
      .map(o => {
        const created = new Date(o.created_at).getTime();
        const delivered = new Date(o.delivered_at).getTime();
        return (delivered - created) / (1000 * 60); // Minutes
      }) || [];

    const averageDeliveryTime = deliveryTimes.length > 0
      ? deliveryTimes.reduce((sum, time) => sum + time, 0) / deliveryTimes.length
      : 0;

    // Calculate on-time delivery rate (delivered within estimated_delivery time)
    const onTimeDeliveries = deliveredOrders?.filter(o => {
      if (!o.delivered_at || !o.created_at) return false;
      // For simplicity, consider on-time if delivered within 2 hours of creation
      const created = new Date(o.created_at).getTime();
      const delivered = new Date(o.delivered_at).getTime();
      const hours = (delivered - created) / (1000 * 60 * 60);
      return hours <= 2;
    }).length || 0;

    const onTimeDeliveryRate = deliveredOrders && deliveredOrders.length > 0
      ? (onTimeDeliveries / deliveredOrders.length) * 100
      : 0;

    return {
      totalRiders: totalRiders || 0,
      activeRiders: activeRiders || 0,
      totalDeliveries: totalDeliveries || 0,
      pendingDeliveries: pendingDeliveries || 0,
      inTransitDeliveries: inTransitDeliveries || 0,
      completedDeliveries: completedDeliveries || 0,
      averageDeliveryTime: Math.round(averageDeliveryTime),
      onTimeDeliveryRate: Math.round(onTimeDeliveryRate * 10) / 10,
    };
  }

  /**
   * Get riders for staff
   */
  async getRidersForStaff(
    staffId: string,
    filters: {
      status?: 'active' | 'inactive' | 'all';
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching riders with filters:`, filters);

    let query = this.supabase
      .from('user_profiles')
      .select(`
        id,
        username,
        avatar_url,
        created_at,
        preferences
      `)
      .eq('is_rider', true)
      .order('created_at', { ascending: false });

    if (filters.search) {
      query = query.or(`username.ilike.%${filters.search}%,preferences->>fullName.ilike.%${filters.search}%`);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: riders, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch riders: ${error.message}`);
      throw new Error(`Failed to fetch riders: ${error.message}`);
    }

    // Get rider profiles and trust scores
    const riderIds = riders?.map(r => r.id) || [];
    const { data: riderProfiles } = await this.supabase
      .from('rider_profiles')
      .select('user_id, is_online, is_available')
      .in('user_id', riderIds);

    const { data: trustScores } = await this.supabase
      .from('trust_scores')
      .select('user_id, rider_trust_score, completed_orders')
      .in('user_id', riderIds);

    // Get delivery stats for each rider
    const { data: orderStats } = await this.supabase
      .from('orders')
      .select('rider_id, status, created_at, delivered_at')
      .in('rider_id', riderIds)
      .eq('delivery_type', 'delivery');

    // Transform to response format
    const ridersWithStats = riders?.map(rider => {
      const riderProfile = riderProfiles?.find(rp => rp.user_id === rider.id);
      const trustScore = trustScores?.find(ts => ts.user_id === rider.id);
      const riderOrders = orderStats?.filter(o => o.rider_id === rider.id) || [];

      const completedOrders = riderOrders.filter(o => o.status === 'delivered');
      const deliveryTimes = completedOrders
        .filter(o => o.delivered_at && o.created_at)
        .map(o => {
          const created = new Date(o.created_at).getTime();
          const delivered = new Date(o.delivered_at).getTime();
          return (delivered - created) / (1000 * 60); // Minutes
        });

      const averageDeliveryTime = deliveryTimes.length > 0
        ? deliveryTimes.reduce((sum, time) => sum + time, 0) / deliveryTimes.length
        : undefined;

      // Calculate rating from trust score (0-5 scale)
      const rating = trustScore?.rider_trust_score
        ? Math.min(5, Math.max(0, (trustScore.rider_trust_score / 1000) * 5))
        : undefined;

      const isActive = riderProfile?.is_online && riderProfile?.is_available;

      // Apply status filter
      if (filters.status === 'active' && !isActive) return null;
      if (filters.status === 'inactive' && isActive) return null;

      return {
        id: rider.id,
        username: rider.username,
        email: '', // Email not in user_profiles, would need to fetch from auth.users
        fullName: rider.preferences?.fullName,
        phone: rider.preferences?.phone,
        isActive,
        rating,
        totalDeliveries: riderOrders.length,
        completedDeliveries: completedOrders.length,
        onTimeDeliveries: completedOrders.length, // Simplified
        averageDeliveryTime: averageDeliveryTime ? Math.round(averageDeliveryTime) : undefined,
        createdAt: rider.created_at,
        avatarUrl: rider.avatar_url,
      };
    }).filter(r => r !== null) || [];

    // Get total count
    let countQuery = this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('is_rider', true);

    if (filters.search) {
      countQuery = countQuery.or(`username.ilike.%${filters.search}%,preferences->>fullName.ilike.%${filters.search}%`);
    }

    const { count } = await countQuery;

    return {
      riders: ridersWithStats,
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Get rider by ID for staff
   */
  async getRiderByIdForStaff(staffId: string, riderId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    const { data: rider, error } = await this.supabase
      .from('user_profiles')
      .select(`
        id,
        username,
        avatar_url,
        created_at,
        preferences
      `)
      .eq('id', riderId)
      .eq('is_rider', true)
      .single();

    if (error || !rider) {
      throw new NotFoundException('Rider not found');
    }

    // Get additional rider data
    const { data: riderProfile } = await this.supabase
      .from('rider_profiles')
      .select('*')
      .eq('user_id', riderId)
      .single();

    const { data: trustScore } = await this.supabase
      .from('trust_scores')
      .select('*')
      .eq('user_id', riderId)
      .single();

    const { data: orders } = await this.supabase
      .from('orders')
      .select('*')
      .eq('rider_id', riderId)
      .eq('delivery_type', 'delivery');

    const completedOrders = orders?.filter(o => o.status === 'delivered') || [];
    const deliveryTimes = completedOrders
      .filter(o => o.delivered_at && o.created_at)
      .map(o => {
        const created = new Date(o.created_at).getTime();
        const delivered = new Date(o.delivered_at).getTime();
        return (delivered - created) / (1000 * 60);
      });

    const averageDeliveryTime = deliveryTimes.length > 0
      ? deliveryTimes.reduce((sum, time) => sum + time, 0) / deliveryTimes.length
      : undefined;

    const rating = trustScore?.rider_trust_score
      ? Math.min(5, Math.max(0, (trustScore.rider_trust_score / 1000) * 5))
      : undefined;

    return {
      id: rider.id,
      username: rider.username,
      email: '',
      fullName: rider.preferences?.fullName,
      phone: rider.preferences?.phone,
      isActive: riderProfile?.is_online && riderProfile?.is_available,
      rating,
      totalDeliveries: orders?.length || 0,
      completedDeliveries: completedOrders.length,
      onTimeDeliveries: completedOrders.length,
      averageDeliveryTime: averageDeliveryTime ? Math.round(averageDeliveryTime) : undefined,
      createdAt: rider.created_at,
      avatarUrl: rider.avatar_url,
    };
  }

  /**
   * Get deliveries for staff
   */
  async getDeliveriesForStaff(
    staffId: string,
    filters: {
      status?: string;
      riderId?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching deliveries with filters:`, filters);

    let query = this.supabase
      .from('orders')
      .select(`
        id,
        order_number,
        buyer_id,
        vendor_id,
        rider_id,
        status,
        total_amount,
        delivery_address,
        delivery_type,
        created_at,
        updated_at,
        delivered_at,
        estimated_delivery,
        buyer:user_profiles!buyer_id(id, username, preferences),
        vendor:user_profiles!vendor_id(id, username, preferences),
        rider:user_profiles!rider_id(id, username, preferences)
      `)
      .in('delivery_type', ['delivery', 'pickup'])
      .order('created_at', { ascending: false });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    if (filters.riderId) {
      query = query.eq('rider_id', filters.riderId);
    }

    if (filters.search) {
      query = query.or(`order_number.ilike.%${filters.search}%`);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: orders, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch deliveries: ${error.message}`);
      throw new Error(`Failed to fetch deliveries: ${error.message}`);
    }

    // Transform to delivery format
    const deliveries = orders?.map(order => {
      const deliveryAddress = order.delivery_address;
      const addressString = typeof deliveryAddress === 'string'
        ? deliveryAddress
        : deliveryAddress?.address
          ? `${deliveryAddress.address}, ${deliveryAddress.city || ''}, ${deliveryAddress.state || ''}`
          : 'Address not available';

      // Determine rider name based on delivery type
      let riderName: string | undefined;
      if (order.delivery_type === 'pickup') {
        // Self-pickup orders don't have a rider
        riderName = undefined;
      } else if (order.rider_id && order.rider) {
        // Only show rider name if there's actually a rider assigned
        riderName = order.rider.preferences?.fullName || order.rider.username;
      } else {
        // No rider assigned for delivery order
        riderName = undefined;
      }

      return {
        id: order.id,
        orderId: order.id,
        orderNumber: order.order_number,
        riderId: order.rider_id,
        riderName: riderName,
        deliveryType: order.delivery_type, // Include delivery type
        status: this.mapOrderStatusToDeliveryStatus(order.status),
        pickupAddress: 'Pickup address', // TODO: Get from vendor
        deliveryAddress: addressString,
        estimatedDeliveryTime: order.estimated_delivery,
        actualDeliveryTime: order.delivered_at,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        customerName: order.buyer?.preferences?.fullName || order.buyer?.username || 'Unknown',
        customerPhone: order.delivery_address?.phone,
        amount: parseFloat(order.total_amount || '0'),
      };
    }) || [];

    // Get total count
    let countQuery = this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .in('delivery_type', ['delivery', 'pickup']);

    if (filters.status) {
      countQuery = countQuery.eq('status', filters.status);
    }

    if (filters.riderId) {
      countQuery = countQuery.eq('rider_id', filters.riderId);
    }

    if (filters.search) {
      countQuery = countQuery.or(`order_number.ilike.%${filters.search}%`);
    }

    const { count } = await countQuery;

    return {
      deliveries,
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Get delivery by ID for staff
   */
  async getDeliveryByIdForStaff(staffId: string, deliveryId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    const { data: order, error } = await this.supabase
      .from('orders')
      .select(`
        *,
        buyer:user_profiles!buyer_id(id, username, preferences),
        vendor:user_profiles!vendor_id(id, username, preferences),
        rider:user_profiles!rider_id(id, username, preferences)
      `)
      .eq('id', deliveryId)
      .in('delivery_type', ['delivery', 'pickup'])
      .single();

    if (error || !order) {
      throw new NotFoundException('Delivery not found');
    }

    const deliveryAddress = order.delivery_address;
    const addressString = typeof deliveryAddress === 'string'
      ? deliveryAddress
      : deliveryAddress?.address
        ? `${deliveryAddress.address}, ${deliveryAddress.city || ''}, ${deliveryAddress.state || ''}`
        : 'Address not available';

    // Determine rider name based on delivery type
    let riderName: string | undefined;
    if (order.delivery_type === 'pickup') {
      // Self-pickup orders don't have a rider
      riderName = undefined;
    } else if (order.rider_id && order.rider) {
      // Only show rider name if there's actually a rider assigned
      riderName = order.rider.preferences?.fullName || order.rider.username;
    } else {
      // No rider assigned for delivery order
      riderName = undefined;
    }

    return {
      id: order.id,
      orderId: order.id,
      orderNumber: order.order_number,
      riderId: order.rider_id,
      riderName: riderName,
      deliveryType: order.delivery_type, // Include delivery type
      status: this.mapOrderStatusToDeliveryStatus(order.status),
      pickupAddress: 'Pickup address',
      deliveryAddress: addressString,
      estimatedDeliveryTime: order.estimated_delivery,
      actualDeliveryTime: order.delivered_at,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      customerName: order.buyer?.preferences?.fullName || order.buyer?.username || 'Unknown',
      customerPhone: order.delivery_address?.phone,
      amount: parseFloat(order.total_amount || '0'),
    };
  }

  /**
   * Assign rider to delivery for staff
   */
  async assignRiderToDeliveryForStaff(staffId: string, deliveryId: string, riderId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    // Verify rider exists
    const { data: rider } = await this.supabase
      .from('user_profiles')
      .select('id')
      .eq('id', riderId)
      .eq('is_rider', true)
      .single();

    if (!rider) {
      throw new NotFoundException('Rider not found');
    }

    // Update order with rider
    // When rider is assigned, order should be in 'processing' status (vendor preparing order)
    const { error } = await this.supabase
      .from('orders')
      .update({
        rider_id: riderId,
        status: 'processing', // Move to processing when rider assigned (maps to 'assigned' in delivery status)
        updated_at: new Date().toISOString(),
      })
      .eq('id', deliveryId)
      .eq('delivery_type', 'delivery');

    if (error) {
      this.logger.error(`Failed to assign rider: ${error.message}`);
      throw new Error(`Failed to assign rider: ${error.message}`);
    }

    return { message: 'Rider assigned successfully' };
  }

  /**
   * Update delivery status for staff
   */
  async updateDeliveryStatusForStaff(staffId: string, deliveryId: string, status: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    // Map delivery status to order status
    const orderStatus = this.mapDeliveryStatusToOrderStatus(status);

    this.logger.log(`Updating delivery ${deliveryId} from delivery status "${status}" to order status "${orderStatus}"`);

    const updateData: any = {
      status: orderStatus,
      updated_at: new Date().toISOString(),
    };

    // Handle special status updates
    if (status === 'delivered') {
      updateData.delivered_at = new Date().toISOString();
      // Set escrow release time if applicable (6 hours from delivery)
      updateData.escrow_release_at = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    } else if (status === 'picked_up') {
      // For picked_up status (ready_for_pickup), we might want to set a timestamp
      updateData.ready_for_pickup_at = new Date().toISOString();
    } else if (status === 'in_transit') {
      // For in_transit status (out_for_delivery), we might want to set a timestamp
      updateData.out_for_delivery_at = new Date().toISOString();
    }

    // Allow updates for both delivery and pickup orders
    const { error } = await this.supabase
      .from('orders')
      .update(updateData)
      .eq('id', deliveryId)
      .in('delivery_type', ['delivery', 'pickup']);

    if (error) {
      this.logger.error(`Failed to update delivery status: ${error.message}. Attempted to set status: "${orderStatus}"`);
      throw new Error(`Failed to update delivery status: ${error.message}`);
    }

    return { message: 'Delivery status updated successfully' };
  }

  /**
   * Map order status to delivery status
   */
  private mapOrderStatusToDeliveryStatus(orderStatus: string): 'pending' | 'assigned' | 'picked_up' | 'in_transit' | 'delivered' | 'cancelled' {
    const statusMap: Record<string, 'pending' | 'assigned' | 'picked_up' | 'in_transit' | 'delivered' | 'cancelled'> = {
      'pending': 'pending',
      'confirmed': 'assigned',
      'accepted': 'assigned',
      'preparing': 'assigned',
      'ready_for_pickup': 'picked_up',
      'out_for_delivery': 'in_transit',
      'in_transit': 'in_transit',
      'delivered': 'delivered',
      'cancelled': 'cancelled',
    };

    return statusMap[orderStatus] || 'pending';
  }

  /**
   * Map delivery status to order status
   */
  private mapDeliveryStatusToOrderStatus(deliveryStatus: string): string {
    // Map delivery status to valid order status
    // Valid order statuses: pending, accepted, processing, ready_for_pickup, out_for_delivery, delivered, received, completed, cancelled, disputed, paid
    const statusMap: Record<string, string> = {
      'pending': 'pending',
      'assigned': 'processing', // Map to 'processing' when rider is assigned (order is being prepared)
      'picked_up': 'ready_for_pickup', // Order ready for pickup
      'in_transit': 'out_for_delivery', // Rider is delivering
      'delivered': 'delivered', // Delivered to customer
      'cancelled': 'cancelled',
    };

    const mappedStatus = statusMap[deliveryStatus] || 'pending';
    this.logger.log(`Mapping delivery status "${deliveryStatus}" to order status "${mappedStatus}"`);
    return mappedStatus;
  }

  /**
   * Get dispute statistics for staff
   */
  async getDisputeStatsForStaff(staffId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching dispute statistics`);

    // Get total disputes
    const { count: totalDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true });

    // Get disputes by status
    const { count: openDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open');

    const { count: underReviewDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'under_review');

    const { count: resolvedDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'resolved');

    const { count: escalatedDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'escalated');

    return {
      totalDisputes: totalDisputes || 0,
      openDisputes: openDisputes || 0,
      underReviewDisputes: underReviewDisputes || 0,
      resolvedDisputes: resolvedDisputes || 0,
      escalatedDisputes: escalatedDisputes || 0,
    };
  }

  /**
   * Get disputes for staff
   */
  async getDisputesForStaff(
    staffId: string,
    filters: {
      status?: string;
      type?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching disputes with filters:`, filters);

    let query = this.supabase
      .from('disputes')
      .select(`
        id,
        order_id,
        disputant_id,
        respondent_id,
        dispute_type,
        status,
        reason,
        description,
        priority,
        created_at,
        updated_at,
        order:orders(
          id,
          order_number,
          total_amount,
          buyer_id,
          vendor_id
        )
      `)
      .order('created_at', { ascending: false });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    if (filters.type) {
      query = query.eq('dispute_type', filters.type);
    }

    if (filters.search) {
      query = query.or(`reason.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: disputes, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch disputes: ${error.message}`);
      throw new Error(`Failed to fetch disputes: ${error.message}`);
    }

    // Fetch user profiles separately
    const userIds = new Set<string>();
    disputes?.forEach(dispute => {
      if (dispute.disputant_id) userIds.add(dispute.disputant_id);
      if (dispute.respondent_id) userIds.add(dispute.respondent_id);
    });

    const userProfilesMap: Record<string, any> = {};
    if (userIds.size > 0) {
      const { data: profiles } = await this.supabase
        .from('user_profiles')
        .select('id, username, preferences')
        .in('id', Array.from(userIds));

      profiles?.forEach(profile => {
        userProfilesMap[profile.id] = profile;
      });
    }

    // Transform to response format
    const formattedDisputes = disputes?.map(dispute => {
      const complainantProfile = userProfilesMap[dispute.disputant_id];
      const respondentProfile = userProfilesMap[dispute.respondent_id];

      return {
        id: dispute.id,
        disputeId: dispute.id,
        orderNumber: dispute.order?.order_number || 'N/A',
        complainant: complainantProfile?.preferences?.fullName || complainantProfile?.username || 'Unknown',
        respondent: respondentProfile?.preferences?.fullName || respondentProfile?.username || 'Unknown',
        type: dispute.dispute_type,
        status: dispute.status,
        priority: dispute.priority || 'medium',
        createdAt: dispute.created_at,
        description: dispute.description || dispute.reason || 'No description',
      };
    }) || [];

    // Get total count
    let countQuery = this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true });

    if (filters.status) {
      countQuery = countQuery.eq('status', filters.status);
    }

    if (filters.type) {
      countQuery = countQuery.eq('dispute_type', filters.type);
    }

    if (filters.search) {
      countQuery = countQuery.or(`reason.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    const { count } = await countQuery;

    return {
      disputes: formattedDisputes,
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Get dispute by ID for staff
   */
  async getDisputeByIdForStaff(staffId: string, disputeId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    const { data: dispute, error } = await this.supabase
      .from('disputes')
      .select(`
        *,
        order:orders(
          id,
          order_number,
          total_amount,
          buyer_id,
          vendor_id,
          rider_id,
          created_at,
          status
        ),
        dispute_messages(
          id,
          message,
          sender_id,
          staff_id,
          is_admin,
          attachments,
          created_at
        )
      `)
      .eq('id', disputeId)
      .single();

    if (error) {
      this.logger.error(`Failed to fetch dispute ${disputeId}: ${error.message}`);
      throw new NotFoundException(`Dispute not found: ${error.message}`);
    }

    if (!dispute) {
      this.logger.warn(`Dispute ${disputeId} not found`);
      throw new NotFoundException('Dispute not found');
    }

    // Fetch user profiles separately
    const userIds = [dispute.disputant_id, dispute.respondent_id].filter(Boolean);
    const userProfilesMap: Record<string, any> = {};
    
    if (userIds.length > 0) {
      const { data: profiles } = await this.supabase
        .from('user_profiles')
        .select('id, username, preferences')
        .in('id', userIds);

      profiles?.forEach(profile => {
        userProfilesMap[profile.id] = profile;
      });
    }

    const complainantProfile = userProfilesMap[dispute.disputant_id];
    const respondentProfile = userProfilesMap[dispute.respondent_id];

    // Fetch staff information for staff messages (if staff_id column exists)
    // Check if any message has staff_id (migration 116 may not have run)
    const staffIds = (dispute.dispute_messages || [])
      .filter((msg: any) => msg.staff_id)
      .map((msg: any) => msg.staff_id);
    
    const staffMap: Record<string, any> = {};
    if (staffIds.length > 0) {
      const { data: staffMembers } = await this.supabase
        .from('staff_accounts')
        .select('id, full_name, email')
        .in('id', staffIds);
      
      staffMembers?.forEach((staff) => {
        staffMap[staff.id] = staff;
      });
    }

    // Map messages with sender information
    const mappedMessages = (dispute.dispute_messages || []).map((msg: any) => {
      // Check if this is a staff message (either has staff_id or is_admin flag)
      const isStaffMessage = msg.staff_id || (msg.is_admin && !msg.sender_id);
      
      if (isStaffMessage && msg.staff_id) {
        // Staff message with staff_id (migration 116 applied)
        const staff = staffMap[msg.staff_id];
        return {
          id: msg.id,
          message: msg.message,
          senderId: msg.staff_id,
          senderName: staff?.full_name || 'Customer Care',
          isAdminMessage: true,
          isStaffMessage: true,
          attachments: msg.attachments || [],
          createdAt: msg.created_at,
        };
      } else if (msg.is_admin && !msg.sender_id) {
        // Staff message without staff_id (migration 116 not applied yet)
        return {
          id: msg.id,
          message: msg.message,
          senderId: null,
          senderName: 'Customer Care',
          isAdminMessage: true,
          isStaffMessage: true,
          attachments: msg.attachments || [],
          createdAt: msg.created_at,
        };
      } else {
        // User message
        const senderProfile = userProfilesMap[msg.sender_id];
        return {
          id: msg.id,
          message: msg.message,
          senderId: msg.sender_id,
          senderName: senderProfile?.preferences?.fullName || senderProfile?.username || 'Unknown',
          isAdminMessage: msg.is_admin || false,
          isStaffMessage: false,
          attachments: msg.attachments || [],
          createdAt: msg.created_at,
        };
      }
    });

    return {
      id: dispute.id,
      disputeId: dispute.id,
      orderNumber: dispute.order?.order_number || 'N/A',
      orderId: dispute.order_id,
      complainant: {
        id: dispute.disputant_id,
        name: complainantProfile?.preferences?.fullName || complainantProfile?.username || 'Unknown',
      },
      respondent: {
        id: dispute.respondent_id,
        name: respondentProfile?.preferences?.fullName || respondentProfile?.username || 'Unknown',
      },
      type: dispute.dispute_type,
      status: dispute.status,
      priority: dispute.priority || 'medium',
      reason: dispute.reason,
      description: dispute.description || dispute.reason || 'No description',
      evidence: dispute.evidence,
      resolution: dispute.resolution,
      resolutionReason: dispute.resolution_reason || dispute.resolution_notes,
      resolvedBy: dispute.resolved_by,
      resolvedAt: dispute.resolved_at,
      adminNotes: dispute.admin_notes,
      createdAt: dispute.created_at,
      updatedAt: dispute.updated_at,
      messages: mappedMessages,
      order: dispute.order,
    };
  }

  /**
   * Resolve dispute for staff
   */
  async resolveDisputeForStaff(
    staffId: string,
    disputeId: string,
    resolution: string,
    outcome: 'favor_complainant' | 'favor_respondent' | 'partial',
  ) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} resolving dispute ${disputeId}`);

    // First, verify dispute exists
    const { data: dispute, error: disputeError } = await this.supabase
      .from('disputes')
      .select('id, status')
      .eq('id', disputeId)
      .single();

    if (disputeError || !dispute) {
      this.logger.error(`Dispute ${disputeId} not found for resolution`);
      throw new NotFoundException('Dispute not found');
    }

    // Map outcome to resolution type
    const resolutionType = outcome === 'favor_complainant' 
      ? 'refund_buyer'
      : outcome === 'favor_respondent'
      ? 'release_to_vendor'
      : 'partial_refund';

    // Update dispute status
    // Note: resolved_by might reference user_profiles, not staff_accounts
    // We'll store staffId but it may not have a foreign key constraint
    const updateData: any = {
      status: 'resolved',
      resolution: resolutionType,
      resolution_reason: resolution,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Only set resolved_by if the column accepts it (may fail if FK constraint exists)
    // If it fails, we'll catch the error and continue without it
    try {
      updateData.resolved_by = staffId;
    } catch (e) {
      this.logger.warn(`Could not set resolved_by to staffId (may require user ID): ${e}`);
    }

    const { error } = await this.supabase
      .from('disputes')
      .update(updateData)
      .eq('id', disputeId);

    if (error) {
      // If error is about resolved_by foreign key, try without it
      if (error.message?.includes('resolved_by') || error.message?.includes('foreign key')) {
        this.logger.warn(`resolved_by FK constraint issue, updating without it`);
        delete updateData.resolved_by;
        const retryResult = await this.supabase
          .from('disputes')
          .update(updateData)
          .eq('id', disputeId);
        
        if (retryResult.error) {
          this.logger.error(`Failed to resolve dispute: ${retryResult.error.message}`);
          throw new Error(`Failed to resolve dispute: ${retryResult.error.message}`);
        }
      } else {
        this.logger.error(`Failed to resolve dispute: ${error.message}`);
        throw new Error(`Failed to resolve dispute: ${error.message}`);
      }
    }

    // TODO: Handle escrow release/refund based on outcome
    // This would require integrating with EscrowService

    return { message: 'Dispute resolved successfully' };
  }

  /**
   * Escalate dispute for staff
   * Optionally creates a report and sends it to a department
   */
  async escalateDisputeForStaff(
    staffId: string, 
    disputeId: string, 
    reason: string,
    departmentId?: string,
    createReport?: boolean,
    attachments?: Array<{ type: string; url: string; name: string; size?: string }>
  ) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} escalating dispute ${disputeId}`);

    // First, verify dispute exists and get full details
    const { data: dispute, error: disputeError } = await this.supabase
      .from('disputes')
      .select('id, status, dispute_type, reason, description, order_id, disputant_id, respondent_id')
      .eq('id', disputeId)
      .single();

    if (disputeError || !dispute) {
      this.logger.error(`Dispute ${disputeId} not found for escalation`);
      throw new NotFoundException('Dispute not found');
    }

    // Update dispute status
    const { error } = await this.supabase
      .from('disputes')
      .update({
        status: 'escalated',
        admin_notes: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', disputeId);

    if (error) {
      this.logger.error(`Failed to escalate dispute: ${error.message}`);
      throw new Error(`Failed to escalate dispute: ${error.message}`);
    }

    // If createReport is true and departmentId is provided, create a report
    let reportCreated = false;
    let reportNumber = null;
    
    if (createReport && departmentId) {
      try {
        // Get staff details for report creation
        const { data: staff } = await this.supabase
          .from('staff_accounts')
          .select('id, full_name, department_id')
          .eq('id', staffId)
          .single();

        if (!staff) {
          this.logger.warn(`Staff ${staffId} not found, skipping report creation`);
        } else {
          // Get dispute details for report content
          let disputeDetails: any;
          try {
            disputeDetails = await this.getDisputeByIdForStaff(staffId, disputeId);
          } catch (err) {
            this.logger.warn(`Could not fetch full dispute details: ${err.message}`);
            // Use basic dispute info if full details unavailable
            disputeDetails = {
              disputeId: dispute.id,
              orderNumber: 'N/A',
              type: dispute.dispute_type,
              status: dispute.status,
              complainant: { name: 'Unknown' },
              respondent: { name: 'Unknown' },
              reason: dispute.reason || 'N/A',
              description: dispute.description || 'N/A',
            };
          }
          
          // Create report from dispute
          const reportTitle = `Escalated Dispute: ${disputeDetails.disputeId || dispute.id}`;
          const reportContent = `Dispute Escalation Report

Dispute ID: ${disputeDetails.disputeId || dispute.id}
Order Number: ${disputeDetails.orderNumber || 'N/A'}
Dispute Type: ${disputeDetails.type || dispute.dispute_type}
Status: ${disputeDetails.status || dispute.status}

Complainant: ${disputeDetails.complainant?.name || 'Unknown'}
Respondent: ${disputeDetails.respondent?.name || 'Unknown'}

Reason for Escalation:
${reason}

Original Dispute Reason:
${disputeDetails.reason || dispute.reason || 'N/A'}

Description:
${disputeDetails.description || dispute.description || 'N/A'}`;

          const { data: report, error: reportError } = await this.supabase
            .from('reports')
            .insert({
              title: reportTitle,
              report_type: 'incident',
              content: reportContent,
              data: {
                disputeId: disputeId,
                disputeType: dispute.dispute_type,
                orderId: dispute.order_id,
                escalatedBy: staffId,
                escalatedAt: new Date().toISOString(),
              },
              created_by: staffId,
              department_id: departmentId, // Target department
              visibility: 'department',
              status: 'submitted', // Auto-submit the report
              priority: 'high',
              attachments: attachments || [],
              tags: ['dispute', 'escalation', dispute.dispute_type],
            })
            .select('report_number')
            .single();

          if (reportError) {
            this.logger.error(`Failed to create report for escalated dispute: ${reportError.message}`);
            // Don't throw error - dispute escalation succeeded, report creation is optional
          } else {
            reportCreated = true;
            reportNumber = report.report_number;
            this.logger.log(`Report ${report.report_number} created for escalated dispute ${disputeId}`);
          }
        }
      } catch (reportErr) {
        this.logger.warn(`Failed to create report for escalated dispute (non-critical): ${reportErr.message}`);
        // Don't fail the escalation if report creation fails
      }
    }

    return { 
      message: 'Dispute escalated successfully',
      reportCreated,
      reportNumber,
    };
  }

  /**
   * Add admin note to dispute
   */
  async addAdminNoteToDispute(staffId: string, disputeId: string, note: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    // First, verify dispute exists
    const { data: dispute, error: disputeError } = await this.supabase
      .from('disputes')
      .select('admin_notes')
      .eq('id', disputeId)
      .single();

    if (disputeError || !dispute) {
      this.logger.error(`Dispute ${disputeId} not found for admin note`);
      throw new NotFoundException('Dispute not found');
    }

    const existingNotes = dispute?.admin_notes || '';
    const newNote = existingNotes 
      ? `${existingNotes}\n\n[${new Date().toISOString()}] ${note}`
      : `[${new Date().toISOString()}] ${note}`;

    const { error } = await this.supabase
      .from('disputes')
      .update({
        admin_notes: newNote,
        updated_at: new Date().toISOString(),
      })
      .eq('id', disputeId);

    if (error) {
      this.logger.error(`Failed to add admin note: ${error.message}`);
      throw new Error(`Failed to add admin note: ${error.message}`);
    }

    return { message: 'Admin note added successfully' };
  }

  /**
   * Add staff message to dispute thread
   * Allows customer care staff to communicate with users through dispute messages
   */
  async addStaffMessageToDispute(
    staffId: string,
    disputeId: string,
    message: string,
    attachments?: Array<{ type: string; url: string }>,
  ) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} sending message to dispute ${disputeId}`);

    // Get dispute to verify it exists and get parties
    const { data: dispute, error: disputeError } = await this.supabase
      .from('disputes')
      .select('disputant_id, respondent_id, order:orders(order_number)')
      .eq('id', disputeId)
      .single();

    if (disputeError) {
      this.logger.error(`Failed to fetch dispute ${disputeId} for message: ${disputeError.message}`);
      throw new NotFoundException(`Dispute not found: ${disputeError.message}`);
    }

    if (!dispute) {
      this.logger.warn(`Dispute ${disputeId} not found for message`);
      throw new NotFoundException('Dispute not found');
    }

    // Insert message with staff_id (sender_id will be null for staff messages)
    // Try with staff_id first (if migration 116 has been applied)
    let messageData: any;
    let messageError: any;
    
    // First, try inserting with staff_id
    const insertData: any = {
      dispute_id: disputeId,
      sender_id: null, // Staff messages don't have a user sender
      message,
      attachments: attachments || [],
      is_admin: true,
      created_at: new Date().toISOString(),
    };
    
    // Only include staff_id if the column exists (migration 116 applied)
    // We'll try with it first, and if it fails, we'll try without it
    insertData.staff_id = staffId;
    
    const result = await this.supabase
      .from('dispute_messages')
      .insert(insertData)
      .select()
      .single();

    messageData = result.data;
    messageError = result.error;

    // If error is about staff_id column not existing, try without it
    if (messageError && messageError.message?.includes('staff_id')) {
      this.logger.warn(`staff_id column not found, inserting without it (migration 116 not applied)`);
      delete insertData.staff_id;
      
      const retryResult = await this.supabase
        .from('dispute_messages')
        .insert(insertData)
        .select()
        .single();
      
      messageData = retryResult.data;
      messageError = retryResult.error;
    }

    // If error is about sender_id being null (migration 116 not applied), provide helpful error
    if (messageError && (messageError.message?.includes('sender_id') || messageError.message?.includes('null value'))) {
      this.logger.error(`Cannot send staff message: Migration 116 (add_staff_id_to_dispute_messages) must be applied first`);
      throw new Error('Staff messaging requires database migration 116. Please run the migration to enable staff messages.');
    }

    if (messageError) {
      this.logger.error(`Failed to send staff message: ${messageError.message}`);
      throw new Error(`Failed to send message: ${messageError.message}`);
    }

    // Update dispute updated_at timestamp
    await this.supabase
      .from('disputes')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', disputeId);

    // Notify both parties about the new message
    const orderNumber = dispute.order?.order_number || 'N/A';
    try {
      await this.notificationHelper.notifyDisputeMessage(dispute.disputant_id, disputeId);
      if (dispute.respondent_id && dispute.respondent_id !== dispute.disputant_id) {
        await this.notificationHelper.notifyDisputeMessage(dispute.respondent_id, disputeId);
      }
    } catch (notifyError) {
      this.logger.warn('Failed to send message notifications (non-critical):', notifyError);
    }

    return {
      success: true,
      messageId: messageData.id,
      message: 'Message sent successfully',
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
        order:orders(
          id,
          order_number,
          total_amount,
          vendor_id,
          buyer_id
        ),
        complainant:user_profiles!disputant_id(username, email, phone),
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
        id: d.disputant_id,
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

  /**
   * Get all users for staff admin panel
   * Uses staff authentication and permission checks
   */
  async getAllUsersForStaff(
    staffId: string,
    filters?: {
      role?: 'citizen' | 'vendor' | 'rider';
      status?: 'active' | 'suspended';
      search?: string;
      page?: number;
      limit?: number;
    }
  ) {
    // Verify staff has permission (handled by guard, but double-check)
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('role')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new UnauthorizedException('Staff not found');
    }

    this.logger.log(`Staff ${staffId} fetching users with filters:`, filters);

    let query = this.supabase
      .from('user_profiles')
      .select('id, username, avatar_url, user_role, is_seller, is_rider, created_at, preferences')
      .order('created_at', { ascending: false });

    // Apply role filter
    if (filters?.role) {
      if (filters.role === 'vendor') {
        query = query.or('user_role.eq.vendor,is_seller.eq.true');
      } else if (filters.role === 'rider') {
        query = query.or('user_role.eq.rider,is_rider.eq.true');
      } else if (filters.role === 'citizen') {
        query = query.or('user_role.eq.citizen,and(user_role.neq.vendor,user_role.neq.rider,is_seller.eq.false,is_rider.eq.false)');
      }
    }

    // Apply status filter (using preferences or a status field if it exists)
    if (filters?.status === 'suspended') {
      // Suspended but not deleted
      // Use AND: isSuspended=true AND (isDeleted is null OR false)
      query = query.eq('preferences->>isSuspended', 'true')
        .or('preferences->>isDeleted.is.null,preferences->>isDeleted.eq.false');
    } else if (filters?.status === 'active') {
      // Active (not suspended AND not deleted)
      // Filter out suspended: (isSuspended is null OR false)
      // Filter out deleted: (isDeleted is null OR false)
      // In Supabase, chained filters are ANDed by default
      query = query.or('preferences->>isSuspended.is.null,preferences->>isSuspended.eq.false');
      // Add deleted filter - this will be ANDed with the previous condition
      query = query.or('preferences->>isDeleted.is.null,preferences->>isDeleted.eq.false');
    } else if (filters?.status === 'deleted') {
      // Deleted users
      query = query.eq('preferences->>isDeleted', 'true');
    }

    // Apply search filter (only search by username since email is not in user_profiles)
    if (filters?.search) {
      query = query.ilike('username', `%${filters.search}%`);
    }

    // Apply pagination
    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: users, error, count } = await query;

    if (error) {
      this.logger.error(`Failed to fetch users: ${error.message}`);
      throw new Error(`Failed to fetch users: ${error.message}`);
    }

    // Filter users in JavaScript if needed (for complex AND conditions that Supabase might not handle well)
    let filteredUsers = users || [];
    if (filters?.status === 'active') {
      // Additional client-side filtering to ensure both conditions are met
      filteredUsers = filteredUsers.filter(user => {
        const isSuspended = user.preferences?.isSuspended === true;
        const isDeleted = user.preferences?.isDeleted === true;
        return !isSuspended && !isDeleted;
      });
    } else if (filters?.status === 'suspended') {
      // Additional client-side filtering to exclude deleted
      filteredUsers = filteredUsers.filter(user => {
        const isDeleted = user.preferences?.isDeleted === true;
        return !isDeleted;
      });
    }

    // Get order counts for each user
    const userIds = filteredUsers?.map(u => u.id) || [];
    const { data: orderCounts } = await this.supabase
      .from('orders')
      .select('buyer_id')
      .in('buyer_id', userIds);

    const ordersByUser: Record<string, number> = {};
    orderCounts?.forEach(order => {
      ordersByUser[order.buyer_id] = (ordersByUser[order.buyer_id] || 0) + 1;
    });

    // Fetch emails from auth.users for all users (if needed)
    // Note: Email fetching is done on-demand in getUserByIdForStaff to avoid rate limits
    const emailsMap: Record<string, string> = {};

    // Map to response format
    const mappedUsers = filteredUsers?.map(user => {
      // Determine role: prioritize is_seller and is_rider flags over user_role
      // This ensures users who are actually vendors/riders show the correct role
      let userRole: 'citizen' | 'vendor' | 'rider';
      if (user.is_seller) {
        userRole = 'vendor';
      } else if (user.is_rider) {
        userRole = 'rider';
      } else {
        // Fall back to user_role if flags are not set
        userRole = (user.user_role as 'citizen' | 'vendor' | 'rider') || 'citizen';
      }
      const isSuspended = user.preferences?.isSuspended === true;
      const isDeleted = user.preferences?.isDeleted === true;

      return {
        id: user.id,
        username: user.username,
        email: emailsMap[user.id] || '', // Email not available from user_profiles
        fullName: user.preferences?.fullName || user.username,
        userRole: userRole as 'citizen' | 'vendor' | 'rider',
        isActive: !isSuspended && !isDeleted, // User is active only if not suspended and not deleted
        isDeleted: isDeleted,
        deletedAt: user.preferences?.deletedAt || null,
        deletedBy: user.preferences?.deletedBy || null,
        createdAt: user.created_at,
        avatarUrl: user.avatar_url,
        ordersCount: ordersByUser[user.id] || 0,
      };
    }) || [];

    // Get total count for pagination
    let countQuery = this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true });

    if (filters?.role) {
      if (filters.role === 'vendor') {
        countQuery = countQuery.or('user_role.eq.vendor,is_seller.eq.true');
      } else if (filters.role === 'rider') {
        countQuery = countQuery.or('user_role.eq.rider,is_rider.eq.true');
      } else if (filters.role === 'citizen') {
        countQuery = countQuery.or('user_role.eq.citizen,and(user_role.neq.vendor,user_role.neq.rider,is_seller.eq.false,is_rider.eq.false)');
      }
    }

    if (filters?.status === 'suspended') {
      // Suspended but not deleted
      countQuery = countQuery.eq('preferences->>isSuspended', 'true')
        .or('preferences->>isDeleted.is.null,preferences->>isDeleted.eq.false');
    } else if (filters?.status === 'active') {
      // Active (not suspended and not deleted)
      countQuery = countQuery.or('preferences->>isSuspended.is.null,preferences->>isSuspended.eq.false')
        .or('preferences->>isDeleted.is.null,preferences->>isDeleted.eq.false');
    } else if (filters?.status === 'deleted') {
      // Deleted users
      countQuery = countQuery.eq('preferences->>isDeleted', 'true');
    }

    if (filters?.search) {
      countQuery = countQuery.or(`username.ilike.%${filters.search}%,email.ilike.%${filters.search}%`);
    }

    const { count: totalCount } = await countQuery;

    return {
      users: mappedUsers,
      total: totalCount || 0,
      page,
      limit,
    };
  }

  /**
   * Get user statistics for staff admin panel
   */
  async getUserStatsForStaff(staffId: string) {
    // Verify staff
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('role')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new UnauthorizedException('Staff not found');
    }

    // Get total users
    const { count: totalUsers } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true });

    // Get vendors
    const { count: vendors } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .or('user_role.eq.vendor,is_seller.eq.true');

    // Get riders
    const { count: riders } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .or('user_role.eq.rider,is_rider.eq.true');

    // Get suspended users
    const { count: suspended } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('preferences->>isSuspended', 'true');

    return {
      totalUsers: totalUsers || 0,
      vendors: vendors || 0,
      riders: riders || 0,
      suspended: suspended || 0,
    };
  }

  /**
   * Get user by ID for staff admin panel
   */
  async getUserByIdForStaff(staffId: string, userId: string) {
    // Verify staff
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('role')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new UnauthorizedException('Staff not found');
    }

    const { data: user, error } = await this.supabase
      .from('user_profiles')
      .select('id, username, avatar_url, user_role, is_seller, is_rider, created_at, preferences')
      .eq('id', userId)
      .single();

    if (error || !user) {
      throw new Error('User not found');
    }

    // Try to get email from auth.users using admin API
    let email = '';
    try {
      const { data: authUser } = await this.supabase.auth.admin.getUserById(userId);
      email = authUser?.user?.email || '';
    } catch (err) {
      // If we can't get email, just leave it empty
      this.logger.warn(`Could not fetch email for user ${userId}`);
    }

    // Determine role: prioritize is_seller and is_rider flags over user_role
    // This ensures users who are actually vendors/riders show the correct role
    let userRole: 'citizen' | 'vendor' | 'rider';
    if (user.is_seller) {
      userRole = 'vendor';
    } else if (user.is_rider) {
      userRole = 'rider';
    } else {
      // Fall back to user_role if flags are not set
      userRole = (user.user_role as 'citizen' | 'vendor' | 'rider') || 'citizen';
    }
    const isSuspended = user.preferences?.isSuspended === true;
    const isDeleted = user.preferences?.isDeleted === true;

    // Get order count
    const { count: ordersCount } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('buyer_id', userId);

    return {
      id: user.id,
      username: user.username,
      email: email,
      fullName: user.preferences?.fullName || user.username,
      userRole: userRole as 'citizen' | 'vendor' | 'rider',
      isActive: !isSuspended && !isDeleted, // User is active only if not suspended and not deleted
      isDeleted: isDeleted,
      deletedAt: user.preferences?.deletedAt || null,
      deletedBy: user.preferences?.deletedBy || null,
      createdAt: user.created_at,
      avatarUrl: user.avatar_url,
      ordersCount: ordersCount || 0,
    };
  }

  /**
   * Suspend user account
   */
  async suspendUser(staffId: string, userId: string, reason?: string) {
    // Verify staff
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('role, full_name')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new UnauthorizedException('Staff not found');
    }

    // Get current user preferences
    const { data: user } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (!user) {
      throw new Error('User not found');
    }

    // Update preferences to mark as suspended
    const updatedPreferences = {
      ...(user.preferences || {}),
      isSuspended: true,
      suspendedAt: new Date().toISOString(),
      suspendedBy: staffId,
      suspensionReason: reason || 'Suspended by admin',
    };

    const { error } = await this.supabase
      .from('user_profiles')
      .update({ preferences: updatedPreferences })
      .eq('id', userId);

    if (error) {
      this.logger.error(`Failed to suspend user: ${error.message}`);
      throw new Error(`Failed to suspend user: ${error.message}`);
    }

    this.logger.log(`User ${userId} suspended by staff ${staffId}`);

    return { message: 'User suspended successfully' };
  }

  /**
   * Activate user account
   */
  async activateUser(staffId: string, userId: string) {
    // Verify staff
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('role, full_name')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new UnauthorizedException('Staff not found');
    }

    // Get current user preferences
    const { data: user } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (!user) {
      throw new Error('User not found');
    }

    // Update preferences to remove suspension
    const updatedPreferences = {
      ...(user.preferences || {}),
      isSuspended: false,
      activatedAt: new Date().toISOString(),
      activatedBy: staffId,
    };

    const { error } = await this.supabase
      .from('user_profiles')
      .update({ preferences: updatedPreferences })
      .eq('id', userId);

    if (error) {
      this.logger.error(`Failed to activate user: ${error.message}`);
      throw new Error(`Failed to activate user: ${error.message}`);
    }

    this.logger.log(`User ${userId} activated by staff ${staffId}`);

    return { message: 'User activated successfully' };
  }

  /**
   * Warn a user
   * Creates a warning record and updates user preferences
   */
  async warnUser(
    staffId: string,
    userId: string,
    severity: 'low' | 'medium' | 'high',
    reason: string,
    relatedContentId?: string,
    relatedContentType?: 'product' | 'service' | 'chat' | 'user',
  ) {
    // Verify staff
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('role, full_name')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new UnauthorizedException('Staff not found');
    }

    // Get current user preferences
    const { data: user } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Insert warning into user_warnings table
    const { data: warning, error: warningError } = await this.supabase
      .from('user_warnings')
      .insert({
        user_id: userId,
        warned_by: staffId,
        severity,
        reason,
        related_content_id: relatedContentId || null,
        related_content_type: relatedContentType || null,
      })
      .select()
      .single();

    if (warningError) {
      this.logger.error(`Failed to create warning: ${warningError.message}`);
      throw new Error(`Failed to create warning: ${warningError.message}`);
    }

    // Get current warning count
    const { data: warnings, error: countError } = await this.supabase
      .from('user_warnings')
      .select('severity')
      .eq('user_id', userId);

    if (countError) {
      this.logger.warn(`Failed to count warnings: ${countError.message}`);
    }

    // Calculate warning statistics
    const warningCount = warnings?.length || 0;
    const highSeverityCount = warnings?.filter((w) => w.severity === 'high').length || 0;
    const mediumSeverityCount = warnings?.filter((w) => w.severity === 'medium').length || 0;
    const lowSeverityCount = warnings?.filter((w) => w.severity === 'low').length || 0;

    // Determine highest severity
    const highestSeverity = highSeverityCount > 0 ? 'high' : mediumSeverityCount > 0 ? 'medium' : 'low';

    // Update user preferences with warning summary
    const updatedPreferences = {
      ...(user.preferences || {}),
      warningCount,
      warningSeverity: highestSeverity,
      lastWarningAt: new Date().toISOString(),
      autoSuspendThreshold: highestSeverity === 'high' ? 3 : highestSeverity === 'medium' ? 5 : 10,
    };

    const { error: updateError } = await this.supabase
      .from('user_profiles')
      .update({ preferences: updatedPreferences })
      .eq('id', userId);

    if (updateError) {
      this.logger.error(`Failed to update user preferences: ${updateError.message}`);
      // Don't throw - warning was created successfully
    }

    // Check if auto-suspend threshold reached
    const AUTO_SUSPEND_THRESHOLD_HIGH = 3;
    const AUTO_SUSPEND_THRESHOLD_MEDIUM = 5;
    const AUTO_SUSPEND_THRESHOLD_LOW = 10;

    let shouldAutoSuspend = false;
    // Check if any severity level has reached its threshold
    if (highSeverityCount >= AUTO_SUSPEND_THRESHOLD_HIGH) {
      shouldAutoSuspend = true;
    } else if (mediumSeverityCount >= AUTO_SUSPEND_THRESHOLD_MEDIUM) {
      shouldAutoSuspend = true;
    } else if (lowSeverityCount >= AUTO_SUSPEND_THRESHOLD_LOW) {
      shouldAutoSuspend = true;
    }

    if (shouldAutoSuspend) {
      try {
        await this.suspendUser(staffId, userId, `Auto-suspended after ${warningCount} warnings (${highSeverityCount} high, ${mediumSeverityCount} medium, ${lowSeverityCount} low)`);
        this.logger.log(`User ${userId} auto-suspended after reaching warning threshold`);
      } catch (suspendError) {
        this.logger.error(`Failed to auto-suspend user: ${suspendError.message}`);
        // Don't throw - warning was created successfully
      }
    }

    // Send notification to user
    try {
      await this.notificationHelper.notifyUserWarning(userId, {
        warningId: warning.id,
        severity,
        reason,
        warningCount,
        relatedContentId,
        relatedContentType,
      });
    } catch (notifError) {
      this.logger.warn(`Failed to send warning notification: ${notifError.message}`);
      // Don't throw - warning was created successfully
    }

    // Log audit action
    try {
      await this.auditService.logAction({
        staffId,
        action: AuditAction.EDIT_USER,
        entityType: AuditEntityType.USER,
        entityId: userId,
        details: {
          action: 'warn_user',
          severity,
          reason,
          warning_count: warningCount,
          auto_suspended: shouldAutoSuspend,
        },
        status: AuditStatus.SUCCESS,
      });
    } catch (auditError) {
      this.logger.warn(`Failed to log audit action: ${auditError.message}`);
    }

    this.logger.log(`User ${userId} warned by staff ${staffId} with ${severity} severity`);

    return {
      message: 'User warned successfully',
      warning: {
        id: warning.id,
        severity,
        reason,
        warningCount,
        autoSuspended: shouldAutoSuspend,
      },
    };
  }

  /**
   * Get user warnings
   */
  async getUserWarnings(userId: string) {
    const { data: warnings, error } = await this.supabase
      .from('user_warnings')
      .select(`
        id,
        severity,
        reason,
        related_content_id,
        related_content_type,
        created_at,
        warned_by,
        staff_accounts:staff_accounts!warned_by(
          id,
          full_name,
          email
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch warnings: ${error.message}`);
      throw new Error(`Failed to fetch warnings: ${error.message}`);
    }

    return (warnings || []).map((warning: any) => ({
      id: warning.id,
      severity: warning.severity,
      reason: warning.reason,
      relatedContentId: warning.related_content_id,
      relatedContentType: warning.related_content_type,
      createdAt: warning.created_at,
      warnedBy: warning.staff_accounts
        ? {
            id: warning.staff_accounts.id,
            fullName: warning.staff_accounts.full_name,
            email: warning.staff_accounts.email,
          }
        : null,
    }));
  }

  /**
   * Get warning statistics for a user
   */
  async getWarningStats(userId: string) {
    const { data: warnings, error } = await this.supabase
      .from('user_warnings')
      .select('severity, created_at')
      .eq('user_id', userId);

    if (error) {
      this.logger.error(`Failed to fetch warning stats: ${error.message}`);
      throw new Error(`Failed to fetch warning stats: ${error.message}`);
    }

    const totalWarnings = warnings?.length || 0;
    const highCount = warnings?.filter((w) => w.severity === 'high').length || 0;
    const mediumCount = warnings?.filter((w) => w.severity === 'medium').length || 0;
    const lowCount = warnings?.filter((w) => w.severity === 'low').length || 0;

    const lastWarning = warnings && warnings.length > 0
      ? warnings.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
      : null;

    // Get user suspension status
    const { data: user } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    const isSuspended = user?.preferences?.isSuspended === true;

    return {
      totalWarnings,
      highCount,
      mediumCount,
      lowCount,
      lastWarningAt: lastWarning?.created_at || null,
      isSuspended,
      suspensionReason: isSuspended ? user?.preferences?.suspensionReason : null,
    };
  }

  /**
   * Delete user account (for staff admin panel)
   */
  async deleteUserForStaff(staffId: string, userId: string) {
    // Verify staff
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('role')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new UnauthorizedException('Staff not found');
    }

    // Use the existing deleteAccount method from UsersService
    // But we need to import it or call it differently
    // For now, we'll do a soft delete by marking as deleted in preferences
    const { data: user } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (!user) {
      throw new Error('User not found');
    }

    // Mark as deleted
    const updatedPreferences = {
      ...(user.preferences || {}),
      isDeleted: true,
      deletedAt: new Date().toISOString(),
      deletedBy: staffId,
    };

    const { error } = await this.supabase
      .from('user_profiles')
      .update({ preferences: updatedPreferences })
      .eq('id', userId);

    if (error) {
      this.logger.error(`Failed to delete user: ${error.message}`);
      throw new Error(`Failed to delete user: ${error.message}`);
    }

    this.logger.log(`User ${userId} marked as deleted by staff ${staffId}`);

    return { message: 'User deleted successfully' };
  }

  // ============================================
  // CONTENT MODERATION METHODS
  // ============================================

  /**
   * Verify staff has permission for content moderation
   */
  async verifyContentModerator(staffId: string): Promise<boolean> {
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('role, is_active')
      .eq('id', staffId)
      .single();

    if (!staff || !staff.is_active) {
      throw new UnauthorizedException('Staff not found or inactive');
    }

    return true;
  }

  /**
   * Verify staff has permission for finance operations
   * Checks if staff belongs to finance department or has finance role
   */
  async verifyFinanceStaff(staffId: string): Promise<boolean> {
    const { data: staff, error } = await this.supabase
      .from('staff_accounts')
      .select(`
        id,
        role,
        is_active,
        department_id,
        department:departments(
          id,
          name,
          slug
        )
      `)
      .eq('id', staffId)
      .single();

    if (error || !staff) {
      this.logger.warn(`Finance staff verification failed: Staff not found for ID ${staffId}`);
      throw new UnauthorizedException('Staff not found');
    }

    if (!staff.is_active) {
      this.logger.warn(`Finance staff verification failed: Staff ${staffId} is inactive`);
      throw new UnauthorizedException('Staff account is inactive');
    }

    // Check if staff is in finance department or has finance-related role
    const departmentSlug = (staff.department as any)?.slug || '';
    const isFinanceDepartment = departmentSlug === 'finance' || departmentSlug === 'financial';
    const isFinanceRole = staff.role === 'finance_manager' || staff.role === 'financial_analyst' || staff.role === 'super_admin';

    if (!isFinanceDepartment && !isFinanceRole) {
      this.logger.warn(`Finance staff verification failed: Staff ${staffId} (role: ${staff.role}, dept: ${departmentSlug}) does not have finance permissions`);
      throw new UnauthorizedException('Finance department access required');
    }

    return true;
  }

  /**
   * Get products for moderation
   */
  async getProductsForModeration(
    staffId: string,
    filters: { status?: string; page?: number; limit?: number; search?: string },
  ) {
    await this.verifyContentModerator(staffId);

    let query = this.supabase
      .from('products')
      .select(`
        id,
        name,
        description,
        price,
        quantity,
        status,
        primary_image_url,
        images,
        videos,
        primary_video_url,
        media_type,
        view_count,
        like_count,
        created_at,
        updated_at,
        user:user_profiles(id, username, avatar_url, preferences)
      `)
      .order('created_at', { ascending: false });

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.search) {
      query = query.or(`name.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: products, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch products: ${error.message}`);
      throw new Error(`Failed to fetch products: ${error.message}`);
    }

    // Get total count
    const { count } = await this.supabase
      .from('products')
      .select('*', { count: 'exact', head: true });

    return {
      products: products || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * Get product by ID for moderation (bypasses pagination)
   */
  async getProductByIdForModeration(staffId: string, productId: string) {
    await this.verifyContentModerator(staffId);

    this.logger.log(`[getProductByIdForModeration] Fetching product ${productId} for staff ${staffId}`);

    const { data: product, error } = await this.supabase
      .from('products')
      .select(`
        id,
        name,
        description,
        price,
        quantity,
        status,
        primary_image_url,
        images,
        videos,
        primary_video_url,
        media_type,
        view_count,
        like_count,
        created_at,
        updated_at,
        user:user_profiles(id, username, avatar_url, preferences)
      `)
      .eq('id', productId)
      .single();

    if (error) {
      this.logger.error(`[getProductByIdForModeration] Failed to fetch product ${productId}:`, {
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });
      throw new NotFoundException(`Product not found: ${error.message}`);
    }

    if (!product) {
      this.logger.warn(`[getProductByIdForModeration] Product ${productId} not found (null result)`);
      throw new NotFoundException('Product not found');
    }

    this.logger.log(`[getProductByIdForModeration] Successfully fetched product ${productId}: ${product.name}`);
    return product;
  }

  /**
   * Approve product
   */
  async approveProduct(staffId: string, productId: string, reason?: string) {
    await this.verifyContentModerator(staffId);

    const { error } = await this.supabase
      .from('products')
      .update({ status: 'active' })
      .eq('id', productId);

    if (error) {
      this.logger.error(`Failed to approve product: ${error.message}`);
      throw new Error(`Failed to approve product: ${error.message}`);
    }

    // Log to audit_logs
    await this.auditService.logContentAction(
      staffId,
      AuditAction.APPROVE_PRODUCT,
      AuditEntityType.PRODUCT,
      productId,
      { reason },
    );
    this.logger.log(`Product ${productId} approved by staff ${staffId}`);

    return { message: 'Product approved successfully' };
  }

  /**
   * Reject/Remove product
   */
  async rejectProduct(staffId: string, productId: string, reason: string) {
    await this.verifyContentModerator(staffId);

    const { error } = await this.supabase
      .from('products')
      .update({ status: 'inactive' })
      .eq('id', productId);

    if (error) {
      this.logger.error(`Failed to reject product: ${error.message}`);
      throw new Error(`Failed to reject product: ${error.message}`);
    }

    // Log to audit_logs with reason
    await this.auditService.logContentAction(
      staffId,
      AuditAction.REJECT_PRODUCT,
      AuditEntityType.PRODUCT,
      productId,
      { reason },
    );
    this.logger.log(`Product ${productId} rejected by staff ${staffId}. Reason: ${reason}`);

    return { message: 'Product rejected successfully' };
  }

  /**
   * Get services for moderation
   */
  async getServicesForModeration(
    staffId: string,
    filters: { status?: string; page?: number; limit?: number; search?: string },
  ) {
    await this.verifyContentModerator(staffId);

    let query = this.supabase
      .from('services')
      .select(`
        id,
        name,
        description,
        base_price,
        duration,
        status,
        primary_media_url,
        images,
        videos,
        media_type,
        view_count,
        like_count,
        booking_count,
        created_at,
        updated_at,
        user:user_profiles(id, username, avatar_url, preferences)
      `)
      .order('created_at', { ascending: false });

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.search) {
      query = query.or(`name.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: services, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch services: ${error.message}`);
      throw new Error(`Failed to fetch services: ${error.message}`);
    }

    const { count } = await this.supabase
      .from('services')
      .select('*', { count: 'exact', head: true });

    return {
      services: services || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * Approve service
   */
  async approveService(staffId: string, serviceId: string, reason?: string) {
    await this.verifyContentModerator(staffId);

    const { error } = await this.supabase
      .from('services')
      .update({ status: 'active' })
      .eq('id', serviceId);

    if (error) {
      this.logger.error(`Failed to approve service: ${error.message}`);
      throw new Error(`Failed to approve service: ${error.message}`);
    }

    this.logger.log(`Service ${serviceId} approved by staff ${staffId}`);

    return { message: 'Service approved successfully' };
  }

  /**
   * Get service by ID for moderation (bypasses pagination)
   */
  async getServiceByIdForModeration(staffId: string, serviceId: string) {
    await this.verifyContentModerator(staffId);

    this.logger.log(`[getServiceByIdForModeration] Fetching service ${serviceId} for staff ${staffId}`);

    const { data: service, error } = await this.supabase
      .from('services')
      .select(`
        id,
        name,
        description,
        base_price,
        duration,
        status,
        primary_media_url,
        images,
        videos,
        media_type,
        view_count,
        like_count,
        booking_count,
        created_at,
        updated_at,
        user:user_profiles(id, username, avatar_url, preferences)
      `)
      .eq('id', serviceId)
      .single();

    if (error) {
      this.logger.error(`[getServiceByIdForModeration] Failed to fetch service ${serviceId}:`, {
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });
      throw new NotFoundException(`Service not found: ${error.message}`);
    }

    if (!service) {
      this.logger.warn(`[getServiceByIdForModeration] Service ${serviceId} not found (null result)`);
      throw new NotFoundException('Service not found');
    }

    this.logger.log(`[getServiceByIdForModeration] Successfully fetched service ${serviceId}: ${service.name}`);
    return service;
  }

  /**
   * Reject/Remove service
   */
  async rejectService(staffId: string, serviceId: string, reason: string) {
    await this.verifyContentModerator(staffId);

    const { error } = await this.supabase
      .from('services')
      .update({ status: 'inactive' })
      .eq('id', serviceId);

    if (error) {
      this.logger.error(`Failed to reject service: ${error.message}`);
      throw new Error(`Failed to reject service: ${error.message}`);
    }

    this.logger.log(`Service ${serviceId} rejected by staff ${staffId}. Reason: ${reason}`);

    return { message: 'Service rejected successfully' };
  }

  /**
   * Get stories for moderation
   */
  async getStoriesForModeration(
    staffId: string,
    filters: { page?: number; limit?: number; search?: string },
  ) {
    await this.verifyContentModerator(staffId);

    let query = this.supabase
      .from('stories')
      .select(`
        id,
        media_url,
        media_type,
        thumbnail_url,
        caption,
        is_active,
        expires_at,
        view_count,
        like_count,
        created_at,
        user:user_profiles(id, username, avatar_url, preferences)
      `)
      .order('created_at', { ascending: false });

    if (filters.search) {
      query = query.or(`caption.ilike.%${filters.search}%`);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: stories, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch stories: ${error.message}`);
      throw new Error(`Failed to fetch stories: ${error.message}`);
    }

    const { count } = await this.supabase
      .from('stories')
      .select('*', { count: 'exact', head: true });

    return {
      stories: stories || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * Remove story
   */
  async removeStory(staffId: string, storyId: string, reason: string) {
    await this.verifyContentModerator(staffId);

    const { error } = await this.supabase
      .from('stories')
      .update({ is_active: false })
      .eq('id', storyId);

    if (error) {
      this.logger.error(`Failed to remove story: ${error.message}`);
      throw new Error(`Failed to remove story: ${error.message}`);
    }

    this.logger.log(`Story ${storyId} removed by staff ${staffId}. Reason: ${reason}`);

    return { message: 'Story removed successfully' };
  }

  /**
   * Get live streams for moderation
   */
  async getLiveStreamsForModeration(
    staffId: string,
    filters: { status?: string; page?: number; limit?: number },
  ) {
    await this.verifyContentModerator(staffId);

    let query = this.supabase
      .from('live_streams')
      .select(`
        id,
        title,
        description,
        stream_type,
        status,
        viewer_count,
        total_viewers,
        total_sales,
        thumbnail_url,
        started_at,
        ended_at,
        created_at,
        vendor:user_profiles(id, username, avatar_url, preferences)
      `)
      .order('created_at', { ascending: false });

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: streams, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch live streams: ${error.message}`);
      throw new Error(`Failed to fetch live streams: ${error.message}`);
    }

    const { count } = await this.supabase
      .from('live_streams')
      .select('*', { count: 'exact', head: true });

    return {
      streams: streams || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * End live stream
   */
  async endLiveStream(staffId: string, streamId: string, reason: string) {
    await this.verifyContentModerator(staffId);

    const { error } = await this.supabase
      .from('live_streams')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
      })
      .eq('id', streamId);

    if (error) {
      this.logger.error(`Failed to end live stream: ${error.message}`);
      throw new Error(`Failed to end live stream: ${error.message}`);
    }

    this.logger.log(`Live stream ${streamId} ended by staff ${staffId}. Reason: ${reason}`);

    return { message: 'Live stream ended successfully' };
  }

  /**
   * Get content moderation statistics
   */
  async getContentModerationStats(staffId: string) {
    await this.verifyContentModerator(staffId);

    // Get counts for each content type
    const [productsCount, servicesCount, storiesCount, streamsCount, auctionsCount] = await Promise.all([
      this.supabase.from('products').select('*', { count: 'exact', head: true }),
      this.supabase.from('services').select('*', { count: 'exact', head: true }),
      this.supabase.from('stories').select('*', { count: 'exact', head: true }),
      this.supabase.from('live_streams').select('*', { count: 'exact', head: true }),
      this.supabase.from('auctions').select('*', { count: 'exact', head: true }),
    ]);

    // Get pending/flagged counts (draft status for products/services)
    const [pendingProducts, pendingServices, activeStories, liveStreams, scheduledAuctions, activeAuctions, endedAuctions] = await Promise.all([
      this.supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
      this.supabase.from('services').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
      this.supabase.from('stories').select('*', { count: 'exact', head: true }).eq('is_active', true),
      this.supabase.from('live_streams').select('*', { count: 'exact', head: true }).eq('status', 'live'),
      this.supabase.from('auctions').select('*', { count: 'exact', head: true }).eq('status', 'scheduled'),
      this.supabase.from('auctions').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      this.supabase.from('auctions').select('*', { count: 'exact', head: true }).eq('status', 'ended'),
    ]);

    return {
      products: {
        total: productsCount.count || 0,
        pending: pendingProducts.count || 0,
        active: 0, // Calculate from status='active'
        inactive: 0, // Calculate from status='inactive'
      },
      services: {
        total: servicesCount.count || 0,
        pending: pendingServices.count || 0,
        active: 0,
        inactive: 0,
      },
      stories: {
        total: storiesCount.count || 0,
        active: activeStories.count || 0,
      },
      liveStreams: {
        total: streamsCount.count || 0,
        live: liveStreams.count || 0,
        ended: 0,
      },
      auctions: {
        total: auctionsCount.count || 0,
        scheduled: scheduledAuctions.count || 0,
        active: activeAuctions.count || 0,
        ended: endedAuctions.count || 0,
      },
    };
  }

  /**
   * Get auctions for moderation
   */
  async getAuctionsForModeration(
    staffId: string,
    filters: { status?: string; page?: number; limit?: number; search?: string },
  ) {
    await this.verifyContentModerator(staffId);

    let query = this.supabase
      .from('auctions')
      .select(`
        id,
        title,
        description,
        lot_number,
        starting_price,
        reserve_price,
        current_bid,
        auction_type,
        start_time,
        end_time,
        status,
        total_bids,
        unique_bidders,
        view_count,
        watch_count,
        images,
        thumbnail_url,
        video_url,
        created_at,
        updated_at,
        seller:user_profiles!seller_id(id, username, avatar_url, preferences)
      `)
      .order('created_at', { ascending: false });

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.search) {
      query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: auctions, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch auctions: ${error.message}`);
      throw new Error(`Failed to fetch auctions: ${error.message}`);
    }

    const { count } = await this.supabase
      .from('auctions')
      .select('*', { count: 'exact', head: true });

    return {
      auctions: auctions || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * Approve auction
   */
  async approveAuction(staffId: string, auctionId: string, reason?: string) {
    await this.verifyContentModerator(staffId);

    // Check current status
    const { data: auction } = await this.supabase
      .from('auctions')
      .select('status')
      .eq('id', auctionId)
      .single();

    if (!auction) {
      throw new Error('Auction not found');
    }

    // If scheduled, activate it; otherwise just mark as active
    const newStatus = auction.status === 'scheduled' ? 'active' : 'active';

    const { error } = await this.supabase
      .from('auctions')
      .update({ status: newStatus })
      .eq('id', auctionId);

    if (error) {
      this.logger.error(`Failed to approve auction: ${error.message}`);
      throw new Error(`Failed to approve auction: ${error.message}`);
    }

    // Log to audit_logs
    await this.auditService.logContentAction(
      staffId,
      AuditAction.APPROVE_AUCTION,
      AuditEntityType.AUCTION,
      auctionId,
      { reason },
    );
    this.logger.log(`Auction ${auctionId} approved by staff ${staffId}`);

    return { message: 'Auction approved successfully' };
  }

  /**
   * Reject/Cancel auction
   */
  async rejectAuction(staffId: string, auctionId: string, reason: string) {
    await this.verifyContentModerator(staffId);

    const { error } = await this.supabase
      .from('auctions')
      .update({ status: 'cancelled' })
      .eq('id', auctionId);

    if (error) {
      this.logger.error(`Failed to reject auction: ${error.message}`);
      throw new Error(`Failed to reject auction: ${error.message}`);
    }

    // Log to audit_logs with reason
    await this.auditService.logContentAction(
      staffId,
      AuditAction.REJECT_AUCTION,
      AuditEntityType.AUCTION,
      auctionId,
      { reason },
    );
    this.logger.log(`Auction ${auctionId} cancelled by staff ${staffId}. Reason: ${reason}`);

    return { message: 'Auction cancelled successfully' };
  }

  /**
   * Get dashboard overview for staff
   */
  async getDashboardOverviewForStaff(staffId: string) {
    // Verify staff has permission (basic check)
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching dashboard overview`);

    // Get platform stats
    const platformStats = await this.getPlatformStatsForStaff(staffId);

    // Get active disputes count
    const { count: activeDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .in('status', ['open', 'under_review']);

    // Get revenue from released escrows (last 30 days based on released_at)
    // This is for the dashboard's "recent revenue" metric
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentEscrows } = await this.supabase
      .from('escrows')
      .select('platform_amount, released_at')
      .eq('status', 'released')
      .not('released_at', 'is', null) // Ensure released_at exists
      .gte('released_at', thirtyDaysAgo);

    const revenue = recentEscrows?.reduce(
      (sum, e) => sum + parseFloat(e.platform_amount || '0'),
      0
    ) || 0;

    // Get previous period revenue for comparison (30-60 days ago)
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { data: previousEscrows } = await this.supabase
      .from('escrows')
      .select('platform_amount, released_at')
      .eq('status', 'released')
      .gte('released_at', sixtyDaysAgo)
      .lt('released_at', thirtyDaysAgo);

    const previousRevenue = previousEscrows?.reduce(
      (sum, e) => sum + parseFloat(e.platform_amount || '0'),
      0
    ) || 0;

    const revenueChange = previousRevenue > 0
      ? ((revenue - previousRevenue) / previousRevenue) * 100
      : 0;

    // Get user growth (last 30 days vs previous 30 days)
    const { count: recentUsers } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', thirtyDaysAgo);

    const { count: previousUsers } = await this.supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', sixtyDaysAgo)
      .lt('created_at', thirtyDaysAgo);

    const userChange = previousUsers > 0
      ? ((recentUsers - previousUsers) / previousUsers) * 100
      : 0;

    // Get order growth
    const { count: recentOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', thirtyDaysAgo);

    const { count: previousOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', sixtyDaysAgo)
      .lt('created_at', thirtyDaysAgo);

    const orderChange = previousOrders > 0
      ? ((recentOrders - previousOrders) / previousOrders) * 100
      : 0;

    // Get dispute change
    const { count: recentDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .in('status', ['open', 'under_review'])
      .gte('created_at', thirtyDaysAgo);

    const { count: previousDisputes } = await this.supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .in('status', ['open', 'under_review'])
      .gte('created_at', sixtyDaysAgo)
      .lt('created_at', thirtyDaysAgo);

    const disputeChange = previousDisputes > 0
      ? ((recentDisputes - previousDisputes) / previousDisputes) * 100
      : 0;

    // Get recent activities (last 10 activities)
    const { data: recentUsersList } = await this.supabase
      .from('user_profiles')
      .select('id, username, created_at')
      .order('created_at', { ascending: false })
      .limit(3);

    const { data: recentOrdersList } = await this.supabase
      .from('orders')
      .select('id, order_number, status, created_at')
      .order('created_at', { ascending: false })
      .limit(3);

    const { data: recentDisputesList } = await this.supabase
      .from('disputes')
      .select('id, status, created_at')
      .order('created_at', { ascending: false })
      .limit(2);

    const { data: recentProducts } = await this.supabase
      .from('products')
      .select('id, name, status, created_at')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(2);

    // Format recent activities with timestamps for sorting
    const allActivities = [
      ...recentUsersList?.map(u => ({
        id: `user-${u.id}`,
        action: `New user registered: ${u.username}`,
        time: this.getTimeAgo(u.created_at),
        timestamp: new Date(u.created_at).getTime(),
        type: 'user' as const,
      })) || [],
      ...recentOrdersList?.map(o => ({
        id: `order-${o.id}`,
        action: `Order #${o.order_number} ${o.status === 'completed' ? 'completed' : 'created'}`,
        time: this.getTimeAgo(o.created_at),
        timestamp: new Date(o.created_at).getTime(),
        type: 'order' as const,
      })) || [],
      ...recentDisputesList?.map(d => ({
        id: `dispute-${d.id}`,
        action: `Dispute #${d.id} ${d.status === 'open' ? 'opened' : 'updated'}`,
        time: this.getTimeAgo(d.created_at),
        timestamp: new Date(d.created_at).getTime(),
        type: 'dispute' as const,
      })) || [],
      ...recentProducts?.map(p => ({
        id: `product-${p.id}`,
        action: `Product "${p.name}" approved`,
        time: this.getTimeAgo(p.created_at),
        timestamp: new Date(p.created_at).getTime(),
        type: 'content' as const,
      })) || [],
    ];

    // Sort by timestamp (most recent first) and remove timestamp from response
    const recentActivities = allActivities
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10)
      .map(({ timestamp, ...rest }) => rest);

    return {
      stats: {
        totalUsers: platformStats.totalUsers,
        totalOrders: platformStats.totalOrders,
        activeDisputes: activeDisputes || 0,
        revenue: Math.round(revenue),
        userChange: Math.round(userChange * 10) / 10,
        orderChange: Math.round(orderChange * 10) / 10,
        disputeChange: Math.round(disputeChange * 10) / 10,
        revenueChange: Math.round(revenueChange * 10) / 10,
      },
      recentActivities,
    };
  }

  /**
   * Helper method to get time ago string
   */
  private getTimeAgo(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    return date.toLocaleDateString();
  }

  /**
   * Get order statistics for staff
   */
  async getOrderStatsForStaff(staffId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching order statistics`);

    // Get total orders
    const { count: totalOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true });

    // Get orders by status
    const { count: pendingOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'confirmed']);

    const { count: processingOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .in('status', ['accepted', 'processing', 'ready_for_pickup', 'out_for_delivery']);

    const { count: completedOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed');

    const { count: cancelledOrders } = await this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'cancelled');

    return {
      totalOrders: totalOrders || 0,
      pendingOrders: pendingOrders || 0,
      processingOrders: processingOrders || 0,
      completedOrders: completedOrders || 0,
      cancelledOrders: cancelledOrders || 0,
    };
  }

  /**
   * Get orders for staff
   */
  async getOrdersForStaff(
    staffId: string,
    filters: {
      status?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    this.logger.log(`Staff ${staffId} fetching orders with filters:`, filters);

    let query = this.supabase
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        total_amount,
        source,
        created_at,
        updated_at,
        buyer:user_profiles!buyer_id(id, username, preferences),
        vendor:user_profiles!vendor_id(id, username, preferences),
        order_items(id, service_id, product_id)
      `)
      .order('created_at', { ascending: false });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    if (filters.search) {
      query = query.or(`order_number.ilike.%${filters.search}%`);
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.range(from, to);

    const { data: orders, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch orders: ${error.message}`);
      throw new Error(`Failed to fetch orders: ${error.message}`);
    }

    // Transform to response format
    const formattedOrders = orders?.map(order => {
      // Determine order type: check if any order item has a service_id
      // If source is service_booking or any item has service_id, it's a service
      // Otherwise, it's a product
      const hasServiceItems = order.order_items?.some((item: any) => item.service_id !== null) || false;
      const orderType = order.source === 'service_booking' || hasServiceItems ? 'service' : 'product';

      return {
        id: order.id,
        orderNumber: order.order_number,
        customer: order.buyer?.preferences?.fullName || order.buyer?.username || 'Unknown',
        customerEmail: '', // Email not in user_profiles, would need to fetch from auth.users
        vendor: order.vendor?.preferences?.fullName || order.vendor?.username || 'Unknown',
        amount: parseFloat(order.total_amount || '0'),
        status: this.mapOrderStatusForDisplay(order.status),
        type: orderType,
        createdAt: order.created_at,
      };
    }) || [];

    // Get total count
    let countQuery = this.supabase
      .from('orders')
      .select('*', { count: 'exact', head: true });

    if (filters.status) {
      countQuery = countQuery.eq('status', filters.status);
    }

    if (filters.search) {
      countQuery = countQuery.or(`order_number.ilike.%${filters.search}%`);
    }

    const { count } = await countQuery;

    return {
      orders: formattedOrders,
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Get order by ID for staff
   */
  async getOrderByIdForStaff(staffId: string, orderId: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    const { data: order, error } = await this.supabase
      .from('orders')
      .select(`
        *,
        buyer:user_profiles!buyer_id(id, username, preferences),
        vendor:user_profiles!vendor_id(id, username, preferences),
        rider:user_profiles!rider_id(id, username, preferences),
        order_items(id, service_id, product_id, product_name, quantity, unit_price, total_price)
      `)
      .eq('id', orderId)
      .single();

    if (error || !order) {
      throw new NotFoundException('Order not found');
    }

    // Determine order type: check if any order item has a service_id
    // If source is service_booking or any item has service_id, it's a service
    // Otherwise, it's a product
    const hasServiceItems = order.order_items?.some((item: any) => item.service_id !== null) || false;
    const orderType = order.source === 'service_booking' || hasServiceItems ? 'service' : 'product';

    return {
      id: order.id,
      orderNumber: order.order_number,
      customer: order.buyer?.preferences?.fullName || order.buyer?.username || 'Unknown',
      customerEmail: '',
      vendor: order.vendor?.preferences?.fullName || order.vendor?.username || 'Unknown',
      rider: order.rider?.preferences?.fullName || order.rider?.username,
      amount: parseFloat(order.total_amount || '0'),
      status: this.mapOrderStatusForDisplay(order.status),
      type: orderType,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      deliveryAddress: order.delivery_address,
      orderItems: order.order_items || [],
    };
  }

  /**
   * Update order status for staff
   */
  async updateOrderStatusForStaff(staffId: string, orderId: string, status: 'pending' | 'processing' | 'completed' | 'cancelled') {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    // Map display status to actual order status
    const actualStatus = this.mapDisplayStatusToOrderStatus(status);

    const { data: order, error: fetchError } = await this.supabase
      .from('orders')
      .select('id, status')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Order not found');
    }

    // Don't allow updating if already completed or cancelled
    if (order.status === 'completed' || order.status === 'cancelled') {
      throw new Error('Cannot update status of completed or cancelled orders');
    }

    const updateData: any = {
      status: actualStatus,
      updated_at: new Date().toISOString(),
    };

    // Set completion timestamp if marking as completed
    if (status === 'completed') {
      updateData.delivered_at = new Date().toISOString();
      updateData.escrow_release_at = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // 6 hours
    }

    // Set cancellation timestamp if cancelling
    if (status === 'cancelled') {
      updateData.cancelled_at = new Date().toISOString();
    }

    const { error } = await this.supabase
      .from('orders')
      .update(updateData)
      .eq('id', orderId);

    if (error) {
      this.logger.error(`Failed to update order status: ${error.message}`);
      throw new Error(`Failed to update order status: ${error.message}`);
    }

    this.logger.log(`Staff ${staffId} updated order ${orderId} status to ${status}`);
    return { message: 'Order status updated successfully' };
  }

  /**
   * Cancel order for staff
   */
  async cancelOrderForStaff(staffId: string, orderId: string, reason?: string) {
    // Verify staff has permission
    await this.verifyContentModerator(staffId);

    const { data: order, error: fetchError } = await this.supabase
      .from('orders')
      .select('id, status')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Order not found');
    }

    // Don't allow cancelling if already completed or cancelled
    if (order.status === 'completed') {
      throw new Error('Cannot cancel a completed order');
    }

    if (order.status === 'cancelled') {
      throw new Error('Order is already cancelled');
    }

    const { error } = await this.supabase
      .from('orders')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        cancellation_reason: reason || 'Cancelled by admin',
      })
      .eq('id', orderId);

    if (error) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw new Error(`Failed to cancel order: ${error.message}`);
    }

    this.logger.log(`Staff ${staffId} cancelled order ${orderId}`);
    return { message: 'Order cancelled successfully' };
  }

  /**
   * Map display status to actual order status
   */
  private mapDisplayStatusToOrderStatus(displayStatus: 'pending' | 'processing' | 'completed' | 'cancelled'): string {
    const statusMap: Record<string, string> = {
      'pending': 'pending',
      'processing': 'processing',
      'completed': 'completed',
      'cancelled': 'cancelled',
    };

    return statusMap[displayStatus] || 'pending';
  }

  /**
   * Map order status to display status
   */
  private mapOrderStatusForDisplay(status: string): 'pending' | 'processing' | 'completed' | 'cancelled' {
    const statusMap: Record<string, 'pending' | 'processing' | 'completed' | 'cancelled'> = {
      'pending': 'pending',
      'confirmed': 'pending',
      'accepted': 'processing',
      'processing': 'processing',
      'ready_for_pickup': 'processing',
      'out_for_delivery': 'processing',
      'in_transit': 'processing',
      'delivered': 'completed',
      'completed': 'completed',
      'cancelled': 'cancelled',
    };

    return statusMap[status] || 'pending';
  }

  /**
   * Upload file for staff (disputes, reports, etc.)
   * Uploads file to Supabase Storage and returns public URL
   */
  async uploadFileForStaff(staffId: string, file: Express.Multer.File): Promise<{
    url: string;
    fileData: {
      name: string;
      size: number;
      type: string;
      mimeType: string;
    };
  }> {
    this.logger.log(`Uploading file for staff: ${staffId}, file: ${file.originalname}`);

    // Validate file size (max 50MB)
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('File too large. Maximum size is 50MB');
    }

    try {
      // Generate unique filename
      const fileExtension = file.originalname.split('.').pop();
      const uniqueFileName = `admin/${staffId}/${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExtension}`;
      
      // Determine storage bucket based on file type
      const bucket = this.getStorageBucket(file.mimetype);
      
      // Upload file to Supabase Storage
      const { data: uploadData, error: uploadError } = await this.supabase.storage
        .from(bucket)
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error('File upload failed:', uploadError);
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      // Get public URL
      const { data: urlData } = this.supabase.storage
        .from(bucket)
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      this.logger.log(`File uploaded successfully: ${publicUrl}`);

      return {
        url: publicUrl,
        fileData: {
          name: file.originalname,
          size: file.size,
          type: this.getFileType(file.mimetype),
          mimeType: file.mimetype,
        },
      };
    } catch (error) {
      this.logger.error('Error uploading file:', error);
      throw error;
    }
  }

  /**
   * Upload multiple files for staff
   */
  async uploadMultipleFilesForStaff(staffId: string, files: Express.Multer.File[]): Promise<{
    files: Array<{
      url: string;
      fileData: {
        name: string;
        size: number;
        type: string;
        mimeType: string;
      };
    }>;
  }> {
    this.logger.log(`Uploading ${files.length} files for staff: ${staffId}`);

    const uploadPromises = files.map(file => this.uploadFileForStaff(staffId, file));

    try {
      const results = await Promise.all(uploadPromises);
      
      return {
        files: results,
      };
    } catch (error) {
      this.logger.error('Error uploading multiple files:', error);
      throw error;
    }
  }

  /**
   * Get storage bucket based on file MIME type
   */
  private getStorageBucket(mimeType: string): string {
    // Use 'media' bucket for all admin uploads (disputes, reports, etc.)
    return 'media';
  }

  /**
   * Get file type from MIME type
   */
  private getFileType(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.includes('pdf')) return 'document';
    if (mimeType.includes('word') || mimeType.includes('document')) return 'document';
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return 'document';
    if (mimeType.includes('text/')) return 'document';
    return 'file';
  }

  /**
   * Get all suspension appeals for staff review
   */
  async getAppealsForStaff(
    staffId: string,
    filters?: {
      status?: 'pending' | 'under_review' | 'approved' | 'rejected';
      page?: number;
      limit?: number;
    },
  ) {
    // Verify staff exists and is active
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('id, is_active, is_suspended, deleted_at')
      .eq('id', staffId)
      .single();

    if (!staff || !staff.is_active || staff.is_suspended || staff.deleted_at) {
      throw new UnauthorizedException('Staff access denied');
    }

    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from('suspension_appeals')
      .select(`
        id,
        user_id,
        suspension_reason,
        appeal_reason,
        status,
        reviewed_by,
        reviewed_at,
        review_notes,
        created_at,
        updated_at,
        user:user_profiles!user_id(
          id,
          username
        ),
        reviewed_by_staff:staff_accounts!reviewed_by(
          id,
          full_name,
          email
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters?.status) {
      query = query.eq('status', filters.status);
    }

    const { data: appeals, error, count } = await query;

    if (error) {
      this.logger.error(`Failed to fetch appeals: ${error.message}`);
      throw new Error(`Failed to fetch appeals: ${error.message}`);
    }

    // Map appeals to include proper user data structure
    const mappedAppeals = (appeals || []).map((appeal: any) => ({
      id: appeal.id,
      userId: appeal.user_id,
      suspensionReason: appeal.suspension_reason,
      appealReason: appeal.appeal_reason,
      status: appeal.status,
      reviewedBy: appeal.reviewed_by,
      reviewedAt: appeal.reviewed_at,
      reviewNotes: appeal.review_notes,
      createdAt: appeal.created_at,
      updatedAt: appeal.updated_at,
      user: appeal.user ? {
        id: appeal.user.id,
        username: appeal.user.username,
        email: '', // Email not available from user_profiles
        firstName: null, // first_name not in user_profiles table
        lastName: null, // last_name not in user_profiles table
      } : null,
      reviewedByStaff: appeal.reviewed_by_staff ? {
        id: appeal.reviewed_by_staff.id,
        fullName: appeal.reviewed_by_staff.full_name,
        email: appeal.reviewed_by_staff.email,
      } : null,
    }));

    return {
      appeals: mappedAppeals,
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Review a suspension appeal
   */
  async reviewAppeal(
    staffId: string,
    appealId: string,
    decision: 'approved' | 'rejected',
    notes?: string,
  ) {
    // Verify staff exists and is active
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('id, is_active, is_suspended, deleted_at')
      .eq('id', staffId)
      .single();

    if (!staff || !staff.is_active || staff.is_suspended || staff.deleted_at) {
      throw new UnauthorizedException('Staff access denied');
    }

    // Get appeal details
    const { data: appeal, error: appealError } = await this.supabase
      .from('suspension_appeals')
      .select('id, user_id, status')
      .eq('id', appealId)
      .single();

    if (appealError || !appeal) {
      throw new NotFoundException('Appeal not found');
    }

    if (appeal.status !== 'pending' && appeal.status !== 'under_review') {
      throw new BadRequestException('This appeal has already been reviewed');
    }

    // Update appeal
    const updateData: any = {
      status: decision === 'approved' ? 'approved' : 'rejected',
      reviewed_by: staffId,
      reviewed_at: new Date().toISOString(),
      review_notes: notes || null,
    };

    const { error: updateError } = await this.supabase
      .from('suspension_appeals')
      .update(updateData)
      .eq('id', appealId);

    if (updateError) {
      this.logger.error(`Failed to review appeal: ${updateError.message}`);
      throw new Error(`Failed to review appeal: ${updateError.message}`);
    }

    // Get user details for email
    let userEmail: string | null = null;
    let username: string | null = null;
    try {
      userEmail = await this.emailService.getUserEmail(appeal.user_id);
      // Get username from user_profiles
      const { data: userProfile } = await this.supabase
        .from('user_profiles')
        .select('username')
        .eq('id', appeal.user_id)
        .single();
      username = userProfile?.username || null;
    } catch (error) {
      this.logger.warn(`Failed to fetch user details for email: ${error.message}`);
    }

    // If approved, unsuspend the user
    if (decision === 'approved') {
      try {
        await this.activateUser(staffId, appeal.user_id);
        this.logger.log(`User ${appeal.user_id} unsuspended after appeal approval`);
        
        // Send email notification for approval
        if (userEmail) {
          try {
            await this.emailService.sendAppealApprovalEmail(appeal.user_id, username || undefined);
            this.logger.log(`Appeal approval email sent to ${userEmail}`);
          } catch (emailError) {
            this.logger.warn(`Failed to send appeal approval email: ${emailError.message}`);
            // Don't fail the appeal review if email fails
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to unsuspend user after appeal approval: ${error.message}`);
        // Don't fail the appeal review if unsuspension fails
      }
    } else {
      // Send email notification for rejection
      if (userEmail && username) {
        try {
          await this.emailService.sendAppealRejectionEmail(appeal.user_id, username, notes || undefined);
          this.logger.log(`Appeal rejection email sent to ${userEmail}`);
        } catch (emailError) {
          this.logger.warn(`Failed to send appeal rejection email: ${emailError.message}`);
          // Don't fail the appeal review if email fails
        }
      }
    }

    // Send in-app notification to user
    try {
      await this.notificationHelper.notifySystemUpdate(
        appeal.user_id,
        decision === 'approved' ? 'Appeal Approved' : 'Appeal Rejected',
        decision === 'approved'
          ? 'Your suspension appeal has been approved. Your account has been reactivated.'
          : `Your suspension appeal has been rejected. ${notes ? `Reason: ${notes}` : ''}`,
        {
          appeal_id: appealId,
          decision,
          review_notes: notes,
        },
      );
    } catch (notifError) {
      this.logger.warn(`Failed to send appeal notification: ${notifError.message}`);
    }

    // Log audit action
    try {
      await this.auditService.logAction({
        staffId,
        action: AuditAction.EDIT_USER,
        entityType: AuditEntityType.USER,
        entityId: appeal.user_id,
        details: {
          action: 'review_appeal',
          appealId,
          decision,
          notes,
        },
        status: AuditStatus.SUCCESS,
      });
    } catch (auditError) {
      this.logger.warn(`Failed to log audit action: ${auditError.message}`);
    }

    return {
      message: `Appeal ${decision} successfully`,
      appeal: {
        id: appealId,
        status: decision === 'approved' ? 'approved' : 'rejected',
      },
    };
  }
}

