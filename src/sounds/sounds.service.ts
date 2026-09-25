import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';

/**
 * Built-in soundboard slots shipped inside the mobile app bundle.
 * These are not rows in `sounds` — they are referenced by key in the
 * host's `preferences.stream_sound_slots` array.
 */
export const BUILTIN_SOUND_KEYS = ['builtin:cheer', 'builtin:clap', 'builtin:laugh'] as const;
export const DEFAULT_PRIMARIES: string[] = [...BUILTIN_SOUND_KEYS];

const SOUND_BUCKET = 'gift-sounds';
const LIVE_CONTEXT = 'live_stream';
const MAX_SOUND_BYTES = 5 * 1024 * 1024; // 5MB is plenty for a soundboard clip
const ALLOWED_MIME_PREFIX = 'audio/';

/**
 * Sounds Service
 *
 * Vendor-facing live-stream soundboard:
 * - Lists platform sounds (admin-curated, owner_id IS NULL) plus the
 *   vendor's own uploads for the 'live_stream' context.
 * - Uploads vendor sounds to the shared `gift-sounds` bucket.
 * - Persists each vendor's 3 quick-play slots in
 *   `user_profiles.preferences.stream_sound_slots`.
 */
@Injectable()
export class SoundsService {
  private readonly logger = new Logger(SoundsService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Get the soundboard library for a host: platform sounds + own uploads +
   * the 3 quick-play slot assignments (sound ids or 'builtin:*' keys).
   */
  async getLibrary(userId: string) {
    const [{ data: platform, error: platformError }, { data: mine, error: mineError }, primaries] =
      await Promise.all([
        this.supabase
          .from('sounds')
          .select('*')
          .eq('context', LIVE_CONTEXT)
          .is('owner_id', null)
          .eq('is_active', true)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: false }),
        this.supabase
          .from('sounds')
          .select('*')
          .eq('context', LIVE_CONTEXT)
          .eq('owner_id', userId)
          .eq('is_active', true)
          .order('created_at', { ascending: false }),
        this.getPrimaries(userId),
      ]);

    if (platformError || mineError) {
      this.logger.error(`Failed to load sound library for ${userId}`, platformError || mineError);
      throw new BadRequestException('Failed to load sound library');
    }

    // Resolve stale primaries (sound deleted since it was pinned) back to
    // that slot's built-in default so the client always gets 3 valid slots.
    const validIds = new Set([...(platform || []), ...(mine || [])].map((s: any) => s.id));
    const resolvedPrimaries = primaries.map((entry, index) => {
      if (BUILTIN_SOUND_KEYS.includes(entry as any)) return entry;
      if (validIds.has(entry)) return entry;
      return DEFAULT_PRIMARIES[index] ?? 'builtin:cheer';
    });

    return { platform: platform || [], mine: mine || [], primaries: resolvedPrimaries };
  }

  /**
   * Upload a custom sound for a vendor (multipart file already parsed).
   */
  async uploadSound(userId: string, file: Express.Multer.File, name: string) {
    if (!file || !file.buffer) {
      throw new BadRequestException('Audio file is required');
    }
    if (!file.mimetype?.startsWith(ALLOWED_MIME_PREFIX)) {
      throw new BadRequestException('Only audio files are allowed');
    }
    if (file.size > MAX_SOUND_BYTES) {
      throw new BadRequestException('Sound file exceeds the 5MB limit');
    }

    const trimmedName = (name || '').trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new BadRequestException('A sound name (1-100 characters) is required');
    }

    const ext = file.originalname?.split('.').pop()?.toLowerCase() || 'mp3';
    const fileName = `live/${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;

    const { data: uploadData, error: uploadError } = await this.supabase.storage
      .from(SOUND_BUCKET)
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      this.logger.error(`Failed to upload sound for user ${userId}:`, uploadError);
      throw new BadRequestException('Failed to upload sound file');
    }

    const { data: publicUrlData } = this.supabase.storage
      .from(SOUND_BUCKET)
      .getPublicUrl(uploadData.path);

    const { data, error } = await this.supabase
      .from('sounds')
      .insert({
        name: trimmedName,
        sound_url: publicUrlData.publicUrl,
        context: LIVE_CONTEXT,
        owner_id: userId,
        is_active: true,
        sort_order: 0,
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to create sound row for user ${userId}:`, error);
      await this.supabase.storage.from(SOUND_BUCKET).remove([uploadData.path]).catch(() => undefined);
      throw new BadRequestException('Failed to save sound');
    }

    return data;
  }

  /**
   * Delete a vendor-owned sound. Platform sounds (owner_id NULL) are not
   * deletable here — admins remove them via /gifts/admin/sounds/:id.
   */
  async deleteSound(userId: string, soundId: string) {
    const { data: sound, error } = await this.supabase
      .from('sounds')
      .select('id, owner_id, sound_url')
      .eq('id', soundId)
      .single();

    if (error || !sound) {
      throw new NotFoundException('Sound not found');
    }

    if (sound.owner_id !== userId) {
      throw new ForbiddenException('You can only delete your own sounds');
    }

    const pathMatch = sound.sound_url?.match(/gift-sounds\/(.+)$/);
    if (pathMatch) {
      await this.supabase.storage.from(SOUND_BUCKET).remove([pathMatch[1]]).catch(() => undefined);
    }

    const { error: deleteError } = await this.supabase
      .from('sounds')
      .delete()
      .eq('id', soundId);

    if (deleteError) {
      this.logger.error(`Failed to delete sound ${soundId}:`, deleteError);
      throw new BadRequestException('Failed to delete sound');
    }

    // If the deleted sound was pinned to a quick slot, reset that slot
    // back to its built-in default.
    const primaries = await this.getPrimaries(userId);
    if (primaries.includes(soundId)) {
      const next = primaries.map((entry, index) =>
        entry === soundId ? DEFAULT_PRIMARIES[index] ?? 'builtin:cheer' : entry,
      );
      await this.savePrimaries(userId, next);
    }

    return { success: true };
  }

  /**
   * Persist the vendor's 3 quick-play slots.
   * Each entry is either a 'builtin:*' key or a sound id the vendor can
   * see (platform live-stream sound or own upload).
   */
  async setPrimaries(userId: string, primaries: string[]) {
    if (!Array.isArray(primaries) || primaries.length !== 3) {
      throw new BadRequestException('Exactly 3 sound slots are required');
    }

    const soundIds = primaries.filter(
      (entry) => typeof entry === 'string' && !BUILTIN_SOUND_KEYS.includes(entry as any),
    );

    if (soundIds.length > 0) {
      const { data: valid, error } = await this.supabase
        .from('sounds')
        .select('id')
        .eq('context', LIVE_CONTEXT)
        .eq('is_active', true)
        .or(`owner_id.is.null,owner_id.eq.${userId}`)
        .in('id', soundIds);

      if (error) {
        this.logger.error(`Failed to validate primaries for ${userId}:`, error);
        throw new BadRequestException('Failed to validate sounds');
      }

      const validIds = new Set((valid || []).map((s: any) => s.id));
      if (soundIds.some((id) => !validIds.has(id))) {
        throw new BadRequestException('One or more sounds are not available for your soundboard');
      }
    }

    // Normalize: any unrecognized non-builtin entry falls back to the slot default
    const normalized = primaries.map((entry, index) =>
      BUILTIN_SOUND_KEYS.includes(entry as any) || soundIds.includes(entry)
        ? entry
        : DEFAULT_PRIMARIES[index] ?? 'builtin:cheer',
    );

    await this.savePrimaries(userId, normalized);
    return { primaries: normalized };
  }

  private async getPrimaries(userId: string): Promise<string[]> {
    const { data: profile, error } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (error) {
      this.logger.warn(`Could not load preferences for ${userId}: ${error.message}`);
      return DEFAULT_PRIMARIES;
    }

    const slots = profile?.preferences?.stream_sound_slots;
    if (Array.isArray(slots) && slots.length === 3) {
      return slots;
    }
    return DEFAULT_PRIMARIES;
  }

  /**
   * Merge into preferences JSONB (same pattern as UsersService.updateTimezone)
   * so unrelated flags (isSuspended, isVendor, timezone, ...) survive.
   */
  private async savePrimaries(userId: string, primaries: string[]) {
    const { data: profile, error: fetchError } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (fetchError) {
      throw new BadRequestException('Failed to load profile');
    }

    const updated = {
      ...(profile?.preferences || {}),
      stream_sound_slots: primaries,
    };

    const { error } = await this.supabase
      .from('user_profiles')
      .update({ preferences: updated, updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) {
      this.logger.error(`Failed to save sound slots for ${userId}:`, error);
      throw new BadRequestException('Failed to save sound slots');
    }
  }
}
