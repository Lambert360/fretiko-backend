import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';

export interface TagRecord {
  id: string;
  name: string;
  display_name: string;
  usage_count: number;
}

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);
  private serviceSupabase: SupabaseClient;

  constructor(private clientManager: SupabaseClientManager) {
    this.serviceSupabase = this.clientManager.getServiceClient();
  }

  /**
   * Extract raw tag strings (without leading #) from a text block.
   * Example: "Hello #Fashion and #tech" -> ['Fashion', 'tech']
   */
  extractTags(text: string | null | undefined): string[] {
    if (!text) return [];

    const regex = /(^|\s)#([A-Za-z0-9_]{1,100})/g;
    const tags = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const raw = match[2];
      if (raw) {
        tags.add(raw);
      }
    }

    return Array.from(tags);
  }

  /**
   * Normalize a tag for storage/lookup (lowercase, trimmed).
   */
  normalizeTag(raw: string): string {
    return raw.trim().toLowerCase();
  }

  /**
   * Ensure tags exist in the tags table and return their records.
   * Accepts raw tag names (without #).
   */
  async createOrGetTags(rawNames: string[]): Promise<TagRecord[]> {
    const uniqueNames = Array.from(new Set(rawNames.map(name => name.trim()).filter(Boolean)));
    if (uniqueNames.length === 0) return [];

    const normalizedMap = new Map<string, string>();
    uniqueNames.forEach(raw => {
      normalizedMap.set(this.normalizeTag(raw), raw);
    });

    const normalizedNames = Array.from(normalizedMap.keys());

    // Get existing tags
    const { data: existing, error: fetchError } = await this.serviceSupabase
      .from('tags')
      .select('id, name, display_name, usage_count')
      .in('name', normalizedNames);

    if (fetchError) {
      this.logger.error('Failed to fetch existing tags', fetchError);
      throw new Error(`Failed to fetch tags: ${fetchError.message}`);
    }

    const existingByName = new Map<string, TagRecord>();
    (existing || []).forEach((t: any) => existingByName.set(t.name, t));

    // Prepare inserts for tags that do not exist yet
    const toInsert: { name: string; display_name: string }[] = [];
    normalizedNames.forEach(name => {
      if (!existingByName.has(name)) {
        toInsert.push({
          name,
          display_name: normalizedMap.get(name) || name,
        });
      }
    });

    if (toInsert.length > 0) {
      const { data: inserted, error: insertError } = await this.serviceSupabase
        .from('tags')
        .insert(toInsert)
        .select('id, name, display_name, usage_count');

      if (insertError) {
        this.logger.error('Failed to insert new tags', insertError);
        throw new Error(`Failed to insert tags: ${insertError.message}`);
      }

      (inserted || []).forEach((t: any) => existingByName.set(t.name, t));
    }

    return normalizedNames
      .map(name => existingByName.get(name)!)
      .filter(Boolean);
  }

  /**
   * Sync taggings for a given content record (replace existing mappings).
   */
  async syncTaggings(
    taggableId: string,
    taggableType: string,
    text: string | null | undefined,
  ): Promise<void> {
    const rawTags = this.extractTags(text);
    if (rawTags.length === 0) {
      // No tags -> just delete existing taggings for this content
      await this.serviceSupabase
        .from('taggings')
        .delete()
        .eq('taggable_id', taggableId)
        .eq('taggable_type', taggableType);
      return;
    }

    const tagRecords = await this.createOrGetTags(rawTags);
    const tagIds = tagRecords.map(t => t.id);

    // Delete old taggings for this content
    const { error: deleteError } = await this.serviceSupabase
      .from('taggings')
      .delete()
      .eq('taggable_id', taggableId)
      .eq('taggable_type', taggableType);

    if (deleteError) {
      this.logger.error('Failed to delete old taggings', deleteError);
      throw new Error(`Failed to delete old taggings: ${deleteError.message}`);
    }

    // Insert new taggings
    const rows = tagIds.map(tagId => ({
      tag_id: tagId,
      taggable_id: taggableId,
      taggable_type: taggableType,
    }));

    const { error: insertError } = await this.serviceSupabase
      .from('taggings')
      .insert(rows);

    if (insertError) {
      this.logger.error('Failed to insert taggings', insertError);
      throw new Error(`Failed to insert taggings: ${insertError.message}`);
    }

    // Increment usage_count for all tags used here
    await this.incrementUsageCounts(tagIds);
  }

  async incrementUsageCounts(tagIds: string[]): Promise<void> {
    if (!tagIds || tagIds.length === 0) return;

    try {
      // De-duplicate IDs to minimize queries
      const uniqueIds = Array.from(new Set(tagIds));

      // Load current usage_count values for these tags
      const { data, error } = await this.serviceSupabase
        .from('tags')
        .select('id, usage_count')
        .in('id', uniqueIds);

      if (error) {
        this.logger.warn('Failed to load tags for usage_count increment', error.message);
        return;
      }

      if (!data || data.length === 0) return;

      // Perform a simple read-modify-write increment for each tag
      for (const row of data as { id: string; usage_count: number | null }[]) {
        const newCount = (row.usage_count || 0) + 1;
        const { error: updateError } = await this.serviceSupabase
          .from('tags')
          .update({ usage_count: newCount })
          .eq('id', row.id);

        if (updateError) {
          this.logger.warn('Failed to update usage_count for tag', {
            tagId: row.id,
            error: updateError.message,
          });
        }
      }
    } catch (err: any) {
      this.logger.warn('incrementUsageCounts encountered an error', err?.message || err);
    }
  }

  async getTrendingTags(limit: number = 20): Promise<TagRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit || 20, 50));

    const { data, error } = await this.serviceSupabase
      .from('tags')
      .select('id, name, display_name, usage_count')
      .order('usage_count', { ascending: false })
      .limit(safeLimit);

    if (error) {
      this.logger.error('Failed to fetch trending tags', error);
      throw new Error(`Failed to fetch trending tags: ${error.message}`);
    }

    return (data || []) as TagRecord[];
  }

  async getTagContent(rawTag: string, limit: number = 50, offset: number = 0): Promise<any[]> {
    try {
      const tagName = this.normalizeTag(rawTag);
      const { data: tag, error: tagError } = await this.serviceSupabase
        .from('tags')
        .select('id')
        .eq('name', tagName)
        .single();

      if (tagError || !tag) {
        this.logger.warn(`Tag not found: ${rawTag}`);
        return [];
      }

      const { data: taggings, error: taggingsError } = await this.serviceSupabase
        .from('taggings')
        .select('taggable_id, taggable_type')
        .eq('tag_id', tag.id)
        .neq('taggable_type', 'chat_message');

      if (taggingsError) {
        throw new Error(`Failed to fetch taggings: ${taggingsError.message}`);
      }

      if (!taggings?.length) {
        return [];
      }

      const idsByType: Record<string, string[]> = {};
      for (const t of taggings as any[]) {
        if (!idsByType[t.taggable_type]) {
          idsByType[t.taggable_type] = [];
        }
        idsByType[t.taggable_type].push(t.taggable_id);
      }

      const tableMap: Record<string, { table: string; titleField: string; imageField: string; contentField: string; authorField: string }> = {
        post: { table: 'posts', titleField: 'content', imageField: 'media_urls', contentField: 'content', authorField: 'user_id' },
        product: { table: 'products', titleField: 'name', imageField: 'primary_image_url', contentField: 'description', authorField: 'seller_id' },
        service: { table: 'services', titleField: 'title', imageField: 'images', contentField: 'description', authorField: 'provider_id' },
        story: { table: 'stories', titleField: 'caption', imageField: 'media_url', contentField: 'caption', authorField: 'user_id' },
      };

      const allItems: any[] = [];

      for (const [type, ids] of Object.entries(idsByType)) {
        const config = tableMap[type];
        if (!config) {
          this.logger.warn(`Unknown taggable type encountered: ${type}`);
          continue;
        }

        const { data, error } = await this.serviceSupabase
          .from(config.table)
          .select('*')
          .in('id', ids);

        if (error || !data) {
          this.logger.warn(`Failed to fetch ${type} content:`, error?.message);
          continue;
        }

        for (const row of data as any[]) {
          if (type === 'post' && row.is_deleted) continue;
          if (type === 'story' && (row.is_active === false || (row.expires_at && new Date(row.expires_at) < new Date()))) continue;

          let rawTitle = row[config.titleField];
          let rawContent = row[config.contentField];

          if (type === 'post') {
            rawTitle = (rawTitle || '').toString().slice(0, 80);
            rawContent = (rawContent || '').toString().slice(0, 120);
          }

          const title = typeof rawTitle === 'string' && rawTitle.length ? rawTitle : type.charAt(0).toUpperCase() + type.slice(1);
          const content = typeof rawContent === 'string' ? rawContent : '';
          const image = this.resolveTagImage(row, config.imageField);

          allItems.push({
            id: row.id,
            type,
            title,
            content,
            image,
            createdAt: row.created_at,
            authorId: row[config.authorField],
          });
        }
      }

      allItems.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      return allItems.slice(offset, offset + limit);
    } catch (error: any) {
      this.logger.error('Failed to get tag content:', error);
      throw error;
    }
  }

  private resolveTagImage(row: any, imageField: string): string | undefined {
    const value = row[imageField];
    if (Array.isArray(value) && value.length > 0) {
      return value[0];
    }
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    return undefined;
  }
}
