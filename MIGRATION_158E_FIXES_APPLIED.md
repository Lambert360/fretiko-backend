# Migration 158e - Critical Fixes Applied

## Date: 2026-01-28

## Problem Summary
Migration 158e was missing critical advisory lock protection from migrations 150-155, causing:
- ❌ **Double charges** - Race conditions allowed concurrent duplicate transactions
- ❌ **Missing transaction types** - `gift_purchase`, `gift_conversion`, `escrow_release_to_platform` not supported
- ❌ **Incomplete balance validation** - `gift_purchase` not included in debit validation

## Root Cause Analysis
Migration 158e was built from scratch instead of modifying migration 155, losing:
1. Advisory lock protection (`pg_advisory_xact_lock`)
2. Missing transaction type support
3. Proper idempotency with locks held

## Fixes Applied to Migration 158e

### 1. ✅ Advisory Lock Protection (CRITICAL - Prevents Double Charges)
```sql
-- Added variable declaration (line 52)
v_lock_key BIGINT; -- Advisory lock key for preventing concurrent duplicate processing

-- Added advisory lock acquisition (lines 71-78)
IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
  v_lock_key := abs(hashtext(p_user_id::TEXT || p_transaction_type || p_reference_type || p_reference_id));
  PERFORM pg_advisory_xact_lock(v_lock_key);
END IF;
```

**How it works:**
- Generates unique lock key from transaction parameters
- Blocks concurrent requests with same reference
- Prevents race condition where two requests both pass idempotency check
- Lock releases automatically on commit/rollback

### 2. ✅ Added Missing Transaction Types

#### `gift_purchase` (line 153)
```sql
WHEN 'withdrawal_burn', 'fee_deduction', 'gift_purchase' THEN
  v_available_delta := -p_amount;
  v_escrow_delta := 0;
  v_pending_delta := 0;
  v_new_available := v_current_available - p_amount;
  v_new_escrow := v_current_escrow;
  v_new_pending := v_current_pending;
```

#### `gift_conversion` (line 161)
```sql
WHEN 'gift_conversion' THEN
  v_available_delta := p_amount;
  v_escrow_delta := 0;
  v_pending_delta := 0;
  v_new_available := v_current_available + p_amount;
  v_new_escrow := v_current_escrow;
  v_new_pending := v_current_pending;
```

#### `escrow_release_to_platform` (line 185)
```sql
WHEN 'escrow_release_to_platform' THEN
  v_available_delta := 0;
  v_escrow_delta := -p_amount;
  v_pending_delta := 0;
  v_new_available := v_current_available;
  v_new_escrow := v_current_escrow - p_amount;
  v_new_pending := v_current_pending;
```

### 3. ✅ Updated Balance Validation (line 200)
```sql
IF p_transaction_type IN ('purchase_hold', 'withdrawal_burn', 'fee_deduction', 'gift_purchase', 'withdrawal_request') THEN
  IF v_current_available < ABS(v_available_delta) THEN
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                   'Insufficient available balance'::TEXT;
    RETURN;
  END IF;
END IF;
```

## What Was Already Working in 158e
- ✅ Correct wallet_ledger column names (`available_delta`, `escrow_delta`, `pending_withdrawal_delta`)
- ✅ UUID casting in idempotency check (`p_reference_id::UUID`)
- ✅ All delta variables initialized for all transaction types
- ✅ Row-level locking (`FOR UPDATE`)
- ✅ `RETURNS TABLE` format (compatible with current backend)

## Testing Required

### 1. Test Order Purchase & Cancel (Double Charge Check)
```bash
# Make two rapid concurrent order purchases with same order ID
# Expected: Only one transaction should succeed, second should be idempotent
# Before fix: Both would succeed, causing double charge
```

### 2. Test Gift Purchase
```bash
# Purchase gifts using wallet balance
# Expected: Transaction succeeds, balance debited correctly
# Before fix: "Unknown transaction type: gift_purchase" error
```

### 3. Test Order Refund
```bash
# Cancel order and verify refund
# Expected: Escrow refunded to available balance
# Before fix: Already working, should continue to work
```

## Deployment Steps

1. **Apply migration 158e in Supabase SQL Editor**
   ```sql
   -- Copy entire contents of 158e_fix_with_correct_columns.sql
   -- Paste and execute in Supabase SQL Editor
   ```

2. **Verify function updated**
   ```sql
   SELECT routine_name, routine_definition 
   FROM information_schema.routines 
   WHERE routine_name = 'process_wallet_transaction';
   ```

3. **Restart backend server**
   ```bash
   npm run start:dev
   ```

4. **Test all transaction types**
   - Order purchase (PURCHASE_HOLD)
   - Order cancel (ESCROW_REFUND)
   - Gift purchase (GIFT_PURCHASE)
   - Concurrent requests (verify no double charges)

## Migration History Context

| Migration | Status | Key Features |
|-----------|--------|--------------|
| 150 | ✅ Working | Advisory locks, all transaction types, JSONB return |
| 152 | ✅ Working | Same as 150, fixed platform_commission |
| 155 | ✅ Working | Same as 150, fixed sales_ledger constraint |
| 158e (old) | ❌ Broken | Missing advisory locks, missing transaction types |
| **158e (new)** | ✅ **Fixed** | **Advisory locks + correct columns + all types** |

## Key Takeaway
**Always modify the latest working migration (155) rather than building from scratch.** This preserves critical features like advisory lock protection that prevent race conditions and double charges.
