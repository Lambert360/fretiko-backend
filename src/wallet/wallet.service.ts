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

    return this.mapWalletToDto(data);
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
    // For now, return the pending deposit
    
    return this.mapDepositToDto(data);
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
    // For now, return the requested payout

    return this.mapPayoutToDto(data);
  }

  // ================================
  // TRANSACTION HISTORY
  // ================================

  async getTransactionHistory(userId: string, query: TransactionHistoryQueryDto): Promise<WalletLedger[]> {
    let dbQuery = this.supabase
      .from('wallet_ledger')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(query.offset || 0, (query.offset || 0) + (query.limit || 20) - 1);

    // Apply filters
    if (query.type) {
      const typeMap = {
        'deposit': ['deposit_mint'],
        'withdrawal': ['withdrawal_burn'],
        'purchase': ['purchase_hold'],
        'escrow': ['escrow_release', 'escrow_refund'],
        'adjustment': ['admin_adjustment', 'fee_deduction', 'reward_credit']
      };
      
      if (typeMap[query.type]) {
        dbQuery = dbQuery.in('transaction_type', typeMap[query.type]);
      }
    }

    if (query.startDate) {
      dbQuery = dbQuery.gte('created_at', query.startDate);
    }

    if (query.endDate) {
      dbQuery = dbQuery.lte('created_at', query.endDate);
    }

    const { data, error } = await dbQuery;

    if (error) {
      throw new Error(`Failed to fetch transaction history: ${error.message}`);
    }

    return data || [];
  }

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

  // Mapping functions
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
}