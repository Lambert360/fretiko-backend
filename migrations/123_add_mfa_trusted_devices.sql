-- "Remember this device" support for MFA: after a successful TOTP
-- verification, the app may register a trusted device token so future
-- sign-ins from that same device skip the MFA challenge until it expires.
-- Tokens are stored hashed, never in plaintext. Run this once in the
-- Supabase SQL Editor for the target project.

CREATE TABLE IF NOT EXISTS public.mfa_trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_token_hash TEXT NOT NULL,
  device_name TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mfa_trusted_devices_user_id_idx ON public.mfa_trusted_devices(user_id);

ALTER TABLE public.mfa_trusted_devices ENABLE ROW LEVEL SECURITY;

-- Only the service role (used exclusively by the backend) touches this
-- table; no direct client access is needed or granted.
