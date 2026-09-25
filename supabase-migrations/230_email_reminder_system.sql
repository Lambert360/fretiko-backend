BEGIN;

-- =====================================================
-- MIGRATION: 230
-- Email reminder system
--
-- Why:
--   The platform already sends in-app + push notifications for auction
--   wins, expiring checkout windows, orders and escrow, but users who
--   are not in the app never see them. This adds the database backing
--   for transactional email reminders sent through Resend.
--
-- What it does:
--   1. Adds per-category email opt-out columns to notification_settings
--      (email_enabled already exists on some deployments — IF NOT EXISTS
--      keeps this idempotent either way).
--   2. Creates email_reminders, a dedup log keyed on
--      (user_id, reminder_type, entity_type, entity_id) so scheduled
--      sweeps never send the same reminder twice for the same entity.
--      reminder_type values used by the backend:
--        auction_won, auction_win_checkout_24h, auction_win_checkout_final,
--        auction_win_expired, auction_win_forfeited, auction_sale_failed,
--        auction_ending_soon, outbid, escrow_auto_release,
--        order_pending_vendor, order_confirm_receipt
-- =====================================================

ALTER TABLE public.notification_settings
  ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_auction_notifications BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_order_notifications BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_payment_notifications BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_delivery_notifications BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_promotion_notifications BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_live_notifications BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_social_notifications BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_system_notifications BOOLEAN DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS public.email_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,

  -- What was sent and which entity it was about
  reminder_type VARCHAR(60) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,   -- 'auction', 'auction_win', 'order', 'escrow'
  entity_id UUID NOT NULL,

  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One reminder of a given type per user per entity; cooldown resends
  -- (e.g. outbid) reuse the row by bumping sent_at
  UNIQUE (user_id, reminder_type, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_email_reminders_user_id ON public.email_reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_email_reminders_entity ON public.email_reminders(entity_type, entity_id);

ALTER TABLE public.email_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own email reminders" ON public.email_reminders;
CREATE POLICY "Users can view own email reminders" ON public.email_reminders
    FOR SELECT USING (auth.uid() = user_id);

GRANT SELECT ON public.email_reminders TO authenticated;
GRANT ALL ON public.email_reminders TO service_role;

COMMIT;
