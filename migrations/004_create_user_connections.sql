-- Migration: Create user connections and client relationships tables
-- Date: 2025-08-27
-- Description: Add tables for user social connections and business client relationships

-- User connections table for "plugs" (social connections)
CREATE TABLE user_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')) DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Prevent duplicate connections
  UNIQUE(requester_id, addressee_id)
);

-- Client relationships table for vendor/rider business connections
CREATE TABLE client_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE, -- vendor or rider
  client_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  relationship_type VARCHAR(20) NOT NULL CHECK (relationship_type IN ('customer', 'regular_client')) DEFAULT 'customer',
  total_orders INTEGER DEFAULT 0,
  total_spent DECIMAL(10,2) DEFAULT 0.00,
  last_interaction TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Prevent duplicate relationships
  UNIQUE(provider_id, client_id)
);

-- Indexes for performance
CREATE INDEX idx_user_connections_requester ON user_connections(requester_id);
CREATE INDEX idx_user_connections_addressee ON user_connections(addressee_id);
CREATE INDEX idx_user_connections_status ON user_connections(status);

CREATE INDEX idx_client_relationships_provider ON client_relationships(provider_id);
CREATE INDEX idx_client_relationships_client ON client_relationships(client_id);
CREATE INDEX idx_client_relationships_type ON client_relationships(relationship_type);

-- Functions to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_user_connections_updated_at 
    BEFORE UPDATE ON user_connections 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Views for easy stats querying
CREATE VIEW user_stats AS
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