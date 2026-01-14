# Migration 126: Consolidated Wallet Transaction with UUID Fix

## Purpose
This migration consolidates all previous `process_wallet_transaction` function migrations and fixes the critical UUID casting bug that was causing errors: `column "reference_id" is of type uuid but expression is of type text`

## What This Migration Includes

### ✅ All Features (Consolidated)
1. **Basic wallet transactions** (from `create-process-wallet-transaction-rpc.sql`)
   - deposit_mint, withdrawal_burn, purchase_hold, escrow_release, etc.

2. **Vendor sale tracking** (from `add-vendor-sale-transaction-type.sql`)
   - `vendor_sale` transaction type support

3. **Sales tracking** (from `add-sales-tracking.sql`)
   - `sales_ledger` table integration
   - Tracks vendor sales and rider earnings separately
   - `total_vendor_sales`, `total_rider_earnings`, `lifetime_revenue` columns

4. **Platform commission** (from `add-platform-commission-transaction-type.sql`)
   - `platform_commission` transaction type support

### 🔥 Critical Fixes

#### 1. UUID Casting Fix (from `fix-process-wallet-transaction-uuid-cast.sql`)
**Problem:**
- Previous migrations passed `p_reference_id` (TEXT) directly to UUID columns
- This caused: `column "reference_id" is of type uuid but expression is of type text`
- Some migrations used conditional casts that didn't handle NULL properly

**Solution:**
- Uses DECLARE variables (`v_reference_id_uuid`, `v_order_id_uuid`, `v_escrow_id_uuid`)
- Checks for NULL and empty strings BEFORE casting
- Wraps casting in exception handler to catch invalid UUID formats
- Uses pre-casted variables in INSERT statements

#### 2. Fixed INSERT Statements
**Before (BUGGY):**
```sql
-- wallet_ledger INSERT - passed TEXT directly
p_reference_id,  -- ❌ TEXT passed to UUID column

-- sales_ledger INSERT - conditional but no NULL check
CASE WHEN p_reference_type = 'order' THEN p_reference_id::UUID ELSE NULL END
-- ❌ If p_reference_id is NULL or empty, this still fails
```

**After (FIXED):**
```sql
-- wallet_ledger INSERT - uses pre-casted UUID variable
v_reference_id_uuid,  -- ✅ UUID variable (already validated and casted)

-- sales_ledger INSERT - uses pre-casted UUID variables
v_order_id_uuid,   -- ✅ NULL or valid UUID (already handled)
v_escrow_id_uuid,  -- ✅ NULL or valid UUID (already handled)
```

## Migration Order
This migration should be applied AFTER:
- `add-sales-tracking.sql` (creates `sales_ledger` table and wallet columns)
- `add-platform-commission-transaction-type.sql` (adds platform_commission type)

## Testing
After applying this migration, test with:

```sql
-- Test with valid UUID
SELECT process_wallet_transaction(
  p_user_id := 'some-user-uuid'::UUID,
  p_transaction_type := 'purchase_hold',
  p_amount := 100.00,
  p_description := 'Test transaction',
  p_reference_id := 'some-order-uuid',
  p_reference_type := 'order'
);

-- Test with NULL reference_id (should work now)
SELECT process_wallet_transaction(
  p_user_id := 'some-user-uuid'::UUID,
  p_transaction_type := 'admin_adjustment',
  p_amount := 50.00,
  p_description := 'Test without reference',
  p_reference_id := NULL,
  p_reference_type := NULL
);

-- Test with empty string (should be normalized to NULL)
SELECT process_wallet_transaction(
  p_user_id := 'some-user-uuid'::UUID,
  p_transaction_type := 'deposit_mint',
  p_amount := 200.00,
  p_description := 'Test with empty string',
  p_reference_id := '',
  p_reference_type := NULL
);
```

## Impact
- ✅ Fixes the UUID casting error that was blocking gift orders
- ✅ Maintains all existing functionality (sales tracking, all transaction types)
- ✅ Improves error handling for invalid UUIDs
- ✅ No breaking changes - all existing calls will work

## Rollback
If needed, you can rollback by reapplying the previous migration that was working, but note that it will have the UUID casting bug. This consolidated migration should be the final version.

