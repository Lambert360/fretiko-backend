-- Check the actual wallet_ledger table structure
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'wallet_ledger' 
ORDER BY ordinal_position;

-- Also check recent wallet_ledger records to see actual column names
SELECT *
FROM wallet_ledger 
ORDER BY created_at DESC 
LIMIT 3;
