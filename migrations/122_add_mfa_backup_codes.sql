-- Backup (recovery) codes for MFA: lets a user regain access if they lose
-- their authenticator device. Codes are stored bcrypt-hashed, never in
-- plaintext, and each one is single-use. Run this once in the Supabase SQL
-- Editor for the target project.

CREATE TABLE IF NOT EXISTS public.mfa_backup_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mfa_backup_codes_user_id_idx ON public.mfa_backup_codes(user_id);

ALTER TABLE public.mfa_backup_codes ENABLE ROW LEVEL SECURITY;

-- Only the service role (used exclusively by the backend) touches this
-- table; no direct client access is needed or granted.
