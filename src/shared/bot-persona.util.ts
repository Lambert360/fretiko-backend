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
}

const logger = new Logger('BotPersonaUtil');

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

export async function ensureBotUser(supabaseClient: any, persona: BotPersona): Promise<string | null> {
  try {
    const { data: existingProfile } = await supabaseClient
      .from('user_profiles')
      .select('id')
      .eq('username', persona.username)
      .single();

    if (existingProfile) {
      await mirrorIntoLegacyUsersTable(supabaseClient, persona, existingProfile.id);
      return existingProfile.id;
    }

    const { data: existingAuthList } = await supabaseClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
    let authUser = existingAuthList?.users?.find((u: any) => u.email === persona.email);

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
    }

    const { data: profile, error: profileError } = await supabaseClient
      .from('user_profiles')
      .upsert({
        id: authUser.id,
        username: persona.username,
        bio: persona.bio,
        avatar_url: persona.avatar_url,
      })
      .select()
      .single();

    if (profileError) {
      logger.error(`Failed to create profile for ${persona.username}: ${profileError.message}`);
      return null;
    }

    await mirrorIntoLegacyUsersTable(supabaseClient, persona, authUser.id);

    logger.log(`Bot user ready: ${persona.username} (${profile.id})`);
    return profile.id;
  } catch (error: any) {
    logger.error(`Error ensuring bot user ${persona.username}`, error.stack);
    return null;
  }
}
