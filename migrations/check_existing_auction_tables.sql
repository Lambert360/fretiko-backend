-- Check which auction tables already exist and their structures
-- This will help identify where the "created_at" error is coming from

-- Check if auction tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name LIKE '%auction%'
ORDER BY table_name;

-- If auction_bids exists, check its structure
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'auction_bids' AND table_schema = 'public') THEN
        RAISE NOTICE 'auction_bids table exists. Checking its structure...';
    END IF;
END $$;

-- Check auction_bids structure if it exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'auction_bids'
AND table_schema = 'public'
ORDER BY ordinal_position;