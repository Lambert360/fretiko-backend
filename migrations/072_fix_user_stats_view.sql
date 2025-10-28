-- Migration: Fix user_stats table to correctly count plugs (following) and clients (followers)
-- Date: 2025-01-19
-- Description:
--   This is a pure follower/following system for statistics display on profile
--   - Plugs = People I'm following (where I am the requester)
--   - Clients = People following me (where I am the addressee)
--   NOTE: This does NOT include purchase/patronage data - that's only for the connections list screen
--
--   Note: user_stats is a TABLE (not a view) since migration 006, so we update the refresh function

-- Update the refresh_user_stats function with correct logic
CREATE OR REPLACE FUNCTION refresh_user_stats(target_user_id UUID DEFAULT NULL)
RETURNS void AS $$
BEGIN
    -- If target_user_id is provided, refresh only that user's stats
    -- Otherwise, refresh all users' stats

    IF target_user_id IS NOT NULL THEN
        -- Refresh specific user's stats with CORRECT logic
        INSERT INTO user_stats (id, plugs_count, clients_count, connection_requests_count)
        SELECT
            u.id,
            -- Plugs: Count connections where THIS user is the requester (I am following them)
            COALESCE(plugs.count, 0) as plugs_count,
            -- Clients: Count connections where THIS user is the addressee (they are following me)
            COALESCE(clients.count, 0) as clients_count,
            -- Connection requests: Pending requests where THIS user is the addressee
            COALESCE(connection_requests.count, 0) as connection_requests_count
        FROM user_profiles u
        -- Plugs: People I'm following (I am the requester, connection accepted)
        LEFT JOIN (
            SELECT
                requester_id as user_id,
                COUNT(*) as count
            FROM user_connections
            WHERE status = 'accepted'
            GROUP BY requester_id
        ) plugs ON plugs.user_id = u.id
        -- Clients: People following me (I am the addressee, connection accepted)
        LEFT JOIN (
            SELECT
                addressee_id as user_id,
                COUNT(*) as count
            FROM user_connections
            WHERE status = 'accepted'
            GROUP BY addressee_id
        ) clients ON clients.user_id = u.id
        -- Pending connection requests (I am the addressee, status pending)
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
        -- Refresh all users' stats with CORRECT logic
        INSERT INTO user_stats (id, plugs_count, clients_count, connection_requests_count)
        SELECT
            u.id,
            -- Plugs: Count connections where THIS user is the requester (I am following them)
            COALESCE(plugs.count, 0) as plugs_count,
            -- Clients: Count connections where THIS user is the addressee (they are following me)
            COALESCE(clients.count, 0) as clients_count,
            -- Connection requests: Pending requests where THIS user is the addressee
            COALESCE(connection_requests.count, 0) as connection_requests_count
        FROM user_profiles u
        -- Plugs: People I'm following (I am the requester, connection accepted)
        LEFT JOIN (
            SELECT
                requester_id as user_id,
                COUNT(*) as count
            FROM user_connections
            WHERE status = 'accepted'
            GROUP BY requester_id
        ) plugs ON plugs.user_id = u.id
        -- Clients: People following me (I am the addressee, connection accepted)
        LEFT JOIN (
            SELECT
                addressee_id as user_id,
                COUNT(*) as count
            FROM user_connections
            WHERE status = 'accepted'
            GROUP BY addressee_id
        ) clients ON clients.user_id = u.id
        -- Pending connection requests (I am the addressee, status pending)
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

-- Refresh all user stats with the corrected logic
SELECT refresh_user_stats();

COMMIT;
