-- Migration: Enable RLS on missing TABLES only (skip views)
-- Date: 2025-09-03
-- Description: Add Row Level Security policies only to actual tables, not views

-- First, let's check which relations are actually tables vs views
-- (This query is for reference - comment out when running migration)
/*
SELECT 
    schemaname, 
    tablename, 
    'table' as relation_type
FROM pg_tables 
WHERE schemaname = 'public' 
    AND tablename IN (
        'recent_notifications', 'rewards_balances', 'rewards_calculations', 
        'rewards_config', 'rewards_transactions', 'rider_locations', 
        'wishlist_shares', 'urgent_notifications', 'user_notification_stats', 
        'user_rewards_summary', 'wishlist_collaborations'
    )
UNION ALL
SELECT 
    schemaname, 
    viewname, 
    'view' as relation_type
FROM pg_views 
WHERE schemaname = 'public' 
    AND viewname IN (
        'recent_notifications', 'rewards_balances', 'rewards_calculations', 
        'rewards_config', 'rewards_transactions', 'rider_locations', 
        'wishlist_shares', 'urgent_notifications', 'user_notification_stats', 
        'user_rewards_summary', 'wishlist_collaborations'
    )
ORDER BY tablename;
*/

-- =============================================
-- ENABLE RLS ONLY ON ACTUAL TABLES
-- =============================================

-- Enable RLS on tables that exist (skip if they're views)
DO $$
BEGIN
    -- Check and enable RLS for each table if it exists as a table (not view)
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rewards_balances') THEN
        ALTER TABLE rewards_balances ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on rewards_balances table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rewards_calculations') THEN
        ALTER TABLE rewards_calculations ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on rewards_calculations table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rewards_config') THEN
        ALTER TABLE rewards_config ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on rewards_config table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rewards_transactions') THEN
        ALTER TABLE rewards_transactions ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on rewards_transactions table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rider_locations') THEN
        ALTER TABLE rider_locations ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on rider_locations table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'wishlist_shares') THEN
        ALTER TABLE wishlist_shares ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on wishlist_shares table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'urgent_notifications') THEN
        ALTER TABLE urgent_notifications ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on urgent_notifications table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_notification_stats') THEN
        ALTER TABLE user_notification_stats ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on user_notification_stats table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_rewards_summary') THEN
        ALTER TABLE user_rewards_summary ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on user_rewards_summary table';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'wishlist_collaborations') THEN
        ALTER TABLE wishlist_collaborations ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on wishlist_collaborations table';
    END IF;
    
    -- Handle recent_notifications specially (might be a view)
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'recent_notifications') THEN
        ALTER TABLE recent_notifications ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'Enabled RLS on recent_notifications table';
    ELSE
        RAISE NOTICE 'Skipping recent_notifications - appears to be a view, not a table';
    END IF;
    
END $$;

-- =============================================
-- CREATE POLICIES ONLY FOR EXISTING TABLES
-- =============================================

-- Helper function to create policies safely
CREATE OR REPLACE FUNCTION create_policy_if_table_exists(
    table_name text,
    policy_name text,
    policy_sql text
) RETURNS void AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = table_name) THEN
        EXECUTE policy_sql;
        RAISE NOTICE 'Created policy % for table %', policy_name, table_name;
    ELSE
        RAISE NOTICE 'Skipped policy % - table % does not exist or is a view', policy_name, table_name;
    END IF;
EXCEPTION 
    WHEN duplicate_object THEN
        RAISE NOTICE 'Policy % already exists for table %', policy_name, table_name;
    WHEN OTHERS THEN
        RAISE NOTICE 'Error creating policy % for table %: %', policy_name, table_name, SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- REWARDS BALANCES POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'rewards_balances',
    'Users can view own rewards balances',
    'CREATE POLICY "Users can view own rewards balances" ON rewards_balances FOR SELECT USING (user_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'rewards_balances',
    'Service role can manage rewards balances',
    'CREATE POLICY "Service role can manage rewards balances" ON rewards_balances FOR ALL USING (auth.role() = ''service_role'')'
);

-- =============================================
-- REWARDS CALCULATIONS POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'rewards_calculations',
    'Users can view own rewards calculations',
    'CREATE POLICY "Users can view own rewards calculations" ON rewards_calculations FOR SELECT USING (user_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'rewards_calculations',
    'Service role can manage rewards calculations',
    'CREATE POLICY "Service role can manage rewards calculations" ON rewards_calculations FOR ALL USING (auth.role() = ''service_role'')'
);

-- =============================================
-- REWARDS CONFIG POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'rewards_config',
    'Anyone can view rewards config',
    'CREATE POLICY "Anyone can view rewards config" ON rewards_config FOR SELECT USING (true)'
);

SELECT create_policy_if_table_exists(
    'rewards_config',
    'Service role can manage rewards config',
    'CREATE POLICY "Service role can manage rewards config" ON rewards_config FOR ALL USING (auth.role() = ''service_role'')'
);

-- =============================================
-- REWARDS TRANSACTIONS POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'rewards_transactions',
    'Users can view own rewards transactions',
    'CREATE POLICY "Users can view own rewards transactions" ON rewards_transactions FOR SELECT USING (user_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'rewards_transactions',
    'Service role can manage rewards transactions',
    'CREATE POLICY "Service role can manage rewards transactions" ON rewards_transactions FOR ALL USING (auth.role() = ''service_role'')'
);

-- =============================================
-- RIDER LOCATIONS POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'rider_locations',
    'Riders can manage own location',
    'CREATE POLICY "Riders can manage own location" ON rider_locations FOR ALL USING (user_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'rider_locations',
    'Users can view available rider locations',
    'CREATE POLICY "Users can view available rider locations" ON rider_locations FOR SELECT USING (auth.role() = ''authenticated'' AND is_online = true AND last_ping > NOW() - INTERVAL ''10 minutes'')'
);

SELECT create_policy_if_table_exists(
    'rider_locations',
    'Service role can manage rider locations',
    'CREATE POLICY "Service role can manage rider locations" ON rider_locations FOR ALL USING (auth.role() = ''service_role'')'
);

-- =============================================
-- WISHLIST SHARES POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'wishlist_shares',
    'Owners can manage wishlist shares',
    'CREATE POLICY "Owners can manage wishlist shares" ON wishlist_shares FOR ALL USING (owner_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'wishlist_shares',
    'Shared users can view wishlist shares',
    'CREATE POLICY "Shared users can view wishlist shares" ON wishlist_shares FOR SELECT USING (shared_with_id = auth.uid())'
);

-- =============================================
-- URGENT NOTIFICATIONS POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'urgent_notifications',
    'Users can view own urgent notifications',
    'CREATE POLICY "Users can view own urgent notifications" ON urgent_notifications FOR SELECT USING (user_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'urgent_notifications',
    'Users can update own urgent notifications',
    'CREATE POLICY "Users can update own urgent notifications" ON urgent_notifications FOR UPDATE USING (user_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'urgent_notifications',
    'Service role can manage urgent notifications',
    'CREATE POLICY "Service role can manage urgent notifications" ON urgent_notifications FOR ALL USING (auth.role() = ''service_role'')'
);

-- =============================================
-- USER NOTIFICATION STATS POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'user_notification_stats',
    'Users can manage own notification stats',
    'CREATE POLICY "Users can manage own notification stats" ON user_notification_stats FOR ALL USING (user_id = auth.uid())'
);

-- =============================================
-- USER REWARDS SUMMARY POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'user_rewards_summary',
    'Users can view own rewards summary',
    'CREATE POLICY "Users can view own rewards summary" ON user_rewards_summary FOR SELECT USING (user_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'user_rewards_summary',
    'Service role can manage rewards summaries',
    'CREATE POLICY "Service role can manage rewards summaries" ON user_rewards_summary FOR ALL USING (auth.role() = ''service_role'')'
);

-- =============================================
-- WISHLIST COLLABORATIONS POLICIES
-- =============================================

SELECT create_policy_if_table_exists(
    'wishlist_collaborations',
    'Wishlist owners can view collaborations on their wishlists',
    'CREATE POLICY "Wishlist owners can view collaborations on their wishlists" ON wishlist_collaborations FOR SELECT USING (wishlist_owner_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'wishlist_collaborations',
    'Friends can view their own collaboration records',
    'CREATE POLICY "Friends can view their own collaboration records" ON wishlist_collaborations FOR SELECT USING (added_by_friend_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'wishlist_collaborations',
    'Friends can add items to shared wishlists',
    'CREATE POLICY "Friends can add items to shared wishlists" ON wishlist_collaborations FOR INSERT WITH CHECK (added_by_friend_id = auth.uid())'
);

SELECT create_policy_if_table_exists(
    'wishlist_collaborations',
    'Friends can update their own collaboration notes',
    'CREATE POLICY "Friends can update their own collaboration notes" ON wishlist_collaborations FOR UPDATE USING (added_by_friend_id = auth.uid())'
);

-- =============================================
-- ADD INDEXES FOR PERFORMANCE
-- =============================================

-- Create indexes only if tables exist
DO $$
BEGIN
    -- Add indexes for tables that exist
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rewards_balances') THEN
        CREATE INDEX IF NOT EXISTS idx_rewards_balances_user_id ON rewards_balances(user_id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rewards_calculations') THEN
        CREATE INDEX IF NOT EXISTS idx_rewards_calculations_user_id ON rewards_calculations(user_id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rewards_transactions') THEN
        CREATE INDEX IF NOT EXISTS idx_rewards_transactions_user_id ON rewards_transactions(user_id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'urgent_notifications') THEN
        CREATE INDEX IF NOT EXISTS idx_urgent_notifications_user_id ON urgent_notifications(user_id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_notification_stats') THEN
        CREATE INDEX IF NOT EXISTS idx_user_notification_stats_user_id ON user_notification_stats(user_id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_rewards_summary') THEN
        CREATE INDEX IF NOT EXISTS idx_user_rewards_summary_user_id ON user_rewards_summary(user_id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'wishlist_shares') THEN
        CREATE INDEX IF NOT EXISTS idx_wishlist_shares_owner ON wishlist_shares(owner_id);
        CREATE INDEX IF NOT EXISTS idx_wishlist_shares_shared_user ON wishlist_shares(shared_with_id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'wishlist_collaborations') THEN
        CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_wishlist ON wishlist_collaborations(wishlist_item_id);
        CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_owner ON wishlist_collaborations(wishlist_owner_id);
        CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_friend ON wishlist_collaborations(added_by_friend_id);
    END IF;
END $$;

-- Clean up helper function
DROP FUNCTION create_policy_if_table_exists(text, text, text);

-- Final report
DO $$
DECLARE
    table_count INTEGER;
    view_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO table_count
    FROM pg_tables 
    WHERE schemaname = 'public' 
        AND tablename IN (
            'rewards_balances', 'rewards_calculations', 'rewards_config', 
            'rewards_transactions', 'rider_locations', 'wishlist_shares', 
            'urgent_notifications', 'user_notification_stats', 
            'user_rewards_summary', 'wishlist_collaborations', 'recent_notifications'
        );
    
    SELECT COUNT(*) INTO view_count
    FROM pg_views 
    WHERE schemaname = 'public' 
        AND viewname IN (
            'rewards_balances', 'rewards_calculations', 'rewards_config', 
            'rewards_transactions', 'rider_locations', 'wishlist_shares', 
            'urgent_notifications', 'user_notification_stats', 
            'user_rewards_summary', 'wishlist_collaborations', 'recent_notifications'
        );
    
    RAISE NOTICE '=== RLS MIGRATION COMPLETE ===';
    RAISE NOTICE 'Tables processed: %', table_count;
    RAISE NOTICE 'Views skipped: %', view_count;
    RAISE NOTICE 'Views inherit RLS from their underlying tables';
END $$;

COMMIT;