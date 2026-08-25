import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface BotPersona {
  email: string;
  username: string;
  full_name: string;
  first_name: string;
  last_name: string;
  gender: string;
  ethnic_group: string;
  bio: string;
  avatar_url: string;
  niche?: string;
  role: 'content' | 'engagement';
  location?: string;
  followers_count?: number;
  following_count?: number;
}

const logger = new Logger('BotPersonaUtil');
const ensuredIds = new Map<string, string>();
let authUsersCache: any[] | null = null;

export function loadPersonas(fileName: string): BotPersona[] {
  const filePath = path.join(process.cwd(), fileName);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed.bots || [];
}

function generateRandomPassword(): string {
  return `Fr3t1ko_${Math.random().toString(36).slice(2)}${Date.now()}`;
}

// Legacy schema compatibility: some projects have posts.user_id -> public.users
// instead of -> user_profiles/auth.users. Mirror the bot into that table too,
// if it exists, so post inserts don't fail on the FK constraint.
async function mirrorIntoLegacyUsersTable(supabaseClient: any, persona: BotPersona, id: string): Promise<void> {
  const { error } = await supabaseClient.from('users').upsert({
    id,
    email: persona.email,
    username: persona.username,
    first_name: persona.first_name,
    last_name: persona.last_name,
    bio: persona.bio,
    avatar_url: persona.avatar_url,
    is_bot: false,
  });

  if (error && error.code !== 'PGRST205') {
    logger.warn(`Could not mirror ${persona.username} into legacy users table: ${error.message}`);
  }
}

function buildProfilePayload(persona: BotPersona, id?: string): Record<string, any> {
  const payload: Record<string, any> = {
    username: persona.username,
    bio: persona.bio,
    avatar_url: persona.avatar_url,
    display_name: persona.full_name,
  };
  if (id) payload.id = id;
  if (persona.location) payload.location = persona.location;
  if (typeof persona.followers_count === 'number') payload.followers_count = persona.followers_count;
  if (typeof persona.following_count === 'number') payload.following_count = persona.following_count;
  return payload;
}

function withoutCountColumns(payload: Record<string, any>): Record<string, any> {
  const copy = { ...payload };
  delete copy.followers_count;
  delete copy.following_count;
  return copy;
}

async function writeProfile(
  supabaseClient: any,
  persona: BotPersona,
  mode: 'update' | 'upsert',
  id?: string,
): Promise<{ id?: string; error?: any }> {
  const payload = buildProfilePayload(persona, id);
  const query =
    mode === 'update'
      ? supabaseClient.from('user_profiles').update(payload).eq('id', id).select('id').single()
      : supabaseClient.from('user_profiles').upsert(payload).select('id').single();

  const { data, error } = await query;
  if (!error) return { id: data?.id };

  const missingCounts = /followers_count|following_count|display_name|location/i.test(error.message || '');
  if (!missingCounts) return { error };

  const fallback = withoutCountColumns(payload);
  if (/display_name/i.test(error.message || '')) delete fallback.display_name;

  const retry =
    mode === 'update'
      ? supabaseClient.from('user_profiles').update(fallback).eq('id', id).select('id').single()
      : supabaseClient.from('user_profiles').upsert(fallback).select('id').single();

  const retried = await retry;
  if (retried.error) return { error: retried.error };
  logger.warn(`Profile written for ${persona.username} without optional columns: ${error.message}`);
  return { id: retried.data?.id };
}

async function listAllAuthUsers(supabaseClient: any): Promise<any[]> {
  if (authUsersCache) return authUsersCache;

  const all: any[] = [];
  const PER_PAGE = 200;
  for (let page = 1; page <= 50; page++) {
    let { data, error } = await supabaseClient.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) {
      // Some Supabase projects error out on larger page sizes; retry once with a smaller page.
      const retry = await supabaseClient.auth.admin.listUsers({ page, perPage: 50 });
      data = retry.data;
      error = retry.error;
    }
    if (error) {
      logger.warn(`listUsers page ${page} failed: ${error.message}`);
      break;
    }
    const users = data?.users || [];
    all.push(...users);
    if (users.length < PER_PAGE) break;
  }
  authUsersCache = all;
  return all;
}

export async function ensureBotUser(supabaseClient: any, persona: BotPersona): Promise<string | null> {
  const cached = ensuredIds.get(persona.username);
  if (cached) return cached;

  try {
    const { data: existingProfile } = await supabaseClient
      .from('user_profiles')
      .select('id')
      .eq('username', persona.username)
      .single();

    if (existingProfile) {
      const { error: updateError } = await writeProfile(supabaseClient, persona, 'update', existingProfile.id);
      if (updateError) {
        logger.warn(`Could not refresh profile for ${persona.username}: ${updateError.message}`);
      }

      await mirrorIntoLegacyUsersTable(supabaseClient, persona, existingProfile.id);
      ensuredIds.set(persona.username, existingProfile.id);
      return existingProfile.id;
    }

    const existingAuthList = await listAllAuthUsers(supabaseClient);
    let authUser = existingAuthList.find((u: any) => u.email === persona.email);

    if (!authUser) {
      const { data: createdAuth, error: authError } = await supabaseClient.auth.admin.createUser({
        email: persona.email,
        email_confirm: true,
        password: generateRandomPassword(),
        user_metadata: {
          full_name: persona.full_name,
        },
      });

      if (authError || !createdAuth?.user) {
        logger.error(`Failed to create auth user for ${persona.username}: ${authError?.message}`);
        return null;
      }
      authUser = createdAuth.user;
      authUsersCache = authUsersCache ? [...authUsersCache, authUser] : [authUser];
    }

    const { id: profileId, error: profileError } = await writeProfile(
      supabaseClient,
      persona,
      'upsert',
      authUser.id,
    );

    if (profileError || !profileId) {
      logger.error(`Failed to create profile for ${persona.username}: ${profileError?.message}`);
      return null;
    }

    await mirrorIntoLegacyUsersTable(supabaseClient, persona, authUser.id);

    logger.log(`Bot user ready: ${persona.username} (${profileId})`);
    ensuredIds.set(persona.username, profileId);
    return profileId;
  } catch (error: any) {
    logger.error(`Error ensuring bot user ${persona.username}`, error.stack);
    return null;
  }
}
