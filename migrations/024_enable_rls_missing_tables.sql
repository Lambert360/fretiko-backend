-- Migration: Enable RLS on missing tables with appropriate policies
-- Date: 2025-09-03
-- Description: Add Row Level Security policies to tables that are missing them

-- Enable RLS on all tables that don't have it yet
ALTER TABLE recent_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE rewards_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE rewards_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rewards_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE rewards_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE urgent_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_rewards_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_collaborations ENABLE ROW LEVEL SECURITY;

-- =============================================
-- RECENT NOTIFICATIONS POLICIES
-- =============================================

-- Users can view their own recent notifications
CREATE POLICY "Users can view own recent notifications" ON recent_notifications
    FOR SELECT USING (user_id = auth.uid());

-- Users can insert their own recent notifications (system notifications)
CREATE POLICY "Users can insert own recent notifications" ON recent_notifications
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update their own recent notifications (mark as read, etc.)
CREATE POLICY "Users can update own recent notifications" ON recent_notifications
    FOR UPDATE USING (user_id = auth.uid());

-- Users can delete their own recent notifications
CREATE POLICY "Users can delete own recent notifications" ON recent_notifications
    FOR DELETE USING (user_id = auth.uid());

-- =============================================
-- REWARDS BALANCES POLICIES
-- =============================================

-- Users can view their own rewards balances
CREATE POLICY "Users can view own rewards balances" ON rewards_balances
    FOR SELECT USING (user_id = auth.uid());

-- System can insert rewards balances (service_role only for integrity)
CREATE POLICY "Service role can manage rewards balances" ON rewards_balances
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- REWARDS CALCULATIONS POLICIES
-- =============================================

-- Users can view their own rewards calculations
CREATE POLICY "Users can view own rewards calculations" ON rewards_calculations
    FOR SELECT USING (user_id = auth.uid());

-- System can manage rewards calculations
CREATE POLICY "Service role can manage rewards calculations" ON rewards_calculations
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- REWARDS CONFIG POLICIES
-- =============================================

-- Everyone can read rewards config (public settings)
CREATE POLICY "Anyone can view rewards config" ON rewards_config
    FOR SELECT USING (true);

-- Only service role can modify rewards config
CREATE POLICY "Service role can manage rewards config" ON rewards_config
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- REWARDS TRANSACTIONS POLICIES
-- =============================================

-- Users can view their own rewards transactions
CREATE POLICY "Users can view own rewards transactions" ON rewards_transactions
    FOR SELECT USING (user_id = auth.uid());

-- System can manage rewards transactions
CREATE POLICY "Service role can manage rewards transactions" ON rewards_transactions
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- RIDER LOCATIONS POLICIES
-- =============================================

-- Riders can view and update their own location
CREATE POLICY "Riders can manage own location" ON rider_locations
    FOR ALL USING (user_id = auth.uid());

-- Authenticated users can view online rider locations (for finding nearby riders)
CREATE POLICY "Users can view online rider locations" ON rider_locations
    FOR SELECT USING (
        auth.role() = 'authenticated' AND 
        is_online = true AND 
        last_ping > NOW() - INTERVAL '10 minutes'
    );

-- Service role can manage all rider locations
CREATE POLICY "Service role can manage rider locations" ON rider_locations
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- WISHLIST SHARES POLICIES
-- =============================================

-- Wishlist owners can manage shares of their wishlists
CREATE POLICY "Owners can manage wishlist shares" ON wishlist_shares
    FOR ALL USING (
        wishlist_id IN (
            SELECT id FROM wishlists WHERE user_id = auth.uid()
        )
    );

-- Shared users can view shares they're part of
CREATE POLICY "Shared users can view wishlist shares" ON wishlist_shares
    FOR SELECT USING (shared_with_user_id = auth.uid());

-- =============================================
-- URGENT NOTIFICATIONS POLICIES
-- =============================================

-- Users can view their own urgent notifications
CREATE POLICY "Users can view own urgent notifications" ON urgent_notifications
    FOR SELECT USING (user_id = auth.uid());

-- Users can update their own urgent notifications (mark as read)
CREATE POLICY "Users can update own urgent notifications" ON urgent_notifications
    FOR UPDATE USING (user_id = auth.uid());

-- System can manage urgent notifications
CREATE POLICY "Service role can manage urgent notifications" ON urgent_notifications
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- USER NOTIFICATION STATS POLICIES
-- =============================================

-- Users can view and update their own notification stats
CREATE POLICY "Users can manage own notification stats" ON user_notification_stats
    FOR ALL USING (user_id = auth.uid());

-- =============================================
-- USER REWARDS SUMMARY POLICIES
-- =============================================

-- Users can view their own rewards summary
CREATE POLICY "Users can view own rewards summary" ON user_rewards_summary
    FOR SELECT USING (user_id = auth.uid());

-- System can manage rewards summaries
CREATE POLICY "Service role can manage rewards summaries" ON user_rewards_summary
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- WISHLIST COLLABORATIONS POLICIES
-- =============================================

-- Wishlist owners can manage collaborations on their wishlists
CREATE POLICY "Owners can manage wishlist collaborations" ON wishlist_collaborations
    FOR ALL USING (
        wishlist_id IN (
            SELECT id FROM wishlists WHERE user_id = auth.uid()
        )
    );

-- Collaborators can view and interact with collaborations they're part of
CREATE POLICY "Collaborators can view own collaborations" ON wishlist_collaborations
    FOR SELECT USING (collaborator_id = auth.uid());

-- Collaborators can add items to wishlists they collaborate on
CREATE POLICY "Collaborators can add items" ON wishlist_collaborations
    FOR INSERT WITH CHECK (collaborator_id = auth.uid());

-- Collaborators can update their own collaboration records
CREATE POLICY "Collaborators can update own collaboration data" ON wishlist_collaborations
    FOR UPDATE USING (collaborator_id = auth.uid());

-- =============================================
-- ADDITIONAL SECURITY MEASURES
-- =============================================

-- Create function to check if user is admin (for future use)
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM user_profiles 
        WHERE id = auth.uid() 
        AND (preferences->>'is_admin')::boolean = true
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission on admin function
GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION is_admin() IS 'Helper function to check if current user has admin privileges';

-- Create view for user's own data aggregation (optional optimization)
CREATE OR REPLACE VIEW user_dashboard_summary AS
SELECT 
    up.id,
    up.username,
    COALESCE(rb.current_balance, 0) as rewards_balance,
    COALESCE(urs.total_earned, 0) as total_rewards_earned,
    COALESCE(uns.unread_count, 0) as unread_notifications,
    (SELECT COUNT(*) FROM wishlists w WHERE w.user_id = up.id) as wishlist_count,
    (SELECT COUNT(*) FROM wishlist_shares ws 
     JOIN wishlists w ON ws.wishlist_id = w.id 
     WHERE ws.shared_with_user_id = up.id) as shared_wishlists_count
FROM user_profiles up
LEFT JOIN rewards_balances rb ON rb.user_id = up.id
LEFT JOIN user_rewards_summary urs ON urs.user_id = up.id
LEFT JOIN user_notification_stats uns ON uns.user_id = up.id
WHERE up.id = auth.uid();

-- Grant access to the dashboard view
GRANT SELECT ON user_dashboard_summary TO authenticated;

-- Add helpful indexes for RLS performance (if they don't exist)
CREATE INDEX IF NOT EXISTS idx_recent_notifications_user_id ON recent_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_rewards_balances_user_id ON rewards_balances(user_id);
CREATE INDEX IF NOT EXISTS idx_rewards_calculations_user_id ON rewards_calculations(user_id);
CREATE INDEX IF NOT EXISTS idx_rewards_transactions_user_id ON rewards_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_urgent_notifications_user_id ON urgent_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notification_stats_user_id ON user_notification_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_user_rewards_summary_user_id ON user_rewards_summary(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_shares_owner ON wishlist_shares(wishlist_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_shares_shared_user ON wishlist_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_wishlist ON wishlist_collaborations(wishlist_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_collaborator ON wishlist_collaborations(collaborator_id);

-- Final security check: Ensure service_role has necessary permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO service_role;

COMMIT;