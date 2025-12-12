# Wallet Limits Documentation

## Daily Deposit Limit Calculation

### Overview
Daily deposit limits are calculated based on **completed deposits only** (not pending or failed). This ensures accurate tracking of actual funds deposited.

### Implementation
- **Location**: `wallet.service.ts` - `validateDailyDepositLimit()` method
- **Data Source**: `wallet_ledger` table with `transaction_type = 'deposit_mint'`
- **Time Window**: Current day (00:00:00 UTC to 23:59:59 UTC)
- **Calculation**: Sum of all `available_delta` values for deposit_mint transactions on the current day

### Important Notes
1. Only **completed** deposits count toward daily limits (deposits that have been minted to wallet)
2. **Pending** or **failed** deposits do not count
3. Limits are checked **before** deposit creation (using estimated amount)
4. Daily limit resets at midnight UTC
5. The limit is per-user and stored in `wallets.daily_deposit_limit` (default: ₣10,000)

### Example
```typescript
// User has deposited ₣5,000 today
// Current daily limit: ₣10,000
// User attempts to deposit ₣6,000
// Result: ❌ Rejected (₣5,000 + ₣6,000 = ₣11,000 > ₣10,000)
```

---

## Daily Withdrawal Limit Calculation

### Overview
Daily withdrawal limits are calculated based on **requested withdrawals** (not just completed). This ensures users cannot request more than their limit, even if some requests are pending or fail.

### Implementation
- **Location**: `wallet.service.ts` - `validateDailyWithdrawalLimit()` method
- **Data Source**: `payout_requests` table
- **Time Window**: Current day (00:00:00 UTC to 23:59:59 UTC)
- **Calculation**: Sum of all `freti_amount` values for payout requests on the current day

### Important Notes
1. All **requested** withdrawals count toward daily limits (including pending, processing, paid, and failed)
2. This prevents users from creating multiple withdrawal requests exceeding their limit
3. Limits are checked **before** withdrawal request creation
4. Daily limit resets at midnight UTC
5. The limit is per-user and stored in `wallets.daily_withdrawal_limit` (default: ₣500)

### Example
```typescript
// User has requested withdrawals totaling ₣400 today
// Current daily limit: ₣500
// User attempts to withdraw ₣200
// Result: ❌ Rejected (₣400 + ₣200 = ₣600 > ₣500)
```

---

## Key Differences

| Aspect | Deposit Limits | Withdrawal Limits |
|--------|---------------|-------------------|
| **Data Source** | `wallet_ledger` (completed) | `payout_requests` (requested) |
| **Counts** | Only successful deposits | All withdrawal requests |
| **Why** | Track actual funds received | Prevent request spam |
| **Reset** | Midnight UTC | Midnight UTC |

---

## Admin Notes

- Limits can be adjusted per user in the `wallets` table
- Both limits are enforced at the API level before processing
- Failed transactions don't count toward deposit limits (only successful mints)
- Failed withdrawal requests still count toward withdrawal limits (prevents abuse)

