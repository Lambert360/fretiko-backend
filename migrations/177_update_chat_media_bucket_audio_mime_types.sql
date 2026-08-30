-- Update chat-media storage bucket to allow additional audio MIME types
-- iOS voice recordings (expo-audio) report m4a files as audio/x-m4a, which was
-- missing from the original bucket allowlist created in 059_create_chat_media_bucket.sql
-- Run this in Supabase SQL Editor

BEGIN;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/mov', 'video/avi', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/x-m4a', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/mpeg',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain'
]
WHERE id = 'chat-media';

COMMIT;
