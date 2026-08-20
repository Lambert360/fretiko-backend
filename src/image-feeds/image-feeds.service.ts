import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { BotPersona, ensureBotUser as ensureBotUserShared } from '../shared/bot-persona.util';

export { BotPersona };

export interface NicheContent {
  search_terms: string[];
  captions: string[];
}

export interface ImageFeedsConfig {
  niches: Record<string, NicheContent>;
  settings: {
    fetch_interval_minutes: number;
    post_interval_minutes: number;
    enable_auto_posting: boolean;
    image_sources: string[];
    show_attribution: boolean;
    max_recent_images_remembered: number;
  };
}

export interface SourcedImage {
  imageUrl: string;
  source: 'unsplash' | 'pexels' | 'pixabay';
  photographer?: string;
  sourceLink?: string;
  imageId: string;
}

@Injectable()
export class ImageFeedsService {
  private readonly logger = new Logger(ImageFeedsService.name);
  private config: ImageFeedsConfig;
  private personas: BotPersona[] = [];
  private configPath: string;
  private personasPath: string;
  private usedImageIds: Set<string> = new Set();
  private usedItemsPath: string;
  private supabaseClient: any;

  constructor(private readonly configService: ConfigService) {
    this.supabaseClient = createServiceSupabaseClient(this.configService);
    this.configPath = path.join(process.cwd(), 'image-feeds-config.json');
    this.personasPath = path.join(process.cwd(), 'content-bots.json');
    this.usedItemsPath = path.join(process.cwd(), 'image-feeds-used-items.json');
    this.loadConfig();
    this.loadPersonas();
    this.loadUsedItems();
  }

  private loadConfig(): void {
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    this.config = JSON.parse(raw);
    this.logger.log('Image feeds config loaded');
  }

  private loadPersonas(): void {
    const raw = fs.readFileSync(this.personasPath, 'utf-8');
    const parsed = JSON.parse(raw);
    this.personas = parsed.bots || [];
    this.logger.log(`Loaded ${this.personas.length} bot personas`);
  }

  private loadUsedItems(): void {
    try {
      if (fs.existsSync(this.usedItemsPath)) {
        const data = JSON.parse(fs.readFileSync(this.usedItemsPath, 'utf-8'));
        this.usedImageIds = new Set(data);
      }
    } catch (error) {
      this.logger.warn('Could not load used image items', error.message);
    }
  }

  private saveUsedItems(): void {
    const max = this.config.settings.max_recent_images_remembered;
    let ids = Array.from(this.usedImageIds);
    if (ids.length > max) {
      ids = ids.slice(ids.length - max);
      this.usedImageIds = new Set(ids);
    }
    fs.writeFileSync(this.usedItemsPath, JSON.stringify(ids, null, 2));
  }

  getConfig(): ImageFeedsConfig {
    return this.config;
  }

  getPersonas(): BotPersona[] {
    return this.personas;
  }

  async updateSettings(settings: Partial<ImageFeedsConfig['settings']>): Promise<void> {
    this.config.settings = { ...this.config.settings, ...settings };
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    this.logger.log('Image feeds settings updated');
  }

  private randomPick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  async fetchImageForNiche(niche: string): Promise<SourcedImage | null> {
    const nicheContent = this.config.niches[niche];
    if (!nicheContent) return null;

    const term = this.randomPick(nicheContent.search_terms);
    const sources = this.config.settings.image_sources;

    for (const source of sources) {
      try {
        const image = await this.fetchFromSource(source as any, term);
        if (image && !this.usedImageIds.has(image.imageId)) {
          return image;
        }
      } catch (error) {
        this.logger.warn(`${source} fetch failed for "${term}": ${error.message}`);
      }
    }
    return null;
  }

  private async fetchFromSource(
    source: 'unsplash' | 'pexels' | 'pixabay',
    query: string,
  ): Promise<SourcedImage | null> {
    if (source === 'unsplash') return this.fetchFromUnsplash(query);
    if (source === 'pexels') return this.fetchFromPexels(query);
    if (source === 'pixabay') return this.fetchFromPixabay(query);
    return null;
  }

  private async fetchFromUnsplash(query: string): Promise<SourcedImage | null> {
    const accessKey = this.configService.get<string>('UNSPLASH_ACCESS_KEY');
    if (!accessKey) return null;

    const page = Math.floor(Math.random() * 5) + 1;
    const res = await axios.get('https://api.unsplash.com/search/photos', {
      params: { query, per_page: 20, page, orientation: 'squarish' },
      headers: { Authorization: `Client-ID ${accessKey}` },
    });

    const results = res.data?.results || [];
    if (results.length === 0) return null;

    const photo: any = this.randomPick<any>(results);
    return {
      imageUrl: photo.urls?.regular,
      source: 'unsplash',
      photographer: photo.user?.name,
      sourceLink: photo.links?.html,
      imageId: `unsplash-${photo.id}`,
    };
  }

  private async fetchFromPexels(query: string): Promise<SourcedImage | null> {
    const apiKey = this.configService.get<string>('PEXELS_API_KEY');
    if (!apiKey) return null;

    const page = Math.floor(Math.random() * 5) + 1;
    const res = await axios.get('https://api.pexels.com/v1/search', {
      params: { query, per_page: 20, page },
      headers: { Authorization: apiKey },
    });

    const photos = res.data?.photos || [];
    if (photos.length === 0) return null;

    const photo: any = this.randomPick<any>(photos);
    return {
      imageUrl: photo.src?.large,
      source: 'pexels',
      photographer: photo.photographer,
      sourceLink: photo.url,
      imageId: `pexels-${photo.id}`,
    };
  }

  private async fetchFromPixabay(query: string): Promise<SourcedImage | null> {
    const apiKey = this.configService.get<string>('PIXABAY_API_KEY');
    if (!apiKey) return null;

    const page = Math.floor(Math.random() * 5) + 1;
    const res = await axios.get('https://pixabay.com/api/', {
      params: { key: apiKey, q: query, image_type: 'photo', per_page: 20, page, safesearch: true },
    });

    const hits = res.data?.hits || [];
    if (hits.length === 0) return null;

    const photo: any = this.randomPick<any>(hits);
    return {
      imageUrl: photo.largeImageURL,
      source: 'pixabay',
      photographer: photo.user,
      sourceLink: photo.pageURL,
      imageId: `pixabay-${photo.id}`,
    };
  }

  generateCaption(niche: string): string {
    const nicheContent = this.config.niches[niche];
    if (!nicheContent) return '';
    return this.randomPick(nicheContent.captions);
  }

  async ensureBotUser(persona: BotPersona): Promise<string | null> {
    return ensureBotUserShared(this.supabaseClient, persona);
  }

  async createImagePost(persona: BotPersona, botUserId: string): Promise<any> {
    const niche = persona.niche || 'science_technology';
    const image = await this.fetchImageForNiche(niche);
    if (!image) {
      throw new Error(`No image found for niche ${niche}`);
    }

    const caption = this.generateCaption(niche);
    let content = caption;

    if (this.config.settings.show_attribution && image.photographer) {
      content = `${caption}\n\n📷 ${image.photographer} / ${image.source}`;
    }

    const { data: post, error } = await this.supabaseClient
      .from('posts')
      .insert({
        user_id: botUserId,
        content,
        media_urls: [image.imageUrl],
        media_type: 'image',
        privacy_level: 'public',
      })
      .select()
      .single();

    if (error) throw error;

    const { error: mediaError } = await this.supabaseClient
      .from('post_media')
      .insert({
        post_id: post.id,
        media_type: 'image',
        media_url: image.imageUrl,
        order_index: 0,
      });

    if (mediaError) {
      this.logger.warn(`Failed to insert post_media row for post ${post.id}`, mediaError.message);
    }

    this.usedImageIds.add(image.imageId);
    this.saveUsedItems();

    this.logger.log(`Posted image (${image.source}) for ${persona.username}: "${caption}"`);
    return post;
  }
}
