-- Migration: Fix clients_count to include both followers AND patrons (buyers)
-- Date: 2026-08-04
-- Description:
--   Migration 072 redefined "Clients" as a pure follower count (people
--   following me, where I am the addressee), which does NOT match what the
--   ConnectionsListScreen actually shows under the "Clients" tab: it already
--   displays TWO sections - "Followers" (from user_connections) AND
--   "Patronage" (from client_relationships, people who bought from me).
--
--   This migration makes clients_count the DISTINCT union of both groups, so
--   the profile/store stat number matches what tapping into it reveals.
--   A user who both follows me AND has bought from me is only counted once.
--
--   - Plugs   = People I'm following (where I am the requester) - UNCHANGED
--   - Clients = DISTINCT(people following me) + (people who bought from me)
--   - Connection requests = Pending requests where I am the addressee - UNCHANGED

-- Update the refresh_user_stats function with corrected clients_count logic
CREATE OR REPLACE FUNCTION public.refresh_user_stats(target_user_id UUID DEFAULT NULL)
RETURNS void AS $$
BEGIN
    -- If target_user_id is provided, refresh only that user's stats
    -- Otherwise, refresh all users' stats

    IF target_user_id IS NOT NULL THEN
        -- Refresh specific user's stats with CORRECT logic
        INSERT INTO public.user_stats (id, plugs_count, clients_count, connection_requests_count)
        SELECT
            u.id,
            -- Plugs: Count connections where THIS user is the requester (I am following them)
            COALESCE(plugs.count, 0) as plugs_count,
            -- Clients: DISTINCT union of followers + patrons (buyers)
            COALESCE(clients.count, 0) as clients_count,
            -- Connection requests: Pending requests where THIS user is the addressee
            COALESCE(connection_requests.count, 0) as connection_requests_count
        FROM public.user_profiles u
        -- Plugs: People I'm following (I am the requester, connection accepted)
        LEFT JOIN (
            SELECT
                requester_id as user_id,
                COUNT(*) as count
            FROM public.user_connections
            WHERE status = 'accepted'
            GROUP BY requester_id
        ) plugs ON plugs.user_id = u.id
        -- Clients: People following me (accepted) UNIONed with people who bought
        -- from me (client_relationships). The UNIQUE constraints on
        -- (requester_id, addressee_id) and (provider_id, client_id) mean UNION
        -- will correctly remove only the exact cross-source duplicates, so a
        -- person who both follows me and has bought from me is only counted once.
        LEFT JOIN (
            SELECT
                user_id,
                COUNT(*) as count
            FROM (
                -- Followers: I am the addressee of an accepted connection
                SELECT addressee_id AS user_id, requester_id AS client_user_id
                FROM public.user_connections
                WHERE status = 'accepted'

                UNION

                -- Patrons: I am the provider in a client relationship (they bought from me)
                SELECT provider_id AS user_id, client_id AS client_user_id
                FROM public.client_relationships
            ) combined_clients
            GROUP BY user_id
        ) clients ON clients.user_id = u.id
        -- Pending connection requests (I am the addressee, status pending)
        LEFT JOIN (
            SELECT
                addressee_id as user_id,
                COUNT(*) as count
            FROM public.user_connections
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
        INSERT INTO public.user_stats (id, plugs_count, clients_count, connection_requests_count)
        SELECT
            u.id,
            -- Plugs: Count connections where THIS user is the requester (I am following them)
            COALESCE(plugs.count, 0) as plugs_count,
            -- Clients: DISTINCT union of followers + patrons (buyers)
            COALESCE(clients.count, 0) as clients_count,
            -- Connection requests: Pending requests where THIS user is the addressee
            COALESCE(connection_requests.count, 0) as connection_requests_count
        FROM public.user_profiles u
        -- Plugs: People I'm following (I am the requester, connection accepted)
        LEFT JOIN (
            SELECT
                requester_id as user_id,
                COUNT(*) as count
            FROM public.user_connections
            WHERE status = 'accepted'
            GROUP BY requester_id
        ) plugs ON plugs.user_id = u.id
        -- Clients: People following me (accepted) UNIONed with people who bought
        -- from me (client_relationships). The UNIQUE constraints on
        -- (requester_id, addressee_id) and (provider_id, client_id) mean UNION
        -- will correctly remove only the exact cross-source duplicates, so a
        -- person who both follows me and has bought from me is only counted once.
        LEFT JOIN (
            SELECT
                user_id,
                COUNT(*) as count
            FROM (
                -- Followers: I am the addressee of an accepted connection
                SELECT addressee_id AS user_id, requester_id AS client_user_id
                FROM public.user_connections
                WHERE status = 'accepted'

                UNION

                -- Patrons: I am the provider in a client relationship (they bought from me)
                SELECT provider_id AS user_id, client_id AS client_user_id
                FROM public.client_relationships
            ) combined_clients
            GROUP BY user_id
        ) clients ON clients.user_id = u.id
        -- Pending connection requests (I am the addressee, status pending)
        LEFT JOIN (
            SELECT
                addressee_id as user_id,
                COUNT(*) as count
            FROM public.user_connections
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

-- Refresh all user stats with the corrected logic so existing rows are
-- backfilled immediately, not just on the next connection/purchase event.
SELECT public.refresh_user_stats();

COMMIT;
