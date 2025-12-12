import { IsNumber, IsOptional, IsString, IsEnum, Min, Max, IsUUID, IsBoolean } from 'class-validator';

export class WalletResponseDto {
  id: string;
  userId: string;
  availableBalance: number;
  escrowBalance: number;
  pendingWithdrawal: number;
  preferredCurrency: string;
  kycStatus: 'pending' | 'approved' | 'rejected';
  dailyDepositLimit: number;
  dailyWithdrawalLimit: number;
  createdAt: string;
  updatedAt: string;
  
  // Pending escrow balances (locked until release)
  pendingVendorEarnings?: number;
  pendingRiderEarnings?: number;
  totalPendingEarnings?: number;
  
  // Sales tracking (cumulative revenue)
  totalVendorSales?: number;
  totalRiderEarnings?: number;
  lifetimeRevenue?: number;
}

export class DepositRequestDto {
  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  fretiAmount?: number; // Estimated FRETI amount (optional if localAmount provided)

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  localAmount?: number; // Amount in user's local currency (required if fretiAmount not provided)

  @IsOptional()
  @IsString()
  localCurrency?: string; // Currency code (e.g., NGN, GHS, USD)

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class WithdrawRequestDto {
  @IsNumber()
  @Min(0.000001)
  fretiAmount: number;

  @IsUUID()
  bankAccountId: string;

  @IsOptional()
  @IsString()
  localCurrency?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class TransactionHistoryQueryDto {
  @IsOptional()
  @IsString()
  type?: string; // 'deposit', 'withdrawal', 'purchase', 'escrow', 'adjustment'

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsNumber()
  @Min(0)
  offset?: number = 0;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;
}

export class LedgerEntryDto {
  @IsUUID()
  walletId: string;

  @IsEnum(['deposit_mint', 'withdrawal_burn', 'purchase_hold', 'escrow_release', 
           'escrow_refund', 'admin_adjustment', 'fee_deduction', 'reward_credit'])
  transactionType: string;

  @IsNumber()
  availableDelta: number;

  @IsOptional()
  @IsNumber()
  escrowDelta?: number = 0;

  @IsOptional()
  @IsNumber()
  pendingWithdrawalDelta?: number = 0;

  @IsOptional()
  @IsString()
  referenceType?: string;

  @IsOptional()
  @IsUUID()
  referenceId?: string;

  @IsString()
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  metadata?: any;
}

export class PayoutRequestResponseDto {
  id: string;
  userId: string;
  fretiAmount: number;
  estimatedLocalAmount?: number;
  localCurrency: string;
  status: 'requested' | 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled';
  externalPayoutId?: string;
  requestedAt: string;
  processedAt?: string;
  paidAt?: string;
  failureReason?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

export class DepositResponseDto {
  id: string;
  userId: string;
  fretiAmount: number;
  localAmount: number;
  localCurrency: string;
  exchangeRate?: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  externalPaymentId?: string;
  paymentLink?: string; // Flutterwave payment link
  initiatedAt: string;
  completedAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export class WalletStatsDto {
  totalBalance: number; // available + escrow
  availableBalance: number;
  escrowBalance: number;
  pendingWithdrawal: number;
  localCurrencyEquivalent: {
    currency: string;
    available: number;
    total: number;
    escrow: number;
    pending: number;
  };
  recentTransactionCount: number;
  monthlySpending: number;
  monthlyDeposits: number;
  // Enhanced stats equivalent to user_wallet_summary view
  vendorTrustScore: number;
  riderTrustScore: number;
  buyerTrustScore: number;
  activeRiskFlags: number;
}

export class TrustScoreDto {
  vendorTrustScore: number;
  riderTrustScore: number;
  buyerTrustScore: number;
  completedOrders: number;
  successfulDeliveries: number;
  disputeCount: number;
  refundRate: number;
  kycVerified: boolean;
  phoneVerified: boolean;
  emailVerified: boolean;
}

export class EscrowBypassCheckDto {
  @IsUUID()
  vendorId: string;

  @IsOptional()
  @IsUUID()
  riderId?: string;

  @IsNumber()
  @Min(0.000001)
  orderAmount: number;

  @IsOptional()
  @IsString()
  category?: string;
}

export class EscrowBypassResponseDto {
  canBypass: boolean;
  reason: string;
  vendorTrusted: boolean;
  riderTrusted: boolean;
  buyerEligible: boolean;
  riskFlags: string[];
}