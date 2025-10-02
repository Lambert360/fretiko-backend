-- Migration: Fix user_stats view RLS policies
-- Date: 2025-08-27
-- Description: Add proper RLS policies for user_stats view access

-- Drop the existing view to recreate it properly
DROP VIEW IF EXISTS user_stats;

-- Recreate user_stats as a table with RLS instead of a view
-- This gives us better control over access policies
CREATE TABLE user_stats (
    id UUID PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
    plugs_count INTEGER DEFAULT 0,
    clients_count INTEGER DEFAULT 0,
    connection_requests_count INTEGER DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on user_stats table
ALTER TABLE user_stats ENABLE ROW LEVEL SECURITY;

-- RLS Policy 1: Users can view their own stats
CREATE POLICY "Users can view their own stats" ON user_stats
    FOR SELECT USING (auth.uid() = id);

-- RLS Policy 2: Users can view public stats of others (plugs and clients only, not connection requests)
CREATE POLICY "Users can view public stats of others" ON user_stats
    FOR SELECT USING (true);  -- Allow read access to all stats for now, we'll filter sensitive data in the application

-- Only allow system/service to insert and update stats
CREATE POLICY "Service role can manage stats" ON user_stats
    FOR ALL USING (auth.role() = 'service_role');

-- Create function to refresh user stats
CREATE OR REPLACE FUNCTION refresh_user_stats(target_user_id UUID DEFAULT NULL)
RETURNS void AS $$
BEGIN
    -- If target_user_id is provided, refresh only that user's stats
    -- Otherwise, refresh all users' stats
    
    IF target_user_id IS NOT NULL THEN
        -- Refresh specific user's stats
        INSERT INTO user_stats (id, plugs_count, clients_count, connection_requests_count)
        SELECT 
            u.id,
            COALESCE(plugs.count, 0) as plugs_count,
            COALESCE(clients.count, 0) as clients_count,
            COALESCE(connection_requests.count, 0) as connection_requests_count
        FROM user_profiles u
        LEFT JOIN (
            SELECT 
                user_id,
                COUNT(*) as count
            FROM (
                SELECT requester_id as user_id FROM user_connections WHERE status = 'accepted'
                UNION ALL
                SELECT addressee_id as user_id FROM user_connections WHERE status = 'accepted'
            ) accepted_connections
            GROUP BY user_id
        ) plugs ON plugs.user_id = u.id
        LEFT JOIN (
            SELECT 
                provider_id as user_id,
                COUNT(DISTINCT client_id) as count
            FROM client_relationships
            GROUP BY provider_id
        ) clients ON clients.user_id = u.id
        LEFT JOIN (
            SELECT 
                addressee_id as user_id,
                COUNT(*) as count
            FROM user_connections 
            WHERE status = 'pending'
            GROUP BY addressee_id
        ) connection_requests ON connection_requests.user_id = u.id
        WHERE u.id = target_user_id
        ON CONFLICT (id) DO UPDATE SET
            plugs_count = EXCLUDED.plugs_count,
            clients_count = EXCLUDED.clients_count,
            connection_requests_count = EXCLUDED.connection_requests_count,
            updated_at = NOW();
    ELSE
        -- Refresh all users' stats
        INSERT INTO user_stats (id, plugs_count, clients_count, connection_requests_count)
        SELECT 
            u.id,
            COALESCE(plugs.count, 0) as plugs_count,
            COALESCE(clients.count, 0) as clients_count,
            COALESCE(connection_requests.count, 0) as connection_requests_count
        FROM user_profiles u
        LEFT JOIN (
            SELECT 
                user_id,
                COUNT(*) as count
            FROM (
                SELECT requester_id as user_id FROM user_connections WHERE status = 'accepted'
                UNION ALL
                SELECT addressee_id as user_id FROM user_connections WHERE status = 'accepted'
            ) accepted_connections
            GROUP BY user_id
        ) plugs ON plugs.user_id = u.id
        LEFT JOIN (
            SELECT 
                provider_id as user_id,
                COUNT(DISTINCT client_id) as count
            FROM client_relationships
            GROUP BY provider_id
        ) clients ON clients.user_id = u.id
        LEFT JOIN (
            SELECT 
                addressee_id as user_id,
                COUNT(*) as count
            FROM user_connections 
            WHERE status = 'pending'
            GROUP BY addressee_id
        ) connection_requests ON connection_requests.user_id = u.id
        ON CONFLICT (id) DO UPDATE SET
            plugs_count = EXCLUDED.plugs_count,
            clients_count = EXCLUDED.clients_count,
            connection_requests_count = EXCLUDED.connection_requests_count,
            updated_at = NOW();
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger functions to auto-update stats when connections change
CREATE OR REPLACE FUNCTION trigger_refresh_connection_stats()
RETURNS TRIGGER AS $$
BEGIN
    -- Refresh stats for both users involved in the connection
    IF TG_OP = 'DELETE' THEN
        PERFORM refresh_user_stats(OLD.requester_id);
        PERFORM refresh_user_stats(OLD.addressee_id);
        RETURN OLD;
    ELSE
        PERFORM refresh_user_stats(NEW.requester_id);
        PERFORM refresh_user_stats(NEW.addressee_id);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trigger_refresh_client_stats()
RETURNS TRIGGER AS $$
BEGIN
    -- Refresh stats for provider when client relationship changes
    IF TG_OP = 'DELETE' THEN
        PERFORM refresh_user_stats(OLD.provider_id);
        RETURN OLD;
    ELSE
        PERFORM refresh_user_stats(NEW.provider_id);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Create triggers to auto-update stats
CREATE TRIGGER user_connections_stats_trigger
    AFTER INSERT OR UPDATE OR DELETE ON user_connections
    FOR EACH ROW EXECUTE FUNCTION trigger_refresh_connection_stats();

CREATE TRIGGER client_relationships_stats_trigger
    AFTER INSERT OR UPDATE OR DELETE ON client_relationships
    FOR EACH ROW EXECUTE FUNCTION trigger_refresh_client_stats();

-- Create trigger to initialize stats for new users
CREATE OR REPLACE FUNCTION trigger_initialize_user_stats()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_stats (id) VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER initialize_user_stats_trigger
    AFTER INSERT ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION trigger_initialize_user_stats();

-- Initialize stats for existing users
INSERT INTO user_stats (id)
SELECT id FROM user_profiles
ON CONFLICT (id) DO NOTHING;

-- Run initial stats calculation for all users
SELECT refresh_user_stats();

-- Grant permissions
GRANT SELECT ON user_stats TO authenticated;
GRANT EXECUTE ON FUNCTION refresh_user_stats(UUID) TO service_role;

COMMIT;