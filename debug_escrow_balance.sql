-- Debug query to check escrow balance for the failing transaction
-- Run this in Supabase SQL Editor to see what's happening

-- 1. Check the specific escrow record
SELECT 
  e.id,
  e.order_id,
  e.total_amount,
  e.status,
  e.created_at,
  o.order_number,
  o.buyer_id,
  o.vendor_id
FROM escrows e
JOIN orders o ON e.order_id = o.id
WHERE e.id = 'e9e94eaf-2ce5-45df-95b8-ebe4fe983717';

-- 2. Check the buyer's wallet balances
SELECT 
  w.id,
  w.user_id,
  w.available_balance,
  w.escrow_balance,
  w.pending_withdrawal,
  w.updated_at
FROM wallets w
WHERE w.user_id = '7df74c7a-7cdf-45dd-a1e0-f17ae374f892';

-- 3. Check if there are any existing transactions for this order
SELECT 
  id,
  transaction_type,
  amount,
  reference_id,
  reference_type,
  created_at,
  description
FROM wallet_ledger
WHERE user_id = '7df74c7a-7cdf-45dd-a1e0-f17ae374f892'
  AND reference_id = '2b301f64-a0f7-4f4b-96f6-3e71524ea307'
ORDER BY created_at DESC;

-- 4. Test the wallet function directly with debug logging
SELECT *
FROM process_wallet_transaction(
  '7df74c7a-7cdf-45dd-a1e0-f17ae374f892'::UUID,
  'escrow_refund'::TEXT,
  258::NUMERIC,
  'Refund for order TEST'::TEXT,
  '2b301f64-a0f7-4f4b-96f6-3e71524ea307'::TEXT,
  'order'::TEXT
);
