-- Migration: Update user_wallet_summary view to be RLS-aware
-- Date: 2025-08-28
-- Description: Replace view with RLS-enforced version

BEGIN;

-- Drop existing view
DROP VIEW IF EXISTS user_wallet_summary;

-- Create RLS-aware view that only shows user's own data
CREATE OR REPLACE VIEW user_wallet_summary AS
SELECT 
    w.user_id,
    w.available_balance,
    w.escrow_balance,
    w.pending_withdrawal,
    (w.available_balance + w.escrow_balance) as total_balance,
    w.preferred_currency,
    w.kyc_status,
    w.daily_deposit_limit,
    w.daily_withdrawal_limit,
    COALESCE(ts.vendor_trust_score, 0) as vendor_trust_score,
    COALESCE(ts.rider_trust_score, 0) as rider_trust_score,
    COALESCE(ts.buyer_trust_score, 0) as buyer_trust_score,
    COUNT(rf.id) FILTER (WHERE rf.is_active) as active_risk_flags,
    jsonb_build_object(
        'currency', w.preferred_currency,
        'available', w.available_balance,
        'total', w.available_balance + w.escrow_balance,
        'escrow', w.escrow_balance,
        'pending', w.pending_withdrawal
    ) as local_currency_equivalent,
    -- Recent transaction stats
    (SELECT COUNT(*) FROM wallet_ledger wl WHERE wl.user_id = w.user_id AND wl.created_at >= now() - interval '30 days') as recent_transaction_count,
    (SELECT COALESCE(SUM(available_delta), 0) FROM wallet_ledger wl WHERE wl.user_id = w.user_id AND wl.transaction_type = 'deposit_mint' AND wl.created_at >= date_trunc('month', now())) as monthly_deposits,
    (SELECT COALESCE(SUM(ABS(available_delta)), 0) FROM wallet_ledger wl WHERE wl.user_id = w.user_id AND wl.transaction_type = 'purchase_hold' AND wl.created_at >= date_trunc('month', now())) as monthly_spending
FROM wallets w
LEFT JOIN trust_scores ts ON w.user_id = ts.user_id
LEFT JOIN risk_flags rf ON w.user_id = rf.user_id
WHERE w.user_id = auth.uid()  -- RLS: Only show current user's data
GROUP BY w.user_id, w.available_balance, w.escrow_balance, w.pending_withdrawal, 
         w.preferred_currency, w.kyc_status, w.daily_deposit_limit, w.daily_withdrawal_limit,
         ts.vendor_trust_score, ts.rider_trust_score, ts.buyer_trust_score;

-- Grant permissions on the view
GRANT SELECT ON user_wallet_summary TO authenticated;

COMMIT;