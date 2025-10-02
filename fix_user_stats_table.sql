-- Fix missing user_stats table
-- This fixes the "relation 'user_stats' does not exist" error

-- 1. Create user_connections table if it doesn't exist (required for user_stats)
CREATE TABLE IF NOT EXISTS public.user_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    addressee_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked')),
    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(requester_id, addressee_id),
    CHECK (requester_id != addressee_id)
);

-- 2. Create client_relationships table if it doesn't exist (required for user_stats)
CREATE TABLE IF NOT EXISTS public.client_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    relationship_type VARCHAR(50) NOT NULL DEFAULT 'client',
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'blocked')),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(provider_id, client_id),
    CHECK (provider_id != client_id)
);

-- 3. Create user_stats table
CREATE TABLE IF NOT EXISTS public.user_stats (
    id UUID PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    plugs_count INTEGER DEFAULT 0,
    clients_count INTEGER DEFAULT 0,
    connection_requests_count INTEGER DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Enable RLS on all tables
ALTER TABLE public.user_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_stats ENABLE ROW LEVEL SECURITY;

-- 5. Create RLS policies for user_connections
DROP POLICY IF EXISTS "Users can view own connections" ON public.user_connections;
DROP POLICY IF EXISTS "Users can manage own connections" ON public.user_connections;

CREATE POLICY "Users can view own connections" ON public.user_connections
    FOR SELECT USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

CREATE POLICY "Users can manage own connections" ON public.user_connections
    FOR ALL USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

-- 6. Create RLS policies for client_relationships
DROP POLICY IF EXISTS "Users can view own client relationships" ON public.client_relationships;
DROP POLICY IF EXISTS "Users can manage own client relationships" ON public.client_relationships;

CREATE POLICY "Users can view own client relationships" ON public.client_relationships
    FOR SELECT USING (auth.uid() = provider_id OR auth.uid() = client_id);

CREATE POLICY "Users can manage own client relationships" ON public.client_relationships
    FOR ALL USING (auth.uid() = provider_id OR auth.uid() = client_id);

-- 7. Create RLS policies for user_stats
DROP POLICY IF EXISTS "Users can view their own stats" ON public.user_stats;
DROP POLICY IF EXISTS "Users can view public stats of others" ON public.user_stats;
DROP POLICY IF EXISTS "Service role can manage stats" ON public.user_stats;

CREATE POLICY "Users can view their own stats" ON public.user_stats
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can view public stats of others" ON public.user_stats
    FOR SELECT USING (true);

CREATE POLICY "Service role can manage stats" ON public.user_stats
    FOR ALL USING (auth.role() = 'service_role');

-- 8. Create function to refresh user stats
CREATE OR REPLACE FUNCTION public.refresh_user_stats(target_user_id UUID DEFAULT NULL)
RETURNS void AS $$
BEGIN
    -- If target_user_id is provided, refresh only that user's stats
    -- Otherwise, refresh all users' stats

    IF target_user_id IS NOT NULL THEN
        -- Refresh specific user's stats
        INSERT INTO public.user_stats (id, plugs_count, clients_count, connection_requests_count)
        SELECT
            u.id,
            COALESCE(plugs.count, 0) as plugs_count,
            COALESCE(clients.count, 0) as clients_count,
            COALESCE(connection_requests.count, 0) as connection_requests_count
        FROM public.user_profiles u
        LEFT JOIN (
            SELECT
                user_id,
                COUNT(*) as count
            FROM (
                SELECT requester_id as user_id FROM public.user_connections WHERE status = 'accepted'
                UNION ALL
                SELECT addressee_id as user_id FROM public.user_connections WHERE status = 'accepted'
            ) accepted_connections
            GROUP BY user_id
        ) plugs ON plugs.user_id = u.id
        LEFT JOIN (
            SELECT
                provider_id as user_id,
                COUNT(DISTINCT client_id) as count
            FROM public.client_relationships
            GROUP BY provider_id
        ) clients ON clients.user_id = u.id
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
        -- Refresh all users' stats
        INSERT INTO public.user_stats (id, plugs_count, clients_count, connection_requests_count)
        SELECT
            u.id,
            COALESCE(plugs.count, 0) as plugs_count,
            COALESCE(clients.count, 0) as clients_count,
            COALESCE(connection_requests.count, 0) as connection_requests_count
        FROM public.user_profiles u
        LEFT JOIN (
            SELECT
                user_id,
                COUNT(*) as count
            FROM (
                SELECT requester_id as user_id FROM public.user_connections WHERE status = 'accepted'
                UNION ALL
                SELECT addressee_id as user_id FROM public.user_connections WHERE status = 'accepted'
            ) accepted_connections
            GROUP BY user_id
        ) plugs ON plugs.user_id = u.id
        LEFT JOIN (
            SELECT
                provider_id as user_id,
                COUNT(DISTINCT client_id) as count
            FROM public.client_relationships
            GROUP BY provider_id
        ) clients ON clients.user_id = u.id
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

-- 9. Create trigger functions to auto-update stats when connections change
CREATE OR REPLACE FUNCTION public.trigger_refresh_connection_stats()
RETURNS TRIGGER AS $$
BEGIN
    -- Refresh stats for both users involved in the connection
    IF TG_OP = 'DELETE' THEN
        PERFORM public.refresh_user_stats(OLD.requester_id);
        PERFORM public.refresh_user_stats(OLD.addressee_id);
        RETURN OLD;
    ELSE
        PERFORM public.refresh_user_stats(NEW.requester_id);
        PERFORM public.refresh_user_stats(NEW.addressee_id);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.trigger_refresh_client_stats()
RETURNS TRIGGER AS $$
BEGIN
    -- Refresh stats for provider when client relationship changes
    IF TG_OP = 'DELETE' THEN
        PERFORM public.refresh_user_stats(OLD.provider_id);
        RETURN OLD;
    ELSE
        PERFORM public.refresh_user_stats(NEW.provider_id);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- 10. Create trigger to initialize stats for new users
CREATE OR REPLACE FUNCTION public.trigger_initialize_user_stats()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_stats (id) VALUES (NEW.id)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 11. Create triggers to auto-update stats
DROP TRIGGER IF EXISTS user_connections_stats_trigger ON public.user_connections;
CREATE TRIGGER user_connections_stats_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.user_connections
    FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_connection_stats();

DROP TRIGGER IF EXISTS client_relationships_stats_trigger ON public.client_relationships;
CREATE TRIGGER client_relationships_stats_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.client_relationships
    FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_client_stats();

DROP TRIGGER IF EXISTS initialize_user_stats_trigger ON public.user_profiles;
CREATE TRIGGER initialize_user_stats_trigger
    AFTER INSERT ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.trigger_initialize_user_stats();

-- 12. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_connections_requester ON public.user_connections(requester_id);
CREATE INDEX IF NOT EXISTS idx_user_connections_addressee ON public.user_connections(addressee_id);
CREATE INDEX IF NOT EXISTS idx_user_connections_status ON public.user_connections(status);
CREATE INDEX IF NOT EXISTS idx_client_relationships_provider ON public.client_relationships(provider_id);
CREATE INDEX IF NOT EXISTS idx_client_relationships_client ON public.client_relationships(client_id);
CREATE INDEX IF NOT EXISTS idx_user_stats_updated_at ON public.user_stats(updated_at DESC);

-- 13. Create updated_at triggers
DROP TRIGGER IF EXISTS update_user_connections_updated_at ON public.user_connections;
CREATE TRIGGER update_user_connections_updated_at
    BEFORE UPDATE ON public.user_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_client_relationships_updated_at ON public.client_relationships;
CREATE TRIGGER update_client_relationships_updated_at
    BEFORE UPDATE ON public.client_relationships
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_stats_updated_at ON public.user_stats;
CREATE TRIGGER update_user_stats_updated_at
    BEFORE UPDATE ON public.user_stats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 14. Initialize stats for existing users
INSERT INTO public.user_stats (id)
SELECT id FROM public.user_profiles
WHERE NOT EXISTS (
    SELECT 1 FROM public.user_stats
    WHERE user_stats.id = user_profiles.id
)
ON CONFLICT (id) DO NOTHING;

-- 15. Run initial stats calculation for all users
SELECT public.refresh_user_stats();

-- 16. Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_connections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_relationships TO authenticated;
GRANT SELECT ON public.user_stats TO authenticated;
GRANT ALL ON public.user_connections TO service_role;
GRANT ALL ON public.client_relationships TO service_role;
GRANT ALL ON public.user_stats TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_user_stats(UUID) TO service_role;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'User stats table and related components have been created successfully!';
    RAISE NOTICE 'User creation should now work without user_stats-related errors';
END $$;