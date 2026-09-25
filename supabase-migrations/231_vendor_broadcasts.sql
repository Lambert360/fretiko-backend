BEGIN;

-- =====================================================
-- MIGRATION: 231
-- Admin vendor broadcasts (promotional email + push + in-app)
--
-- Why:
--   Admins need a way to send promotional nudges to vendors (e.g.
--   "have you uploaded a product today", "customers are looking for
--   a blue jacket") from the admin panel, plus optional recurring
--   auto-sends (every N days). Delivery reuses the existing
--   notification funnel (type='promotion') so in-app, push and email
--   channels all respect the user's existing opt-out preferences.
--
-- What it does:
--   1. broadcast_templates — reusable message templates with
--      {{name}} / {{custom1}} variables, per-channel toggles,
--      audience, suppression window and optional auto-send cadence.
--   2. broadcast_sends — one row per campaign (manual or auto),
--      snapshotting the rendered content plus targeted/sent/
--      suppressed/failed counters.
--
-- Dedup:
--   Per-user delivery dedup for the email leg reuses
--   email_reminders with reminder_type='broadcast' and
--   entity_id = broadcast_sends.id. The in-app notification row
--   (type='promotion', data.broadcast_send_id) is the record for
--   push/in-app delivery and the global frequency-cap check.
-- =====================================================

CREATE TABLE IF NOT EXISTS public.broadcast_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name TEXT NOT NULL UNIQUE,              -- human label, e.g. 'Product upload nudge'
  subject TEXT NOT NULL,                  -- email subject line
  title TEXT NOT NULL,                    -- push + in-app notification title
  body TEXT NOT NULL,                     -- message body; supports {{name}}, {{custom1}}, {{custom2}}
  cta_label TEXT,
  cta_url TEXT,

  audience TEXT NOT NULL DEFAULT 'vendors'
    CHECK (audience IN ('vendors', 'all_users')),

  send_push BOOLEAN NOT NULL DEFAULT TRUE,
  send_email BOOLEAN NOT NULL DEFAULT TRUE,

  -- Auto-send: NULL = manual only; otherwise re-sent every N days
  auto_cadence_days INTEGER CHECK (auto_cadence_days IS NULL OR auto_cadence_days >= 1),

  -- Suppression: skip vendors who created a product within N days
  -- (e.g. don't nag someone who listed yesterday). NULL = no rule.
  skip_if_listed_within_days INTEGER,

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_auto_sent_at TIMESTAMPTZ,

  created_by UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_templates_active_auto
  ON public.broadcast_templates(is_active, auto_cadence_days)
  WHERE is_active = TRUE AND auto_cadence_days IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.broadcast_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  template_id UUID REFERENCES public.broadcast_templates(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'auto')),
  sent_by UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,

  -- Snapshot of what was sent (template edits must not rewrite history)
  audience TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cta_label TEXT,
  cta_url TEXT,

  targeted INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  suppressed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_broadcast_sends_created ON public.broadcast_sends(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_sends_template ON public.broadcast_sends(template_id);

ALTER TABLE public.broadcast_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_sends ENABLE ROW LEVEL SECURITY;

-- Service role only — all access goes through the admin API (service-role
-- client). No authenticated-user policies on purpose.
GRANT ALL ON public.broadcast_templates TO service_role;
GRANT ALL ON public.broadcast_sends TO service_role;

-- =====================================================
-- SEED TEMPLATES
-- {{name}} = recipient first/display name, {{custom1}} = admin-filled
-- value (event name, product term, occasion) prompted in the UI.
-- =====================================================

INSERT INTO public.broadcast_templates
  (name, subject, title, body, cta_label, cta_url, audience, auto_cadence_days, skip_if_listed_within_days)
VALUES
  (
    'Product upload nudge',
    'Hi {{name}} — have you uploaded a product today?',
    'Time to list something new 📦',
    'Hi {{name}}, have you uploaded a product today? Fresh listings get the most visibility — buyers are browsing right now and your next sale could be one upload away.',
    'Add a Product', NULL, 'vendors', 3, 3
  ),
  (
    'Upcoming event',
    'The upcoming event is {{custom1}} — get ready',
    'Upcoming event: {{custom1}} 🗓️',
    'Hi {{name}}, the upcoming event is {{custom1}}. Make sure your store is stocked and your listings are up to date so you don''t miss the extra traffic.',
    'Open Fretiko', NULL, 'vendors', NULL, NULL
  ),
  (
    'Customers looking for you',
    'Customers are looking for you, {{name}}',
    'Customers are looking for you 👀',
    'Hi {{name}}, customers are looking for you. Shoppers are actively browsing and buying on Fretiko — keep your listings fresh so they find you first.',
    'View My Store', NULL, 'vendors', 7, NULL
  ),
  (
    'Demand signal',
    'Customers are looking for {{custom1}}',
    'Demand alert: {{custom1}} 🔥',
    'Hi {{name}}, customers are looking for {{custom1}} right now. If you have it in stock, list it today — items matching current demand sell fastest.',
    'List It Now', NULL, 'vendors', NULL, NULL
  ),
  (
    'Seasonal occasion',
    'Weddings this weekend — customers need your products',
    'Wedding season is here 💍',
    'Hi {{name}}, there are weddings coming up this weekend and customers need your products. {{custom1}} List your best pieces now so shoppers can find them in time.',
    'Add a Product', NULL, 'vendors', NULL, NULL
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;
