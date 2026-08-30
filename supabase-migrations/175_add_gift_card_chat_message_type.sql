-- =====================================================
-- Migration: 175
-- Fix: Add 'gift_card' as a valid chat_messages.message_type
-- Description:
--   chat_messages.message_type is backed by a native Postgres ENUM
--   type `message_type`. Live DB enum values (verified via
--   `SELECT enum_range(NULL::message_type);`):
--     text, image, audio, video, file, livestream, auction, system,
--     call, invoice, wishlist
--
--   Verified there is currently NO CHECK constraint named
--   `chat_messages_message_type_check` on the live database
--   (the one added in migrations/064 did not persist / was
--   removed at some point) — the enum type is the only active
--   restriction. We intentionally do NOT reintroduce that CHECK
--   constraint here, since keeping a second, easily-forgotten
--   allow-list in sync with the enum is exactly what caused this
--   bug (gift_card / wishlist were added to app code but never to
--   that constraint).
--
--   Gift card chat messages (src/gift-cards/gift-cards.service.ts
--   sendGiftCardChatMessage) insert message_type = 'gift_card',
--   which is not yet a valid enum value. The insert fails with a
--   Postgres "invalid input value for enum message_type" error.
--   That error is caught and only logged (not surfaced) in
--   sendGiftCardChatMessage's catch block, so the gift card message
--   silently never gets created in the conversation.
--
--   This migration adds 'gift_card' to the enum so the insert
--   succeeds.
-- =====================================================

-- Must run as a standalone statement (not combined with other
-- statements that use the new value in the same transaction).
ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'gift_card';

DO $$
BEGIN
  RAISE NOTICE '✅ Added "gift_card" to message_type enum';
END $$;
