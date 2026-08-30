-- Create schedule_reminders table for automated calendar reminders
-- This table tracks reminder notifications for service bookings

CREATE TABLE IF NOT EXISTS schedule_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  buyer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('daily_digest', 'hourly_reminder', 'booking_confirmation')),
  scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_schedule_reminders_order ON schedule_reminders(order_id);
CREATE INDEX IF NOT EXISTS idx_schedule_reminders_vendor ON schedule_reminders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_schedule_reminders_buyer ON schedule_reminders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_schedule_reminders_scheduled_for ON schedule_reminders(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_schedule_reminders_status ON schedule_reminders(status);
CREATE INDEX IF NOT EXISTS idx_schedule_reminders_type_status ON schedule_reminders(reminder_type, status);

-- Add RLS policies
ALTER TABLE schedule_reminders ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role full access on schedule_reminders"
  ON schedule_reminders
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Users can only see their own reminders
CREATE POLICY "Users can view own reminders"
  ON schedule_reminders
  FOR SELECT
  TO authenticated
  USING (vendor_id = auth.uid() OR buyer_id = auth.uid());

-- Users can insert reminders for their own orders
CREATE POLICY "Users can insert own reminders"
  ON schedule_reminders
  FOR INSERT
  TO authenticated
  WITH CHECK (vendor_id = auth.uid() OR buyer_id = auth.uid());

-- Users can update status of their own reminders
CREATE POLICY "Users can update own reminders"
  ON schedule_reminders
  FOR UPDATE
  TO authenticated
  USING (vendor_id = auth.uid() OR buyer_id = auth.uid());

-- Users can delete their own reminders
CREATE POLICY "Users can delete own reminders"
  ON schedule_reminders
  FOR DELETE
  TO authenticated
  USING (vendor_id = auth.uid() OR buyer_id = auth.uid());

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_schedule_reminders_updated_at
  BEFORE UPDATE ON schedule_reminders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
