-- Migration: Add Iko AI preferences and context to user_profiles
-- Run this in Supabase SQL Editor

BEGIN;

-- Add Iko-specific columns to user_profiles table
ALTER TABLE public.user_profiles
ADD COLUMN IF NOT EXISTS iko_preferences JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS iko_context JSONB DEFAULT '{}';

-- Add helpful comments
COMMENT ON COLUMN public.user_profiles.iko_preferences IS 'Iko AI user preferences including budget ranges, favorite categories, communication style, etc.';
COMMENT ON COLUMN public.user_profiles.iko_context IS 'Iko AI conversation context including last interaction, ongoing plans, learned patterns, etc.';

-- Create indexes for better performance on JSONB columns
CREATE INDEX IF NOT EXISTS user_profiles_iko_preferences_idx ON public.user_profiles USING GIN (iko_preferences);
CREATE INDEX IF NOT EXISTS user_profiles_iko_context_idx ON public.user_profiles USING GIN (iko_context);

-- Update RLS policies to include new columns
-- The existing policies already cover these columns since they're part of the user_profiles table

-- Initialize default Iko preferences for existing users
UPDATE public.user_profiles
SET iko_preferences = '{
  "budget_ranges": {},
  "favorite_categories": [],
  "preferred_times": {},
  "communication_style": "friendly",
  "location_preferences": "nearby",
  "notification_preferences": {
    "proactive_suggestions": false,
    "price_alerts": false,
    "plan_reminders": false
  }
}'::jsonb,
iko_context = '{
  "first_interaction": true,
  "last_conversation": null,
  "ongoing_plans": [],
  "learned_patterns": {},
  "conversation_count": 0,
  "preferences_learned": false
}'::jsonb
WHERE iko_preferences = '{}' OR iko_preferences IS NULL;

COMMIT;