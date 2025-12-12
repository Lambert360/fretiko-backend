-- Migration: Create reconciliation_alerts table for tracking exchange rate fallback usage
-- This table stores alerts when fallback exchange rates are used instead of Flutterwave's actual rates
-- These alerts help admins track and reconcile potential discrepancies in deposit conversions

BEGIN;

-- Create reconciliation_alerts table
CREATE TABLE IF NOT EXISTS reconciliation_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Related deposit information
    deposit_id UUID NOT NULL REFERENCES deposits(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Exchange rate information
    local_amount DECIMAL(18,6) NOT NULL,
    local_currency VARCHAR(10) NOT NULL,
    fallback_rate_used DECIMAL(18,6) NOT NULL, -- The fallback rate that was used
    estimated_freti_amount DECIMAL(18,6) NOT NULL, -- Amount credited using fallback rate
    actual_freti_amount DECIMAL(18,6), -- Actual amount from Flutterwave (if available later)
    actual_rate DECIMAL(18,6), -- Actual rate from Flutterwave (if available later)
    
    -- Discrepancy calculation
    amount_discrepancy DECIMAL(18,6), -- Difference: actual - estimated (positive = user got less, negative = user got more)
    discrepancy_percentage DECIMAL(10,4), -- Percentage difference
    
    -- Alert details
    alert_type VARCHAR(50) NOT NULL DEFAULT 'exchange_rate_fallback', -- Type of alert
    alert_severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (alert_severity IN ('low', 'medium', 'high', 'critical')),
    alert_reason TEXT NOT NULL, -- Why fallback was used (e.g., "Flutterwave verification failed", "No transaction ID")
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
    
    -- Resolution information
    resolved_by UUID REFERENCES user_profiles(id), -- Admin who resolved it
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolution_notes TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}', -- Additional context (verification errors, webhook data, etc.)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_deposit_id ON reconciliation_alerts(deposit_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_user_id ON reconciliation_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_status ON reconciliation_alerts(status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_created_at ON reconciliation_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_severity ON reconciliation_alerts(alert_severity);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_pending ON reconciliation_alerts(status, created_at DESC) WHERE status = 'pending';

-- Enable Row Level Security
ALTER TABLE reconciliation_alerts ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Only admins and staff with view_revenue permission can view reconciliation alerts
CREATE POLICY "Admins can view all reconciliation alerts" ON reconciliation_alerts
    FOR SELECT
    USING (
        -- Regular admins via user_profiles
        EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid()
            AND preferences->>'isAdmin' = 'true'
        )
        OR
        -- Staff accounts with view_revenue permission
        EXISTS (
            SELECT 1 FROM staff_accounts s
            LEFT JOIN departments d ON s.department_id = d.id
            WHERE s.id = auth.uid()
            AND s.is_active = true
            AND (
                s.role = 'super_admin'
                OR d.permissions ? 'view_revenue'
            )
        )
    );

-- Only service role can insert reconciliation alerts (system-generated)
CREATE POLICY "Service role can insert reconciliation alerts" ON reconciliation_alerts
    FOR INSERT
    WITH CHECK (auth.role() = 'service_role');

-- Only admins can update reconciliation alerts (for resolution)
CREATE POLICY "Admins can update reconciliation alerts" ON reconciliation_alerts
    FOR UPDATE
    USING (
        -- Regular admins via user_profiles
        EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid()
            AND preferences->>'isAdmin' = 'true'
        )
        OR
        -- Staff accounts with view_revenue permission
        EXISTS (
            SELECT 1 FROM staff_accounts s
            LEFT JOIN departments d ON s.department_id = d.id
            WHERE s.id = auth.uid()
            AND s.is_active = true
            AND (
                s.role = 'super_admin'
                OR d.permissions ? 'view_revenue'
            )
        )
    );

-- Grant permissions
GRANT SELECT, UPDATE ON reconciliation_alerts TO authenticated;
GRANT ALL ON reconciliation_alerts TO service_role;

-- Add comment
COMMENT ON TABLE reconciliation_alerts IS 'Tracks alerts when fallback exchange rates are used for deposits, requiring admin review and reconciliation';
COMMENT ON COLUMN reconciliation_alerts.amount_discrepancy IS 'Positive = user received less than Flutterwave converted, Negative = user received more';
COMMENT ON COLUMN reconciliation_alerts.alert_severity IS 'Severity based on discrepancy amount: low < 1 FRETI, medium 1-10 FRETI, high 10-100 FRETI, critical > 100 FRETI';

COMMIT;

