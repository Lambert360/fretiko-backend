-- Debug: Test the process_wallet_transaction function directly
-- This will help us identify the exact issue

-- First, let's check if the function exists and its structure
SELECT 
  proname,
  pronargs,
  proargtypes,
  prorettype::regtype as return_type,
  prosrc
FROM pg_proc 
WHERE proname = 'process_wallet_transaction';

-- Test with a simple call (replace with actual user ID)
-- SELECT process_wallet_transaction(
--   '7df74c7a-7cdf-45dd-a1e0-f17ae374f892'::UUID, 
--   'escrow_refund', 
--   100, 
--   'Test refund', 
--   'test-order-id', 
--   'order'
-- );

-- Check the actual structure of the wallets table
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'wallets' 
ORDER BY ordinal_position;

-- Check the actual structure of the wallet_ledger table  
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'wallet_ledger' 
ORDER BY ordinal_position;
