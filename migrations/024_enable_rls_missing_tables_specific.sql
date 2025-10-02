-- Migration: Enable RLS on missing tables with SPECIFIC policies
-- Date: 2025-09-03
-- Description: Add highly specific Row Level Security policies

-- Enable RLS on all tables
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
-- RECENT NOTIFICATIONS - Very Specific Policies
-- =============================================

-- Users can only view their own notifications that are less than 30 days old
CREATE POLICY "Users view own recent notifications only" ON recent_notifications
    FOR SELECT USING (
        user_id = auth.uid() 
        AND created_at > NOW() - INTERVAL '30 days'
        AND is_deleted = false
    );

-- Users can only mark their own notifications as read (no content changes)
CREATE POLICY "Users can only mark own notifications read" ON recent_notifications
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (
        user_id = auth.uid() 
        AND (OLD.notification_type = NEW.notification_type)  -- Can't change type
        AND (OLD.created_at = NEW.created_at)  -- Can't change timestamp
        AND (OLD.content = NEW.content)  -- Can't change content
    );

-- Only system can create notifications (via service_role)
CREATE POLICY "Only system can create notifications" ON recent_notifications
    FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- Users can soft-delete their own notifications
CREATE POLICY "Users can soft-delete own notifications" ON recent_notifications
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (
        user_id = auth.uid() 
        AND is_deleted = true  -- Only allow setting to deleted
    );

-- =============================================
-- REWARDS BALANCES - Specific Read-Only Access
-- =============================================

-- Users can only view their own current balance (no historical data access)
CREATE POLICY "Users view own current balance only" ON rewards_balances
    FOR SELECT USING (
        user_id = auth.uid() 
        AND is_active = true
    );

-- Only rewards system can manage balances
CREATE POLICY "Only rewards system manages balances" ON rewards_balances
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- REWARDS CALCULATIONS - Specific Computation Access
-- =============================================

-- Users can only view successful calculations for their transactions
CREATE POLICY "Users view own successful calculations" ON rewards_calculations
    FOR SELECT USING (
        user_id = auth.uid() 
        AND status = 'completed'
        AND created_at > NOW() - INTERVAL '90 days'  -- Only last 90 days
    );

-- Only rewards engine can manage calculations
CREATE POLICY "Only rewards engine manages calculations" ON rewards_calculations
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- REWARDS CONFIG - Public Read with Restrictions
-- =============================================

-- Users can only view active public configuration
CREATE POLICY "Users view active public rewards config" ON rewards_config
    FOR SELECT USING (
        is_active = true 
        AND is_public = true
        AND valid_from <= NOW()
        AND (valid_until IS NULL OR valid_until > NOW())
    );

-- Only admin service role can manage config
CREATE POLICY "Only admin can manage rewards config" ON rewards_config
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- REWARDS TRANSACTIONS - Specific Transaction Access
-- =============================================

-- Users can only view their own completed/successful transactions
CREATE POLICY "Users view own successful transactions only" ON rewards_transactions
    FOR SELECT USING (
        user_id = auth.uid() 
        AND status IN ('completed', 'success', 'processed')
        AND created_at > NOW() - INTERVAL '12 months'  -- Only last year
        AND amount > 0  -- No failed/reversed transactions
    );

-- Users can view their pending transactions (for status checking)
CREATE POLICY "Users view own pending transactions" ON rewards_transactions
    FOR SELECT USING (
        user_id = auth.uid() 
        AND status = 'pending'
        AND created_at > NOW() - INTERVAL '7 days'  -- Only recent pending
    );

-- Only rewards system can create/update transactions
CREATE POLICY "Only rewards system manages transactions" ON rewards_transactions
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- RIDER LOCATIONS - Delivery-Specific Access
-- =============================================

-- Riders can only manage their own location data
CREATE POLICY "Riders manage own location only" ON rider_locations
    FOR ALL USING (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE id = auth.uid() 
            AND is_rider = true 
            AND is_active = true
        )
    );

-- Users can only see available riders within reasonable distance/time
CREATE POLICY "Users see available riders for delivery" ON rider_locations
    FOR SELECT USING (
        auth.role() = 'authenticated' 
        AND is_online = true 
        AND is_available = true
        AND last_ping > NOW() - INTERVAL '5 minutes'  -- Very recent ping
        AND battery_level > 15  -- Sufficient battery
        AND EXISTS (
            SELECT 1 FROM user_profiles up
            WHERE up.id = rider_locations.user_id
            AND up.is_rider = true
            AND up.is_active = true
            AND up.verification_status = 'verified'
        )
    );

-- Delivery system can track riders during active orders
CREATE POLICY "System tracks riders during delivery" ON rider_locations
    FOR SELECT USING (
        auth.role() = 'service_role'
        AND current_order_id IS NOT NULL
    );

-- =============================================
-- WISHLIST SHARES - Permission-Based Sharing
-- =============================================

-- Wishlist owners can manage shares of their active wishlists only
CREATE POLICY "Owners manage shares of active wishlists" ON wishlist_shares
    FOR ALL USING (
        wishlist_id IN (
            SELECT id FROM wishlists 
            WHERE user_id = auth.uid() 
            AND is_active = true
            AND is_private = false  -- Only non-private wishlists can be shared
        )
    );

-- Shared users can only view valid shares they received
CREATE POLICY "Users view valid shares received" ON wishlist_shares
    FOR SELECT USING (
        shared_with_user_id = auth.uid()
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())
        AND wishlist_id IN (
            SELECT id FROM wishlists 
            WHERE is_active = true
        )
    );

-- Shared users can only accept/decline shares (not modify permissions)
CREATE POLICY "Users can only respond to shares" ON wishlist_shares
    FOR UPDATE USING (shared_with_user_id = auth.uid())
    WITH CHECK (
        shared_with_user_id = auth.uid()
        AND (OLD.wishlist_id = NEW.wishlist_id)  -- Can't change wishlist
        AND (OLD.shared_by_user_id = NEW.shared_by_user_id)  -- Can't change sharer
        AND (OLD.permissions = NEW.permissions OR OLD.permissions IS NULL)  -- Can't escalate permissions
    );

-- =============================================
-- URGENT NOTIFICATIONS - Priority-Based Access
-- =============================================

-- Users can only view their own high-priority notifications
CREATE POLICY "Users view own urgent notifications" ON urgent_notifications
    FOR SELECT USING (
        user_id = auth.uid()
        AND priority IN ('urgent', 'critical', 'high')
        AND created_at > NOW() - INTERVAL '7 days'  -- Only recent urgent ones
        AND is_dismissed = false
    );

-- Users can only dismiss their own urgent notifications
CREATE POLICY "Users dismiss own urgent notifications" ON urgent_notifications
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (
        user_id = auth.uid()
        AND is_dismissed = true  -- Only allow dismissal
        AND (OLD.content = NEW.content)  -- Can't change content
    );

-- Only system can create urgent notifications
CREATE POLICY "Only system creates urgent notifications" ON urgent_notifications
    FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- =============================================
-- USER NOTIFICATION STATS - Statistical Access
-- =============================================

-- Users can view their own current stats only
CREATE POLICY "Users view own current notification stats" ON user_notification_stats
    FOR SELECT USING (
        user_id = auth.uid()
        AND updated_at > NOW() - INTERVAL '1 day'  -- Only recent stats
    );

-- Users can update their own read counts (increment only)
CREATE POLICY "Users increment own notification stats" ON user_notification_stats
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (
        user_id = auth.uid()
        AND NEW.total_read >= OLD.total_read  -- Only increment
        AND NEW.last_read_at >= OLD.last_read_at  -- Only forward in time
    );

-- System manages comprehensive stats
CREATE POLICY "System manages notification stats" ON user_notification_stats
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- USER REWARDS SUMMARY - Summary Access Control
-- =============================================

-- Users can only view their own positive reward summaries
CREATE POLICY "Users view own positive reward summary" ON user_rewards_summary
    FOR SELECT USING (
        user_id = auth.uid()
        AND total_earned >= 0  -- No negative/error summaries
        AND last_updated > NOW() - INTERVAL '30 days'  -- Recent summary
    );

-- Only rewards system can update summaries
CREATE POLICY "Only rewards system updates summaries" ON user_rewards_summary
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- WISHLIST COLLABORATIONS - Action-Specific Access
-- =============================================

-- Wishlist owners can manage collaborations on their active wishlists
CREATE POLICY "Owners manage collaborations on active wishlists" ON wishlist_collaborations
    FOR ALL USING (
        wishlist_id IN (
            SELECT id FROM wishlists 
            WHERE user_id = auth.uid() 
            AND is_active = true
        )
    );

-- Collaborators can only view collaborations they're actively part of
CREATE POLICY "Active collaborators view own collaborations" ON wishlist_collaborations
    FOR SELECT USING (
        collaborator_id = auth.uid()
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())
        AND wishlist_id IN (
            SELECT id FROM wishlists WHERE is_active = true
        )
    );

-- Collaborators can only add items (no removal) and only if they have add permission
CREATE POLICY "Collaborators can add items only" ON wishlist_collaborations
    FOR INSERT WITH CHECK (
        collaborator_id = auth.uid()
        AND action_type = 'add_item'
        AND EXISTS (
            SELECT 1 FROM wishlist_shares ws
            WHERE ws.wishlist_id = wishlist_collaborations.wishlist_id
            AND ws.shared_with_user_id = auth.uid()
            AND ws.permissions ? 'add_items'
            AND ws.is_active = true
        )
    );

-- Collaborators can update only their own collaboration records (like notes)
CREATE POLICY "Collaborators update own collaboration data" ON wishlist_collaborations
    FOR UPDATE USING (collaborator_id = auth.uid())
    WITH CHECK (
        collaborator_id = auth.uid()
        AND (OLD.action_type = NEW.action_type)  -- Can't change action type
        AND (OLD.created_at = NEW.created_at)  -- Can't change timestamp
    );

-- =============================================
-- ENHANCED SECURITY FUNCTIONS
-- =============================================

-- More specific admin check function
CREATE OR REPLACE FUNCTION is_verified_admin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM user_profiles 
        WHERE id = auth.uid() 
        AND is_active = true
        AND verification_status = 'verified'
        AND (preferences->>'is_admin')::boolean = true
        AND created_at < NOW() - INTERVAL '30 days'  -- Account must be established
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user is active rider
CREATE OR REPLACE FUNCTION is_active_rider()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM user_profiles 
        WHERE id = auth.uid() 
        AND is_rider = true
        AND is_active = true
        AND verification_status = 'verified'
        AND created_at < NOW() - INTERVAL '7 days'  -- Must be established rider
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user can access rewards (verification required)
CREATE OR REPLACE FUNCTION can_access_rewards()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM user_profiles 
        WHERE id = auth.uid() 
        AND is_active = true
        AND verification_status IN ('verified', 'premium')
        AND created_at < NOW() - INTERVAL '24 hours'  -- Account must exist for 24h
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant permissions
GRANT EXECUTE ON FUNCTION is_verified_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION is_active_rider() TO authenticated;  
GRANT EXECUTE ON FUNCTION can_access_rewards() TO authenticated;

-- =============================================
-- PERFORMANCE INDEXES FOR SPECIFIC RLS QUERIES
-- =============================================

-- Indexes optimized for specific policy conditions
CREATE INDEX IF NOT EXISTS idx_recent_notifications_user_active ON recent_notifications(user_id, created_at DESC) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_rewards_balances_user_active ON rewards_balances(user_id, updated_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_rewards_transactions_user_success ON rewards_transactions(user_id, created_at DESC) WHERE status IN ('completed', 'success', 'processed');
CREATE INDEX IF NOT EXISTS idx_rider_locations_available ON rider_locations(latitude, longitude, last_ping DESC) WHERE is_online = true AND is_available = true;
CREATE INDEX IF NOT EXISTS idx_wishlist_shares_active ON wishlist_shares(shared_with_user_id, created_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_urgent_notifications_user_active ON urgent_notifications(user_id, created_at DESC) WHERE is_dismissed = false;
CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_active ON wishlist_collaborations(collaborator_id, created_at DESC) WHERE is_active = true;

-- =============================================
-- AUDIT TRIGGERS FOR SENSITIVE OPERATIONS
-- =============================================

-- Create audit log table for sensitive operations
CREATE TABLE IF NOT EXISTS security_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id),
    old_data JSONB,
    new_data JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on audit log
ALTER TABLE security_audit_log ENABLE ROW LEVEL SECURITY;

-- Only admins can view audit logs
CREATE POLICY "Only admins view audit logs" ON security_audit_log
    FOR SELECT USING (is_verified_admin());

-- Only system can write audit logs
CREATE POLICY "Only system writes audit logs" ON security_audit_log
    FOR INSERT WITH CHECK (auth.role() = 'service_role');

COMMIT;