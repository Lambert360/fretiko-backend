-- ============================================
-- Phase 7: Database Integrity Verification
-- Platform Commission and Wallet System
-- ============================================
-- Run these queries to verify database setup
-- All queries should return expected results

-- ============================================
-- 1. Platform User Verification
-- ============================================

-- Check platform user exists in auth.users
SELECT 
    id,
    email,
    role,
    created_at
FROM auth.users 
WHERE id = '00000000-0000-4000-8000-000000000002';

-- Expected: 1 row with email = 'platform@fretiko.com', role = 'authenticated'

-- ============================================
-- 2. Platform User Profile Verification
-- ============================================

-- Check platform user profile exists
SELECT 
    id,
    username,
    bio,
    preferences,
    created_at
FROM user_profiles 
WHERE id = '00000000-0000-4000-8000-000000000002';

-- Expected: 1 row with username = 'fretiko_platform'

-- ============================================
-- 3. Platform Wallet Verification
-- ============================================

-- Check platform wallet exists
SELECT 
    id,
    user_id,
    available_balance,
    escrow_balance,
    pending_withdrawal,
    preferred_currency,
    created_at
FROM wallets 
WHERE user_id = '00000000-0000-4000-8000-000000000002';

-- Expected: 1 row with wallet for platform user

-- ============================================
-- 4. Auction Commission Rate Verification
-- ============================================

-- Check default commission rate for auctions
SELECT 
    column_name,
    column_default,
    data_type
FROM information_schema.columns 
WHERE table_name = 'auctions' 
  AND column_name = 'commission_rate';

-- Expected: column_default should be '0.1000' (10%)

-- Check existing auctions have correct rate
SELECT 
    id,
    title,
    commission_rate,
    created_at
FROM auctions 
ORDER BY created_at DESC 
LIMIT 10;

-- Expected: All auctions should have commission_rate = 0.1000 (10%)

-- ============================================
-- 5. Order Source Enum Verification
-- ============================================

-- Check that 'wishlist' is in the order source enum
SELECT 
    constraint_name,
    check_clause
FROM information_schema.check_constraints 
WHERE constraint_name = 'orders_source_check';

-- Expected: check_clause should include 'wishlist' in the list
-- Should contain: 'regular', 'live_stream', 'auction', 'service_booking', 'invoice', 'wishlist'

-- ============================================
-- 6. Platform Commission Collection Summary
-- ============================================

-- Summary of platform commissions collected (from escrows)
SELECT 
    COUNT(*) as total_escrows_with_commission,
    SUM(platform_amount) as total_platform_commission,
    AVG(platform_amount) as avg_platform_commission,
    MIN(platform_amount) as min_platform_commission,
    MAX(platform_amount) as max_platform_commission
FROM escrows 
WHERE platform_amount > 0 
  AND status = 'released';

-- This shows how much commission has been collected and released

-- ============================================
-- 7. Platform Wallet Balance Summary
-- ============================================

-- Current platform wallet balance
SELECT 
    w.available_balance,
    w.escrow_balance,
    w.pending_withdrawal,
    (w.available_balance + w.escrow_balance + w.pending_withdrawal) as total_balance
FROM wallets w
WHERE w.user_id = '00000000-0000-4000-8000-000000000002';

-- ============================================
-- 8. Commission Rate Verification by Service Type
-- ============================================

-- Check commission rates in orders by source
SELECT 
    source,
    COUNT(*) as order_count,
    AVG(platform_fee) as avg_platform_fee,
    SUM(platform_fee) as total_platform_fee,
    AVG(total_amount) as avg_order_amount,
    -- Calculate effective commission rate
    CASE 
        WHEN AVG(total_amount) > 0 
        THEN (AVG(platform_fee) / AVG(total_amount)) * 100 
        ELSE 0 
    END as effective_commission_percentage
FROM orders 
WHERE platform_fee > 0
GROUP BY source
ORDER BY source;

-- Expected commission rates:
-- regular: ~2%
-- invoice: ~2%
-- wishlist: ~2%
-- live_stream: ~5%
-- auction: ~10%

-- ============================================
-- 9. Platform Bank Accounts Verification
-- ============================================

-- Check platform bank accounts
SELECT 
    id,
    account_name,
    bank_name,
    account_number,
    account_type,
    currency,
    country,
    is_verified,
    is_default,
    is_active,
    created_at
FROM user_bank_accounts
WHERE user_id = '00000000-0000-4000-8000-000000000002'
ORDER BY is_default DESC, created_at DESC;

-- ============================================
-- 10. Platform Withdrawal Requests
-- ============================================

-- Check platform withdrawal requests
SELECT 
    pr.id,
    pr.user_id,
    pr.freti_amount,
    pr.status,
    pr.requested_at,
    pr.processed_at,
    pr.metadata->>'bank_account_id' as bank_account_id,
    ba.account_name,
    ba.bank_name
FROM payout_requests pr
LEFT JOIN user_bank_accounts ba ON (pr.metadata->>'bank_account_id')::uuid = ba.id
WHERE pr.user_id = '00000000-0000-4000-8000-000000000002'
ORDER BY pr.requested_at DESC;

-- ============================================
-- 11. Commission Collection by Order Source
-- ============================================

-- Detailed breakdown of commissions by order source
SELECT 
    o.source,
    COUNT(DISTINCT o.id) as order_count,
    SUM(e.platform_amount) as total_commission,
    SUM(o.total_amount) as total_order_value,
    CASE 
        WHEN SUM(o.total_amount) > 0 
        THEN (SUM(e.platform_amount) / SUM(o.total_amount)) * 100 
        ELSE 0 
    END as commission_rate_percentage,
    COUNT(CASE WHEN e.status = 'released' THEN 1 END) as released_count,
    SUM(CASE WHEN e.status = 'released' THEN e.platform_amount ELSE 0 END) as released_commission
FROM orders o
INNER JOIN escrows e ON o.id = e.order_id
WHERE e.platform_amount > 0
GROUP BY o.source
ORDER BY total_commission DESC;

-- ============================================
-- 12. Platform Wallet Transaction History
-- ============================================

-- Recent platform wallet transactions (if wallet_ledger tracks platform wallet)
SELECT 
    wl.id,
    wl.transaction_type,
    wl.available_delta,
    wl.escrow_delta,
    wl.pending_withdrawal_delta,
    wl.available_balance_after,
    wl.description,
    wl.reference_type,
    wl.reference_id,
    wl.created_at
FROM wallet_ledger wl
INNER JOIN wallets w ON wl.wallet_id = w.id
WHERE w.user_id = '00000000-0000-4000-8000-000000000002'
  AND (wl.transaction_type = 'platform_commission' OR wl.description LIKE '%platform commission%')
ORDER BY wl.created_at DESC
LIMIT 50;

-- ============================================
-- Verification Checklist Results
-- ============================================
-- After running all queries, verify:
-- [ ] Platform user exists in auth.users
-- [ ] Platform user profile exists
-- [ ] Platform wallet exists
-- [ ] Auction commission_rate default = 0.1000 (10%)
-- [ ] Order source enum includes 'wishlist'
-- [ ] Platform wallet has balance data
-- [ ] Commission rates match expected percentages
-- [ ] Bank accounts can be queried (if any exist)
-- [ ] Withdrawal requests can be queried (if any exist)

