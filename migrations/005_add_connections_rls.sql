-- Migration: Add Row Level Security (RLS) policies for connections tables
-- Date: 2025-08-27
-- Description: Secure user connections and client relationships with proper RLS policies

-- Enable RLS on user_connections table
ALTER TABLE user_connections ENABLE ROW LEVEL SECURITY;

-- Enable RLS on client_relationships table  
ALTER TABLE client_relationships ENABLE ROW LEVEL SECURITY;

-- ===== USER_CONNECTIONS RLS POLICIES =====

-- Policy 1: Users can view connections where they are involved (either requester or addressee)
CREATE POLICY "Users can view their own connections" ON user_connections
    FOR SELECT USING (
        auth.uid() = requester_id OR 
        auth.uid() = addressee_id
    );

-- Policy 2: Users can create connection requests (as requester only)
CREATE POLICY "Users can send connection requests" ON user_connections
    FOR INSERT WITH CHECK (
        auth.uid() = requester_id AND 
        auth.uid() != addressee_id  -- Prevent self-connections
    );

-- Policy 3: Only the addressee can update connection status (accept/reject)
CREATE POLICY "Addressees can update connection status" ON user_connections
    FOR UPDATE USING (
        auth.uid() = addressee_id
    ) WITH CHECK (
        auth.uid() = addressee_id
    );

-- Policy 4: Users can delete connections they're involved in
CREATE POLICY "Users can delete their connections" ON user_connections
    FOR DELETE USING (
        auth.uid() = requester_id OR 
        auth.uid() = addressee_id
    );

-- ===== CLIENT_RELATIONSHIPS RLS POLICIES =====

-- Policy 1: Providers (vendors/riders) can view all their client relationships
CREATE POLICY "Providers can view their client relationships" ON client_relationships
    FOR SELECT USING (
        auth.uid() = provider_id
    );

-- Policy 2: Clients can view relationships where they are the client
CREATE POLICY "Clients can view their provider relationships" ON client_relationships
    FOR SELECT USING (
        auth.uid() = client_id
    );

-- Policy 3: Only providers can create client relationships
CREATE POLICY "Providers can create client relationships" ON client_relationships
    FOR INSERT WITH CHECK (
        auth.uid() = provider_id AND
        auth.uid() != client_id  -- Prevent self-client relationships
    );

-- Policy 4: Only providers can update their client relationships
CREATE POLICY "Providers can update client relationships" ON client_relationships
    FOR UPDATE USING (
        auth.uid() = provider_id
    ) WITH CHECK (
        auth.uid() = provider_id
    );

-- Policy 5: Only providers can delete client relationships
CREATE POLICY "Providers can delete client relationships" ON client_relationships
    FOR DELETE USING (
        auth.uid() = provider_id
    );

-- ===== USER_STATS VIEW ACCESS =====
-- Note: Views inherit RLS from underlying tables, but we can add explicit policies if needed

-- Create a policy for user_stats view (optional - for explicit control)
-- This allows users to view their own stats and public stats of others
CREATE OR REPLACE VIEW user_stats AS
SELECT 
    u.id,
    COALESCE(plugs.count, 0) as plugs_count,
    COALESCE(clients.count, 0) as clients_count,
    COALESCE(connections_as_addressee.count, 0) as connection_requests_count
FROM user_profiles u
LEFT JOIN (
    SELECT 
        requester_id as user_id,
        COUNT(*) as count
    FROM user_connections 
    WHERE status = 'accepted'
    GROUP BY requester_id
    UNION ALL
    SELECT 
        addressee_id as user_id,
        COUNT(*) as count
    FROM user_connections 
    WHERE status = 'accepted'
    GROUP BY addressee_id
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
) connections_as_addressee ON connections_as_addressee.user_id = u.id
GROUP BY u.id, plugs.count, clients.count, connections_as_addressee.count;

-- Grant SELECT permission on user_stats view to authenticated users
GRANT SELECT ON user_stats TO authenticated;

-- ===== ADDITIONAL SECURITY MEASURES =====

-- Create function to check if user can access another user's connection requests
CREATE OR REPLACE FUNCTION can_view_connection_requests(target_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    -- Only the user themselves can see their pending connection requests
    RETURN auth.uid() = target_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to validate connection request
CREATE OR REPLACE FUNCTION validate_connection_request(addressee_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    -- Prevent duplicate connections
    IF EXISTS (
        SELECT 1 FROM user_connections 
        WHERE (requester_id = auth.uid() AND user_connections.addressee_id = validate_connection_request.addressee_id)
           OR (requester_id = validate_connection_request.addressee_id AND user_connections.addressee_id = auth.uid())
    ) THEN
        RETURN FALSE;
    END IF;
    
    -- Ensure target user exists
    IF NOT EXISTS (SELECT 1 FROM user_profiles WHERE id = validate_connection_request.addressee_id) THEN
        RETURN FALSE;
    END IF;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===== GRANT PERMISSIONS =====

-- Grant necessary permissions to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON user_connections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON client_relationships TO authenticated;

-- Grant usage on sequences (for ID generation)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMIT;

-- Test the policies (optional - you can run these to verify)
-- SELECT * FROM user_connections;  -- Should only show your connections
-- SELECT * FROM client_relationships;  -- Should only show your relationships  
-- SELECT * FROM user_stats WHERE id = auth.uid();  -- Should show your stats