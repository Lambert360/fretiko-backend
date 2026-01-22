/**
 * Wallet Transaction Types Constants
 * 
 * These constants represent all valid transaction types for the wallet system.
 * They must match the CHECK constraint in the wallet_ledger table.
 * 
 * @see migrations/092_update_wallet_ledger_transaction_types.sql
 */

/**
 * Valid wallet transaction types as defined in the database schema
 */
export enum WalletTransactionType {
  // Credits to available balance
  DEPOSIT_MINT = 'deposit_mint',
  ESCROW_RELEASE = 'escrow_release',
  ESCROW_REFUND = 'escrow_refund',
  REWARD_CREDIT = 'reward_credit',
  ADMIN_ADJUSTMENT = 'admin_adjustment',
  DELIVERY_PAYMENT = 'delivery_payment',
  PLATFORM_COMMISSION = 'platform_commission',
  GIFT_CONVERSION = 'gift_conversion',

  // Debits from available balance
  WITHDRAWAL_BURN = 'withdrawal_burn',
  FEE_DEDUCTION = 'fee_deduction',
  GIFT_PURCHASE = 'gift_purchase',

  // Transfers between balance types
  PURCHASE_HOLD = 'purchase_hold', // available → escrow
  WITHDRAWAL_REQUEST = 'withdrawal_request', // available → pending
  ESCROW_RELEASE_TO_PLATFORM = 'escrow_release_to_platform', // escrow → platform
}

/**
 * Type guard to check if a string is a valid transaction type
 */
export function isValidTransactionType(type: string): type is WalletTransactionType {
  return Object.values(WalletTransactionType).includes(type as WalletTransactionType);
}

/**
 * Get all valid transaction types as an array
 */
export function getAllTransactionTypes(): string[] {
  return Object.values(WalletTransactionType);
}

/**
 * Transaction type descriptions for documentation/logging
 */
export const TRANSACTION_TYPE_DESCRIPTIONS: Record<WalletTransactionType, string> = {
  [WalletTransactionType.DEPOSIT_MINT]: 'User deposits funds (mints FRETI)',
  [WalletTransactionType.WITHDRAWAL_BURN]: 'User withdraws funds (burns FRETI)',
  [WalletTransactionType.PURCHASE_HOLD]: 'Funds moved to escrow for purchase',
  [WalletTransactionType.ESCROW_RELEASE]: 'Escrow funds released to vendor/rider',
  [WalletTransactionType.ESCROW_REFUND]: 'Escrow funds refunded to buyer',
  [WalletTransactionType.ADMIN_ADJUSTMENT]: 'Admin manual balance adjustment',
  [WalletTransactionType.FEE_DEDUCTION]: 'Fee deducted from available balance',
  [WalletTransactionType.REWARD_CREDIT]: 'Reward credited to available balance',
  [WalletTransactionType.DELIVERY_PAYMENT]: 'Delivery fee paid to rider',
  [WalletTransactionType.PLATFORM_COMMISSION]: 'Platform commission credited',
  [WalletTransactionType.GIFT_CONVERSION]: 'Gift converted to credits (80% to user)',
  [WalletTransactionType.WITHDRAWAL_REQUEST]: 'Funds moved to pending withdrawal',
  [WalletTransactionType.ESCROW_RELEASE_TO_PLATFORM]: 'Escrow released to platform',
  [WalletTransactionType.GIFT_PURCHASE]: 'Gift purchase (debit from user wallet)',
};

/**
 * Get description for a transaction type
 */
export function getTransactionTypeDescription(type: WalletTransactionType): string {
  return TRANSACTION_TYPE_DESCRIPTIONS[type] || 'Unknown transaction type';
}

