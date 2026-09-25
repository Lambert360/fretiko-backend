/**
 * Strips characters that are syntax-significant to PostgREST `.or(...)`
 * filter strings or act as wildcards in `ilike` patterns, so raw user input
 * can't inject extra filter conditions or turn a term into a wildcard match.
 * Use before interpolating any user string into .or()/.ilike().
 */
export function escapePostgrestTerm(input?: string | null): string {
  return String(input || '').trim().replace(/[(),."%_*\\]/g, '');
}
