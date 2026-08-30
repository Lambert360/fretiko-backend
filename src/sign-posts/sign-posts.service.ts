import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CreateSignPostDto,
  UpdateSignPostDto,
  UpdateSignPostMediaDto,
} from './dto/sign-post.dto';

const execAsync = promisify(exec);

export interface HeroImageResponse {
  id: string;
  signPostId: string;
  name: string;
  url: string;
  title: string;
  subtitle: string | null;
  action_url: string | null;
  is_active: boolean;
  sort_order: number;
  media_type: 'image' | 'video';
  thumbnail_url: string | null;
  screen_target: string;
  countdown_enabled: boolean;
  countdown_target: string | null;
}

@Injectable()
export class SignPostsService {
  private readonly supabase;

  constructor(private readonly configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  // =====================
  // ADMIN METHODS
  // =====================

  async findAll(isActive?: boolean) {
    let query = this.supabase
      .from('sign_posts')
      .select(`*, sign_post_media(*)`)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (typeof isActive === 'boolean') {
      query = query.eq('is_active', isActive);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch sign posts: ${error.message}`);
    return data || [];
  }

  async findById(id: string) {
    const { data, error } = await this.supabase
      .from('sign_posts')
      .select(`*, sign_post_media(*)`)
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException(`Sign post ${id} not found`);
    return data;
  }

  async create(dto: CreateSignPostDto) {
    const { media, ...signPostData } = dto as any;

    const { data: signPost, error } = await this.supabase
      .from('sign_posts')
      .insert({
        name: signPostData.name,
        title: signPostData.title,
        subtitle: signPostData.subtitle,
        action_url: signPostData.actionUrl,
        screen_target: signPostData.screenTarget,
        countdown_enabled: signPostData.countdownEnabled ?? false,
        countdown_target: signPostData.countdownTarget || null,
        is_active: signPostData.isActive ?? true,
        sort_order: signPostData.sortOrder ?? 0,
        start_at: signPostData.startAt || null,
        end_at: signPostData.endAt || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create sign post: ${error.message}`);

    // Create media rows if provided
    if (media && Array.isArray(media) && media.length > 0) {
      await this.createMediaRows(signPost.id, media);
    }

    return this.findById(signPost.id);
  }

  async update(id: string, dto: UpdateSignPostDto) {
    await this.findById(id);

    const updateData: any = {
      updated_at: new Date().toISOString(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.subtitle !== undefined) updateData.subtitle = dto.subtitle;
    if (dto.actionUrl !== undefined) updateData.action_url = dto.actionUrl;
    if (dto.screenTarget !== undefined) updateData.screen_target = dto.screenTarget;
    if (dto.countdownEnabled !== undefined) updateData.countdown_enabled = dto.countdownEnabled;
    if (dto.countdownTarget !== undefined) updateData.countdown_target = dto.countdownTarget || null;
    if (dto.isActive !== undefined) updateData.is_active = dto.isActive;
    if (dto.sortOrder !== undefined) updateData.sort_order = dto.sortOrder;
    if (dto.startAt !== undefined) updateData.start_at = dto.startAt || null;
    if (dto.endAt !== undefined) updateData.end_at = dto.endAt || null;

    const { error } = await this.supabase
      .from('sign_posts')
      .update(updateData)
      .eq('id', id);

    if (error) throw new Error(`Failed to update sign post: ${error.message}`);
    return this.findById(id);
  }

  async remove(id: string) {
    await this.findById(id);

    const { error } = await this.supabase.from('sign_posts').delete().eq('id', id);
    if (error) throw new Error(`Failed to delete sign post: ${error.message}`);
    return { success: true };
  }

  // =====================
  // MEDIA MANAGEMENT
  // =====================

  async uploadGenericMedia(file: Express.Multer.File, folder = 'uploads') {
    const mediaType = file.mimetype?.startsWith('video/') ? 'video' : 'image';
    const fileName = `sign-posts/${folder}/${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const contentType = file.mimetype || 'application/octet-stream';

    const { data, error } = await this.supabase.storage
      .from('sign-posts-media')
      .upload(fileName, file.buffer, {
        contentType,
        cacheControl: '3600',
        upsert: false,
      });

    if (error) throw new Error(`Upload failed: ${error.message}`);

    const { data: publicUrlData } = this.supabase.storage.from('sign-posts-media').getPublicUrl(data.path);
    const mediaUrl = publicUrlData.publicUrl;

    let thumbnailUrl: string | null = null;
    if (mediaType === 'video') {
      thumbnailUrl = await this.generateVideoThumbnail(file.buffer, fileName);
    }

    return {
      mediaUrl,
      mediaType,
      thumbnailUrl,
      fileSize: file.size,
      mimeType: file.mimetype || 'application/octet-stream',
    };
  }

  async addMedia(signPostId: string, file: Express.Multer.File, sortOrder = 0) {
    await this.findById(signPostId);

    const upload = await this.uploadGenericMedia(file, signPostId);

    const { data: mediaRow, error: mediaError } = await this.supabase
      .from('sign_post_media')
      .insert({
        sign_post_id: signPostId,
        media_type: upload.mediaType,
        media_url: upload.mediaUrl,
        thumbnail_url: upload.thumbnailUrl,
        file_size: upload.fileSize,
        mime_type: upload.mimeType,
        sort_order: sortOrder,
        processing_status: 'completed',
      })
      .select()
      .single();

    if (mediaError) throw new Error(`Failed to save media: ${mediaError.message}`);
    return mediaRow;
  }

  async updateMedia(mediaId: string, dto: UpdateSignPostMediaDto) {
    const updateData: any = {};
    if (dto.sortOrder !== undefined) updateData.sort_order = dto.sortOrder;
    if (dto.mediaUrl !== undefined) updateData.media_url = dto.mediaUrl;
    if (dto.thumbnailUrl !== undefined) updateData.thumbnail_url = dto.thumbnailUrl;

    if (Object.keys(updateData).length === 0) {
      throw new Error('No fields to update');
    }

    const { data, error } = await this.supabase
      .from('sign_post_media')
      .update(updateData)
      .eq('id', mediaId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException(`Media ${mediaId} not found`);
    return data;
  }

  async removeMedia(mediaId: string) {
    const { data: media, error: findError } = await this.supabase
      .from('sign_post_media')
      .select('media_url')
      .eq('id', mediaId)
      .single();

    if (findError || !media) throw new NotFoundException(`Media ${mediaId} not found`);

    // Extract storage path from public URL
    const url = media.media_url;
    const pathMatch = url.match(/sign-posts-media\/(.+)$/);
    if (pathMatch) {
      await this.supabase.storage.from('sign-posts-media').remove([pathMatch[1]]).catch(() => {
        // Silent fail — DB cleanup is more important
      });
    }

    const { error } = await this.supabase.from('sign_post_media').delete().eq('id', mediaId);
    if (error) throw new Error(`Failed to delete media: ${error.message}`);
    return { success: true };
  }

  // =====================
  // PUBLIC METHODS
  // =====================

  async getHeroImages(screenTarget: string = 'all'): Promise<HeroImageResponse[]> {
    const now = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('sign_posts')
      .select(`
        id,
        name,
        title,
        subtitle,
        action_url,
        screen_target,
        is_active,
        sort_order,
        countdown_enabled,
        countdown_target,
        sign_post_media (
          id,
          media_type,
          media_url,
          thumbnail_url,
          sort_order
        )
      `)
      .eq('is_active', true)
      .or(`start_at.is.null,start_at.lte.${now}`)
      .or(`end_at.is.null,end_at.gte.${now}`)
      .order('sort_order', { ascending: true });

    if (error) throw new Error(`Failed to fetch hero images: ${error.message}`);
    if (!data || data.length === 0) return [];

    const heroImages: HeroImageResponse[] = [];
    let globalIndex = 0;

    for (const signPost of data) {
      if (
        screenTarget !== 'all' &&
        signPost.screen_target !== screenTarget &&
        signPost.screen_target !== 'all'
      ) {
        continue;
      }
      const media = (signPost.sign_post_media || []) as any[];
      media.sort((a, b) => a.sort_order - b.sort_order);

      for (const item of media) {
        heroImages.push({
          id: item.id,
          signPostId: signPost.id,
          name: signPost.name,
          url: item.media_url,
          title: signPost.title,
          subtitle: signPost.subtitle,
          action_url: signPost.action_url,
          is_active: signPost.is_active,
          sort_order: globalIndex++,
          media_type: item.media_type,
          thumbnail_url: item.thumbnail_url,
          screen_target: signPost.screen_target,
          countdown_enabled: signPost.countdown_enabled ?? false,
          countdown_target: signPost.countdown_target ?? null,
        });
      }
    }

    return heroImages;
  }

  // =====================
  // HELPERS
  // =====================

  private async createMediaRows(signPostId: string, media: any[]) {
    const rows = media
      .filter((m) => m.mediaUrl)
      .map((m, index) => ({
        sign_post_id: signPostId,
        media_type: m.mediaType || 'image',
        media_url: m.mediaUrl,
        thumbnail_url: m.thumbnailUrl || null,
        sort_order: m.sortOrder ?? index,
        processing_status: 'completed',
      }));

    if (rows.length > 0) {
      const { error } = await this.supabase.from('sign_post_media').insert(rows);
      if (error) throw new Error(`Failed to create media rows: ${error.message}`);
    }
  }

  private async generateVideoThumbnail(videoBuffer: Buffer, pathKey: string): Promise<string | null> {
    const tempDir = os.tmpdir();
    const timestamp = Date.now();
    const videoPath = path.join(tempDir, `sign-post-video-${timestamp}.mp4`);
    const thumbnailPath = path.join(tempDir, `sign-post-thumb-${timestamp}.jpg`);

    try {
      fs.writeFileSync(videoPath, videoBuffer);
      const ffmpegCommand = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=640:-1" -y "${thumbnailPath}"`;
      await execAsync(ffmpegCommand);

      if (!fs.existsSync(thumbnailPath)) {
        console.warn('⚠️ Thumbnail file not generated');
        return null;
      }

      const thumbnailBuffer = fs.readFileSync(thumbnailPath);
      const thumbName = `sign-posts/thumbnails/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
      const { data, error } = await this.supabase.storage
        .from('sign-posts-media')
        .upload(thumbName, thumbnailBuffer, {
          contentType: 'image/jpeg',
          cacheControl: '3600',
          upsert: false,
        });

      if (error) {
        console.warn('⚠️ Thumbnail upload failed:', error.message);
        return null;
      }

      const { data: publicUrlData } = this.supabase.storage.from('sign-posts-media').getPublicUrl(data.path);
      return publicUrlData.publicUrl;
    } catch (error) {
      console.error('⚠️ Failed to generate sign post video thumbnail:', error);
      return null;
    } finally {
      try {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
