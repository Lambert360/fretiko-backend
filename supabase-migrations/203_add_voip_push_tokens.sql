-- Add support for iOS VoIP (PushKit) push tokens used for call notifications.
-- These tokens are separate from regular Expo push tokens because APNs requires
-- direct HTTP/2 delivery for the `com.apple.pushkit` payload.

alter table if exists notification_settings
add column if not exists voip_push_tokens text[] default '{}';
