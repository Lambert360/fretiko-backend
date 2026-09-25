import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolve a referral slug (random code OR username) to the referrer.
 * Returns { id, referral_code } or null when no referrer matches.
 * Username slugs are case-insensitive and can exceed referral_code's
 * VARCHAR(10) — callers must persist the resolved referral_code,
 * never the raw input.
 */
export async function resolveReferrer(
  supabase: SupabaseClient,
  input?: string | null,
): Promise<{ id: string; referral_code: string | null } | null> {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // Exact referral_code match wins over a case-insensitive username match
  const { data: byCode } = await supabase
    .from('user_profiles')
    .select('id, referral_code')
    .eq('referral_code', raw)
    .maybeSingle();

  if (byCode) return byCode;

  // Escape LIKE wildcards so a username like `foo_bar` doesn't pattern-match
  const likeTerm = raw.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data: byUsername } = await supabase
    .from('user_profiles')
    .select('id, referral_code')
    .ilike('username', likeTerm)
    .limit(1)
    .maybeSingle();

  return byUsername ?? null;
}
