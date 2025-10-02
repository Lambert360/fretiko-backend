export interface Wallet {
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
}

export interface WalletLedger {
  id: string;
  walletId: string;
  userId: string;
  transactionType: 'deposit_mint' | 'withdrawal_burn' | 'purchase_hold' | 'escrow_release' | 
                   'escrow_refund' | 'admin_adjustment' | 'fee_deduction' | 'reward_credit';
  availableDelta: number;
  escrowDelta: number;
  pendingWithdrawalDelta: number;
  availableBalanceAfter: number;
  escrowBalanceAfter: number;
  pendingWithdrawalAfter: number;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  description?: string;
  metadata?: any;
  createdBy?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

export interface PayoutRequest {
  id: string;
  userId: string;
  fretiAmount: number;
  estimatedLocalAmount?: number;
  localCurrency: string;
  status: 'requested' | 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled';
  externalPayoutId?: string;
  webhookData?: any;
  requestedAt: string;
  processedAt?: string;
  paidAt?: string;
  failureReason?: string;
  retryCount: number;
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}

export interface Deposit {
  id: string;
  userId: string;
  fretiAmount: number;
  localAmount: number;
  localCurrency: string;
  exchangeRate?: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  externalPaymentId?: string;
  webhookData?: any;
  initiatedAt: string;
  completedAt?: string;
  failureReason?: string;
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}

export interface TrustScore {
  id: string;
  userId: string;
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
  lastCalculatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RiskFlag {
  id: string;
  userId: string;
  flagType: 'velocity_limit' | 'suspicious_activity' | 'chargebacks' | 
            'fraud_investigation' | 'manual_review' | 'account_freeze';
  flagReason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  isActive: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNotes?: string;
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}