-- Migration: Expand notifications.type constraint for auction/dispute/schedule types
-- Description: The auction, dispute, fraud-detection, admin and schedule-reminder
--   code paths insert notification types that were never added to the CHECK
--   constraint (last defined in migration 123). Those inserts have been failing
--   silently with 23514 — in-app rows were never created, and funnel types like
--   'schedule' lost push/email too. This adds every type the codebase emits.
--   Deliberately excluded: 'push'/'email'/'sms' — those were channel stubs in
--   rider-notification.service.ts, not real notification types.
-- Date: 2026-02-10

BEGIN;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
CHECK (type IN (
  -- original set (migrations 068/123)
  'order',
  'social',
  'connection_request',
  'connection_accepted',
  'promotion',
  'system',
  'delivery',
  'live',
  'payment',
  'chat',
  'ai_checkin',
  'ai_reminder',
  'ai_engagement',
  'user_warning',
  -- schedule reminders (notification-helper.service.ts)
  'schedule',
  -- disputes (disputes.service.ts)
  'dispute',
  -- auctions (auctions.service.ts, auction-scheduler.service.ts)
  'new_bid',
  'outbid',
  'auction_started',
  'auction_ended',
  'auction_extended',
  'auction_won',
  'auction_item_won',
  'auction_sold',
  'auction_win_forfeited',
  'auction_win_expired',
  'auction_sale_failed',
  -- fraud + admin tooling (fraud-detection.service.ts, admin.service.ts)
  'fraud_alert',
  'bid_invalidated'
));

COMMENT ON COLUMN notifications.type IS 'Notification type: order, social, connection_request, connection_accepted, promotion, system, delivery, live, payment, chat, ai_checkin, ai_reminder, ai_engagement, user_warning, schedule, dispute, new_bid, outbid, auction_started, auction_ended, auction_extended, auction_won, auction_item_won, auction_sold, auction_win_forfeited, auction_win_expired, auction_sale_failed, fraud_alert, bid_invalidated';

COMMIT;
