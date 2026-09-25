import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Returns true when the viewer is verified 18+ via user_profiles.date_of_birth.
 * Anonymous viewers and profiles without a DOB are treated as under-18.
 * Used to gate `is_adult_content` vendor catalogs on discovery surfaces,
 * direct product/service links, and purchase availability.
 */
export async function isAdultViewer(
  supabase: SupabaseClient,
  viewerId: string | null | undefined,
): Promise<boolean> {
  if (!viewerId) return false;

  const { data } = await supabase
    .from('user_profiles')
    .select('date_of_birth')
    .eq('id', viewerId)
    .single();

  if (!data?.date_of_birth) return false;

  const dob = new Date(data.date_of_birth);
  if (isNaN(dob.getTime())) return false;

  const eighteenthBirthday = new Date(dob);
  eighteenthBirthday.setFullYear(eighteenthBirthday.getFullYear() + 18);
  return eighteenthBirthday <= new Date();
}
