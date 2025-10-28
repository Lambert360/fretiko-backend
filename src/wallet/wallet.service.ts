import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { randomUUID } from 'crypto';
import { 
  WalletResponseDto, 
  DepositRequestDto, 
  WithdrawRequestDto,
  TransactionHistoryQueryDto,
  LedgerEntryDto,
  WalletStatsDto,
  TrustScoreDto,
  EscrowBypassCheckDto,
  EscrowBypassResponseDto,
  PayoutRequestResponseDto,
  DepositResponseDto
} from './dto/wallet.dto';
import { Wallet, WalletLedger, PayoutRequest, Deposit, TrustScore, RiskFlag } from './entities/wallet.entity';

@Injectable()
export class WalletService {
  private supabase;
  
  // Constants
  private readonly FRETI_USD_RATE = 1.0; // 1 Freti = 1 USD (invariant)
  private readonly MIN_TRUST_SCORE = 750; // Minimum for escrow bypass
  private readonly HIGH_RISK_CATEGORIES = ['electronics', 'jewelry', 'cash'];
  private readonly AUTO_RELEASE_HOURS = 72; // Auto-release escrow after 72 hours

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  // ================================
  // WALLET OPERATIONS
  // ================================

  async getWallet(userId: string): Promise<WalletResponseDto> {
    console.log('🔍 Getting wallet for user ID:', userId);
    
    const { data, error } = await this.supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    console.log('💾 Supabase response:', { data, error });

    if (error) {
      console.error('❌ Wallet query error:', error);
      if (error.code === 'PGRST116') {
        // Wallet not found - create one automatically
        console.log('🔨 Wallet not found, creating new wallet for user:', userId);
        return await this.createWalletForUser(userId);
      }
      throw new Error(`Database error: ${error.message}`);
    }

    // ✅ QUERY PENDING ESCROW BALANCES (vendor/rider earnings)
    const pendingEscrows = await this.getPendingEscrowBalances(userId);

    const walletDto = this.mapWalletToDto(data);
    
    // Add pending escrow data to response
    return {
      ...walletDto,
      pendingVendorEarnings: pendingEscrows.vendorAmount,
      pendingRiderEarnings: pendingEscrows.riderAmount,
      totalPendingEarnings: pendingEscrows.totalPending,
    };
  }

  private async createWalletForUser(userId: string): Promise<WalletResponseDto> {
    const newWallet = {
      id: randomUUID(),
      user_id: userId,
      available_balance: 0.0,
      escrow_balance: 0.0,
      pending_withdrawal: 0.0,
      preferred_currency: 'USD',
      kyc_status: 'pending',
      daily_deposit_limit: 1000.0,
      daily_withdrawal_limit: 500.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('🏗️ Creating new wallet:', newWallet);

    const { data, error } = await this.supabase
      .from('wallets')
      .insert(newWallet)
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to create wallet:', error);
      throw new Error(`Failed to create wallet: ${error.message}`);
    }

    console.log('✅ Wallet created successfully:', data.id);
    return this.mapWalletToDto(data);
  }

  async getWalletStats(userId: string): Promise<WalletStatsDto> {
    console.log('📊 Getting wallet stats for user:', userId);
    
    // Get wallet and trust scores in parallel
    const [wallet, trustScore] = await Promise.all([
      this.getWallet(userId),
      this.getTrustScore(userId)
    ]);
    
    // Get transaction counts and amounts (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    const [
      { count: recentTransactionCount },
      { data: spendingData },
      { data: depositData },
      { count: activeRiskFlags }
    ] = await Promise.all([
      // Recent transaction count
      this.supabase
        .from('wallet_ledger')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo),
      
      // Monthly spending
      this.supabase
        .from('wallet_ledger')
        .select('available_delta')
        .eq('user_id', userId)
        .in('transaction_type', ['purchase_hold', 'fee_deduction'])
        .gte('created_at', thirtyDaysAgo),
      
      // Monthly deposits
      this.supabase
        .from('wallet_ledger')
        .select('available_delta')
        .eq('user_id', userId)
        .eq('transaction_type', 'deposit_mint')
        .gte('created_at', thirtyDaysAgo),
        
      // Active risk flags count
      this.supabase
        .from('risk_flags')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_active', true)
    ]);

    const monthlySpending = Math.abs(spendingData?.reduce((sum, tx) => sum + Math.abs(tx.available_delta), 0) || 0);
    const monthlyDeposits = depositData?.reduce((sum, tx) => sum + tx.available_delta, 0) || 0;
    const totalBalance = wallet.availableBalance + wallet.escrowBalance;

    console.log('📈 Wallet stats calculated:', {
      userId,
      totalBalance,
      monthlySpending,
      monthlyDeposits,
      recentTransactionCount,
      activeRiskFlags
    });

    return {
      totalBalance,
      availableBalance: wallet.availableBalance,
      escrowBalance: wallet.escrowBalance,
      pendingWithdrawal: wallet.pendingWithdrawal,
      localCurrencyEquivalent: {
        currency: wallet.preferredCurrency,
        available: wallet.availableBalance * this.FRETI_USD_RATE,
        total: totalBalance * this.FRETI_USD_RATE,
        escrow: wallet.escrowBalance * this.FRETI_USD_RATE,
        pending: wallet.pendingWithdrawal * this.FRETI_USD_RATE,
      },
      recentTransactionCount: recentTransactionCount || 0,
      monthlySpending,
      monthlyDeposits,
      // Enhanced stats from the view equivalent
      vendorTrustScore: trustScore.vendorTrustScore || 0,
      riderTrustScore: trustScore.riderTrustScore || 0,
      buyerTrustScore: trustScore.buyerTrustScore || 0,
      activeRiskFlags: activeRiskFlags || 0,
    };
  }

  // ================================
  // DEPOSIT OPERATIONS
  // ================================

  async createDepositRequest(userId: string, dto: DepositRequestDto): Promise<DepositResponseDto> {
    // Validate daily limits
    await this.validateDailyDepositLimit(userId, dto.fretiAmount);

    // Calculate local amount if not provided
    const localAmount = dto.localAmount || (dto.fretiAmount * this.FRETI_USD_RATE);
    const localCurrency = dto.localCurrency || 'USD';
    
    const depositId = randomUUID();
    const idempotencyKey = dto.idempotencyKey || `deposit_${userId}_${Date.now()}`;

    // Create deposit record
    const { data, error } = await this.supabase
      .from('deposits')
      .insert({
        id: depositId,
        user_id: userId,
        freti_amount: dto.fretiAmount,
        local_amount: localAmount,
        local_currency: localCurrency,
        exchange_rate: this.FRETI_USD_RATE,
        status: 'pending',
        metadata: {
          idempotency_key: idempotencyKey,
          created_from: 'app'
        }
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') { // Unique constraint violation
        throw new ConflictException('Duplicate deposit request');
      }
      throw new Error(`Failed to create deposit: ${error.message}`);
    }

    // TODO: Integrate with payment provider (Stripe, Paystack, etc.)
    // Payment integration placeholder - graceful handling
    console.log('⚠️  Payment Integration Pending:', {
      depositId: data.id,
      fretiAmount: data.freti_amount,
      localAmount: data.local_amount,
      localCurrency: data.local_currency,
      message: 'This deposit is pending payment provider integration. Status will remain "pending" until payment gateway is configured.'
    });

    // NOTE: When payment provider is integrated, the flow will be:
    // 1. Create payment session with provider (Stripe, Paystack, etc.)
    // 2. Return payment URL/redirect to frontend
    // 3. Handle webhook callbacks to update deposit status to 'completed'
    // 4. Update wallet balance via ledger entry on successful payment
    
    return this.mapDepositToDto(data);
  }

  async getDepositHistory(userId: string, params?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<DepositResponseDto[]> {
    let query = this.supabase
      .from('deposits')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Apply filters
    if (params?.status) {
      query = query.eq('status', params.status);
    }

    // Apply pagination
    const limit = params?.limit || 20;
    const offset = params?.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch deposit history: ${error.message}`);
    }

    return (data || []).map(d => this.mapDepositToDto(d));
  }

  // ================================
  // WITHDRAWAL OPERATIONS
  // ================================

  async createWithdrawRequest(userId: string, dto: WithdrawRequestDto): Promise<PayoutRequestResponseDto> {
    // Validate user has sufficient balance
    const wallet = await this.getWallet(userId);
    if (wallet.availableBalance < dto.fretiAmount) {
      throw new BadRequestException('Insufficient available balance');
    }

    // Validate daily limits
    await this.validateDailyWithdrawalLimit(userId, dto.fretiAmount);

    const payoutId = randomUUID();
    const localCurrency = dto.localCurrency || wallet.preferredCurrency;
    const estimatedLocalAmount = dto.fretiAmount * this.FRETI_USD_RATE;
    const idempotencyKey = dto.idempotencyKey || `withdraw_${userId}_${Date.now()}`;

    // Move funds from available to pending withdrawal
    await this.createLedgerEntry({
      walletId: wallet.id,
      transactionType: 'withdrawal_burn',
      availableDelta: -dto.fretiAmount,
      escrowDelta: 0,
      pendingWithdrawalDelta: dto.fretiAmount,
      referenceType: 'payout_request',
      referenceId: payoutId,
      idempotencyKey: `${idempotencyKey}_hold`,
      description: 'Withdrawal request - funds held pending'
    }, userId);

    // Create payout request
    const { data, error } = await this.supabase
      .from('payout_requests')
      .insert({
        id: payoutId,
        user_id: userId,
        freti_amount: dto.fretiAmount,
        estimated_local_amount: estimatedLocalAmount,
        local_currency: localCurrency,
        status: 'requested',
        metadata: {
          idempotency_key: idempotencyKey,
          created_from: 'app'
        }
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create payout request: ${error.message}`);
    }

    // TODO: Integrate with payment provider for payout
    // Payout integration placeholder - graceful handling
    console.log('⚠️  Payout Integration Pending:', {
      payoutId: data.id,
      fretiAmount: data.freti_amount,
      estimatedLocalAmount: estimatedLocalAmount,
      localCurrency: localCurrency,
      message: 'This withdrawal is pending payment provider integration. Funds are held in pending_withdrawal. Payout will be processed once payment gateway is configured.'
    });

    // NOTE: When payment provider is integrated, the flow will be:
    // 1. Create payout request with provider (Stripe, Paystack, etc.)
    // 2. Provider processes payout to user's bank account
    // 3. Handle webhook callbacks to update payout status to 'paid'
    // 4. Move funds from pending_withdrawal via ledger entry on successful payout
    // 5. For failures, refund from pending_withdrawal to available_balance

    return this.mapPayoutToDto(data);
  }

  async getPayoutHistory(userId: string, params?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<PayoutRequestResponseDto[]> {
    let query = this.supabase
      .from('payout_requests')
      .select('*')
      .eq('user_id', userId)
      .order('requested_at', { ascending: false });

    // Apply filters
    if (params?.status) {
      query = query.eq('status', params.status);
    }

    // Apply pagination
    const limit = params?.limit || 20;
    const offset = params?.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch payout history: ${error.message}`);
    }

    return (data || []).map(p => this.mapPayoutToDto(p));
  }

  // ================================
  // TRANSACTION HISTORY (removed - see new implementation below in sales section)
  // ================================

  // ================================
  // ESCROW OPERATIONS
  // ================================

  async checkEscrowBypass(buyerId: string, dto: EscrowBypassCheckDto): Promise<EscrowBypassResponseDto> {
    // Get trust scores
    const [buyerTrust, vendorTrust, riderTrust] = await Promise.all([
      this.getTrustScore(buyerId),
      this.getTrustScore(dto.vendorId),
      dto.riderId ? this.getTrustScore(dto.riderId) : null
    ]);

    // Check risk flags
    const riskFlags = await this.getActiveRiskFlags(buyerId);

    // Evaluate bypass eligibility
    const vendorTrusted = vendorTrust.vendorTrustScore >= this.MIN_TRUST_SCORE;
    const riderTrusted = !dto.riderId || (riderTrust !== null && riderTrust.riderTrustScore >= this.MIN_TRUST_SCORE);
    const buyerEligible = buyerTrust.buyerTrustScore >= 500 && riskFlags.length === 0;
    const categoryAllowed = !dto.category || !this.HIGH_RISK_CATEGORIES.includes(dto.category.toLowerCase());
    
    const canBypass = vendorTrusted && riderTrusted && buyerEligible && categoryAllowed;
    
    let reason = '';
    if (!vendorTrusted) reason += 'Vendor trust score too low. ';
    if (!riderTrusted) reason += 'Rider trust score too low. ';
    if (!buyerEligible) reason += 'Buyer not eligible or has active risk flags. ';
    if (!categoryAllowed) reason += 'High-risk category requires escrow. ';
    if (canBypass) reason = 'All requirements met for escrow bypass.';

    return {
      canBypass,
      reason: reason.trim(),
      vendorTrusted,
      riderTrusted,
      buyerEligible,
      riskFlags: riskFlags.map(flag => flag.flagType)
    };
  }

  async getRemainingDailyLimits(userId: string): Promise<{
    dailyDepositLimit: number;
    dailyWithdrawalLimit: number;
    remainingDepositLimit: number;
    remainingWithdrawalLimit: number;
    kycStatus: string;
  }> {
    const wallet = await this.getWallet(userId);
    const today = new Date().toISOString().split('T')[0];

    // Calculate deposits made today
    const { data: depositsToday } = await this.supabase
      .from('deposits')
      .select('freti_amount')
      .eq('user_id', userId)
      .gte('created_at', `${today}T00:00:00Z`)
      .lt('created_at', `${today}T23:59:59Z`);

    const dailyDepositUsed = depositsToday?.reduce((sum, d) => sum + parseFloat(d.freti_amount), 0) || 0;

    // Calculate withdrawals made today
    const { data: withdrawalsToday } = await this.supabase
      .from('payout_requests')
      .select('freti_amount')
      .eq('user_id', userId)
      .gte('requested_at', `${today}T00:00:00Z`)
      .lt('requested_at', `${today}T23:59:59Z`);

    const dailyWithdrawalUsed = withdrawalsToday?.reduce((sum, w) => sum + parseFloat(w.freti_amount), 0) || 0;

    const remainingDepositLimit = Math.max(0, wallet.dailyDepositLimit - dailyDepositUsed);
    const remainingWithdrawalLimit = Math.max(0, wallet.dailyWithdrawalLimit - dailyWithdrawalUsed);

    console.log('📊 Daily limits calculated:', {
      userId,
      depositLimit: wallet.dailyDepositLimit,
      depositUsed: dailyDepositUsed,
      depositRemaining: remainingDepositLimit,
      withdrawalLimit: wallet.dailyWithdrawalLimit,
      withdrawalUsed: dailyWithdrawalUsed,
      withdrawalRemaining: remainingWithdrawalLimit,
    });

    return {
      dailyDepositLimit: wallet.dailyDepositLimit,
      dailyWithdrawalLimit: wallet.dailyWithdrawalLimit,
      remainingDepositLimit,
      remainingWithdrawalLimit,
      kycStatus: wallet.kycStatus,
    };
  }

  // ================================
  // PRIVATE HELPER METHODS
  // ================================

  private async createLedgerEntry(entry: LedgerEntryDto, userId: string): Promise<void> {
    // Get current wallet balances for after-balance calculation
    const wallet = await this.getWallet(userId);
    
    const ledgerEntry = {
      wallet_id: entry.walletId,
      user_id: userId,
      transaction_type: entry.transactionType,
      available_delta: entry.availableDelta,
      escrow_delta: entry.escrowDelta || 0,
      pending_withdrawal_delta: entry.pendingWithdrawalDelta || 0,
      available_balance_after: wallet.availableBalance + entry.availableDelta,
      escrow_balance_after: wallet.escrowBalance + (entry.escrowDelta || 0),
      pending_withdrawal_after: wallet.pendingWithdrawal + (entry.pendingWithdrawalDelta || 0),
      reference_type: entry.referenceType,
      reference_id: entry.referenceId,
      idempotency_key: entry.idempotencyKey,
      description: entry.description,
      metadata: entry.metadata || {},
      created_by: userId
    };

    const { error } = await this.supabase
      .from('wallet_ledger')
      .insert(ledgerEntry);

    if (error) {
      if (error.code === '23505') { // Unique constraint violation
        throw new ConflictException('Duplicate transaction');
      }
      throw new Error(`Failed to create ledger entry: ${error.message}`);
    }
  }

  private async validateDailyDepositLimit(userId: string, amount: number): Promise<void> {
    const wallet = await this.getWallet(userId);
    const today = new Date().toISOString().split('T')[0];
    
    const { data } = await this.supabase
      .from('wallet_ledger')
      .select('available_delta')
      .eq('user_id', userId)
      .eq('transaction_type', 'deposit_mint')
      .gte('created_at', `${today}T00:00:00Z`)
      .lt('created_at', `${today}T23:59:59Z`);

    const dailyDeposited = data?.reduce((sum, tx) => sum + tx.available_delta, 0) || 0;
    
    if (dailyDeposited + amount > wallet.dailyDepositLimit) {
      throw new BadRequestException(`Daily deposit limit exceeded. Limit: ₣${wallet.dailyDepositLimit}`);
    }
  }

  private async validateDailyWithdrawalLimit(userId: string, amount: number): Promise<void> {
    const wallet = await this.getWallet(userId);
    const today = new Date().toISOString().split('T')[0];
    
    const { data } = await this.supabase
      .from('payout_requests')
      .select('freti_amount')
      .eq('user_id', userId)
      .gte('requested_at', `${today}T00:00:00Z`)
      .lt('requested_at', `${today}T23:59:59Z`);

    const dailyWithdrawn = data?.reduce((sum, payout) => sum + payout.freti_amount, 0) || 0;
    
    if (dailyWithdrawn + amount > wallet.dailyWithdrawalLimit) {
      throw new BadRequestException(`Daily withdrawal limit exceeded. Limit: ₣${wallet.dailyWithdrawalLimit}`);
    }
  }

  private async getTrustScore(userId: string): Promise<TrustScore> {
    const { data, error } = await this.supabase
      .from('trust_scores')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      // Return default trust score if not found
      return {
        id: '',
        userId,
        vendorTrustScore: 0,
        riderTrustScore: 0,
        buyerTrustScore: 0,
        completedOrders: 0,
        successfulDeliveries: 0,
        disputeCount: 0,
        refundRate: 0,
        kycVerified: false,
        phoneVerified: false,
        emailVerified: false,
        lastCalculatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }

    return data;
  }

  private async getActiveRiskFlags(userId: string): Promise<RiskFlag[]> {
    const { data, error } = await this.supabase
      .from('risk_flags')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error) {
      throw new Error(`Failed to fetch risk flags: ${error.message}`);
    }

    return data || [];
  }

  // ================================
  // ESCROW BALANCE QUERY
  // ================================

  /**
   * Get pending escrow balances for a user (as vendor or rider)
   * These amounts are "locked" until escrow is released
   */
  async getPendingEscrowBalances(userId: string): Promise<{
    vendorAmount: number;
    riderAmount: number;
    totalPending: number;
  }> {
    try {
      // Use JOIN to get vendor earnings from escrows
      const { data: vendorEscrows, error: vendorError } = await this.supabase
        .from('escrows')
        .select('vendor_amount, orders!inner(vendor_id)')
        .eq('status', 'held')
        .eq('orders.vendor_id', userId);

      if (vendorError) {
        console.error('Error fetching vendor escrows:', vendorError);
      }

      // Use JOIN to get rider earnings from escrows
      const { data: riderEscrows, error: riderError } = await this.supabase
        .from('escrows')
        .select('rider_amount, orders!inner(rider_id)')
        .eq('status', 'held')
        .eq('orders.rider_id', userId);

      if (riderError) {
        console.error('Error fetching rider escrows:', riderError);
      }

      const vendorAmount = vendorEscrows?.reduce((sum, e) => sum + parseFloat(e.vendor_amount || '0'), 0) || 0;
      const riderAmount = riderEscrows?.reduce((sum, e) => sum + parseFloat(e.rider_amount || '0'), 0) || 0;

      console.log(`💰 Pending escrows for user ${userId}: Vendor ₣${vendorAmount}, Rider ₣${riderAmount}`);

      return {
        vendorAmount,
        riderAmount,
        totalPending: vendorAmount + riderAmount,
      };
    } catch (error) {
      console.error('Failed to query pending escrows (non-critical):', error);
      return {
        vendorAmount: 0,
        riderAmount: 0,
        totalPending: 0,
      };
    }
  }

  // ================================
  // MAPPING FUNCTIONS
  // ================================

  private mapWalletToDto(data: any): WalletResponseDto {
    return {
      id: data.id,
      userId: data.user_id,
      availableBalance: parseFloat(data.available_balance),
      escrowBalance: parseFloat(data.escrow_balance),
      pendingWithdrawal: parseFloat(data.pending_withdrawal),
      preferredCurrency: data.preferred_currency,
      kycStatus: data.kyc_status,
      dailyDepositLimit: parseFloat(data.daily_deposit_limit),
      dailyWithdrawalLimit: parseFloat(data.daily_withdrawal_limit),
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      // Sales tracking
      totalVendorSales: data.total_vendor_sales ? parseFloat(data.total_vendor_sales) : 0,
      totalRiderEarnings: data.total_rider_earnings ? parseFloat(data.total_rider_earnings) : 0,
      lifetimeRevenue: data.lifetime_revenue ? parseFloat(data.lifetime_revenue) : 0,
    };
  }

  private mapDepositToDto(data: any): DepositResponseDto {
    return {
      id: data.id,
      userId: data.user_id,
      fretiAmount: parseFloat(data.freti_amount),
      localAmount: parseFloat(data.local_amount),
      localCurrency: data.local_currency,
      exchangeRate: data.exchange_rate ? parseFloat(data.exchange_rate) : undefined,
      status: data.status,
      externalPaymentId: data.external_payment_id,
      initiatedAt: data.initiated_at,
      completedAt: data.completed_at,
      failureReason: data.failure_reason,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  private mapPayoutToDto(data: any): PayoutRequestResponseDto {
    return {
      id: data.id,
      userId: data.user_id,
      fretiAmount: parseFloat(data.freti_amount),
      estimatedLocalAmount: data.estimated_local_amount ? parseFloat(data.estimated_local_amount) : undefined,
      localCurrency: data.local_currency,
      status: data.status,
      externalPayoutId: data.external_payout_id,
      requestedAt: data.requested_at,
      processedAt: data.processed_at,
      paidAt: data.paid_at,
      failureReason: data.failure_reason,
      retryCount: data.retry_count,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  // ================================
  // SALES TRACKING & ANALYTICS
  // ================================

  /**
   * Get sales history for a user
   * Returns individual sales/earnings transactions
   */
  async getSalesHistory(
    userId: string,
    type?: 'vendor_sale' | 'rider_delivery',
    limit: number = 50,
    offset: number = 0,
    startDate?: string,
    endDate?: string,
  ) {
    try {
      let query = this.supabase
        .from('sales_ledger')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      // Filter by transaction type if specified
      if (type) {
        query = query.eq('transaction_type', type);
      }

      // Filter by date range if specified
      if (startDate) {
        query = query.gte('created_at', startDate);
      }
      if (endDate) {
        query = query.lte('created_at', endDate);
      }

      // Pagination
      query = query.range(offset, offset + limit - 1);

      const { data, error, count } = await query;

      if (error) {
        console.error('Error fetching sales history:', error);
        throw error;
      }

      // Get order details for each sale
      const salesWithDetails = await Promise.all(
        (data || []).map(async (sale) => {
          let orderDetails: any = null;
          if (sale.order_id) {
            const { data: order } = await this.supabase
              .from('orders')
              .select('order_number, buyer_id, created_at')
              .eq('id', sale.order_id)
              .single();
            orderDetails = order;
          }

          return {
            id: sale.id,
            transactionType: sale.transaction_type,
            amount: parseFloat(sale.amount),
            orderId: sale.order_id,
            orderNumber: orderDetails?.order_number || null,
            vendorSalesAfter: sale.vendor_sales_after ? parseFloat(sale.vendor_sales_after) : 0,
            riderEarningsAfter: sale.rider_earnings_after ? parseFloat(sale.rider_earnings_after) : 0,
            lifetimeRevenueAfter: sale.lifetime_revenue_after ? parseFloat(sale.lifetime_revenue_after) : 0,
            description: sale.description,
            createdAt: sale.created_at,
          };
        })
      );

      return {
        sales: salesWithDetails,
        total: count || salesWithDetails.length,
        limit,
        offset,
      };
    } catch (error) {
      console.error('Error in getSalesHistory:', error);
      throw error;
    }
  }

  /**
   * Get sales analytics (aggregated data for charts/dashboards)
   */
  /**
   * Get wallet transaction history (ledger entries)
   */
  async getTransactionHistory(
    userId: string,
    type?: string,
    limit: number = 50,
    offset: number = 0,
    startDate?: string,
    endDate?: string,
  ) {
    try {
      console.log('🔍 [DEBUG] getTransactionHistory called:', { userId, type, limit, offset });
      
      // Query by user_id instead of wallet_id to catch all transactions
      // (some old transactions may have wallet_id = null due to a previous bug)
      let query = this.supabase
        .from('wallet_ledger')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      // Filter by transaction type if specified
      if (type) {
        console.log(`🔍 [DEBUG] Filtering by transaction type: ${type}`);
        query = query.eq('transaction_type', type);
      }

      // Filter by date range if specified
      if (startDate) {
        query = query.gte('created_at', startDate);
      }
      if (endDate) {
        query = query.lte('created_at', endDate);
      }

      // Pagination
      query = query.range(offset, offset + limit - 1);

      const { data, error } = await query;

      if (error) {
        console.error('❌ [DEBUG] Error fetching transaction history:', error);
        throw error;
      }

      console.log(`✅ [DEBUG] Found ${data?.length || 0} transactions for user ${userId}${type ? ` (type: ${type})` : ''}`);
      if (data && data.length > 0) {
        console.log('📋 [DEBUG] Sample transaction:', {
          id: data[0].id,
          transaction_type: data[0].transaction_type,
          wallet_id: data[0].wallet_id,
          user_id: data[0].user_id,
          created_at: data[0].created_at
        });
      }

      // Map to frontend format
      return (data || []).map((entry) => ({
        id: entry.id,
        walletId: entry.wallet_id,
        userId: entry.user_id,
        transactionType: entry.transaction_type,
        availableDelta: parseFloat(entry.available_delta),
        escrowDelta: parseFloat(entry.escrow_delta),
        pendingWithdrawalDelta: parseFloat(entry.pending_withdrawal_delta),
        availableBalanceAfter: parseFloat(entry.available_balance_after),
        escrowBalanceAfter: parseFloat(entry.escrow_balance_after),
        pendingWithdrawalAfter: parseFloat(entry.pending_withdrawal_after),
        referenceType: entry.reference_type,
        referenceId: entry.reference_id,
        description: entry.description,
        metadata: entry.metadata,
        createdAt: entry.created_at,
      }));
    } catch (error) {
      console.error('Error in getTransactionHistory:', error);
      throw error;
    }
  }

  async getSalesAnalytics(
    userId: string,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly' = 'daily',
    startDate?: string,
    endDate?: string,
  ) {
    try {
      // Set default date range if not provided
      const end = endDate ? new Date(endDate) : new Date();
      let start: Date;
      
      switch (period) {
        case 'daily':
          start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last 30 days
          break;
        case 'weekly':
          start = startDate ? new Date(startDate) : new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000); // Last 12 weeks
          break;
        case 'monthly':
          start = startDate ? new Date(startDate) : new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000); // Last 12 months
          break;
        case 'yearly':
          start = startDate ? new Date(startDate) : new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000); // Last 5 years
          break;
      }

      // Fetch all sales in the date range
      const { data: sales, error } = await this.supabase
        .from('sales_ledger')
        .select('*')
        .eq('user_id', userId)
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Error fetching sales for analytics:', error);
        throw error;
      }

      // Aggregate data by period
      const grouped = new Map<string, { vendorSales: number; riderEarnings: number; total: number; count: number }>();

      (sales || []).forEach((sale) => {
        const date = new Date(sale.created_at);
        let key: string;

        switch (period) {
          case 'daily':
            key = date.toISOString().split('T')[0]; // YYYY-MM-DD
            break;
          case 'weekly':
            const weekStart = new Date(date);
            weekStart.setDate(date.getDate() - date.getDay());
            key = weekStart.toISOString().split('T')[0];
            break;
          case 'monthly':
            key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM
            break;
          case 'yearly':
            key = String(date.getFullYear()); // YYYY
            break;
        }

        if (!grouped.has(key)) {
          grouped.set(key, { vendorSales: 0, riderEarnings: 0, total: 0, count: 0 });
        }

        const group = grouped.get(key)!;
        const amount = parseFloat(sale.amount);
        
        if (sale.transaction_type === 'vendor_sale') {
          group.vendorSales += amount;
        } else if (sale.transaction_type === 'rider_delivery') {
          group.riderEarnings += amount;
        }
        
        group.total += amount;
        group.count += 1;
      });

      // Convert to array and sort
      const chartData = Array.from(grouped.entries()).map(([period, data]) => ({
        period,
        vendorSales: data.vendorSales,
        riderEarnings: data.riderEarnings,
        totalRevenue: data.total,
        transactionCount: data.count,
      }));

      // Calculate summary statistics
      const totalVendorSales = chartData.reduce((sum, d) => sum + d.vendorSales, 0);
      const totalRiderEarnings = chartData.reduce((sum, d) => sum + d.riderEarnings, 0);
      const totalRevenue = totalVendorSales + totalRiderEarnings;
      const totalTransactions = chartData.reduce((sum, d) => sum + d.transactionCount, 0);

      return {
        summary: {
          totalVendorSales,
          totalRiderEarnings,
          totalRevenue,
          totalTransactions,
          averagePerTransaction: totalTransactions > 0 ? totalRevenue / totalTransactions : 0,
          period,
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        },
        chartData,
      };
    } catch (error) {
      console.error('Error in getSalesAnalytics:', error);
      throw error;
    }
  }
}