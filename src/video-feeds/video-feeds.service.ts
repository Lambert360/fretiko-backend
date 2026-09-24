import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { BotPersona, ensureBotUser as ensureBotUserShared, insertBotPost } from '../shared/bot-persona.util';

export { BotPersona };

export interface NicheContent {
  search_terms: string[];
  captions: string[];
}

export interface VideoFeedsConfig {
  niches: Record<string, NicheContent>;
  settings: {
    fetch_interval_minutes: number;
    post_interval_minutes: number;
    enable_auto_posting: boolean;
    video_sources: string[];
    show_attribution: boolean;
    max_recent_videos_remembered: number;
  };
}

export interface SourcedVideo {
  videoUrl: string;
  thumbnailUrl?: string;
  source: 'pexels' | 'pixabay';
  photographer?: string;
  sourceLink?: string;
  videoId: string;
}

// Videos come only from licensed stock APIs (commercial use permitted).
// Never scrape or re-upload content from TikTok/YouTube/Instagram - see
// migrations/121_add_is_bot_flags.sql and bot-persona.util for the related
// bot disclosure requirements this depends on.
@Injectable()
export class VideoFeedsService {
  private readonly logger = new Logger(VideoFeedsService.name);
  private config: VideoFeedsConfig;
  private personas: BotPersona[] = [];
  private configPath: string;
  private personasPath: string;
  private usedVideoIds: Set<string> = new Set();
  private usedItemsPath: string;
  private supabaseClient: any;

  constructor(private readonly configService: ConfigService) {
    this.supabaseClient = createServiceSupabaseClient(this.configService);
    this.configPath = path.join(process.cwd(), 'video-feeds-config.json');
    this.personasPath = path.join(process.cwd(), 'content-bots.json');
    this.usedItemsPath = path.join(process.cwd(), 'video-feeds-used-items.json');
    this.loadConfig();
    this.loadPersonas();
    this.loadUsedItems();
  }

  private loadConfig(): void {
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    this.config = JSON.parse(raw);
    this.logger.log('Video feeds config loaded');
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
        this.usedVideoIds = new Set(data);
      }
    } catch (error) {
      this.logger.warn('Could not load used video items', error.message);
    }
  }

  private saveUsedItems(): void {
    const max = this.config.settings.max_recent_videos_remembered;
    let ids = Array.from(this.usedVideoIds);
    if (ids.length > max) {
      ids = ids.slice(ids.length - max);
      this.usedVideoIds = new Set(ids);
    }
    fs.writeFileSync(this.usedItemsPath, JSON.stringify(ids, null, 2));
  }

  getConfig(): VideoFeedsConfig {
    return this.config;
  }

  getPersonas(): BotPersona[] {
    return this.personas;
  }

  async updateSettings(settings: Partial<VideoFeedsConfig['settings']>): Promise<void> {
    this.config.settings = { ...this.config.settings, ...settings };
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    this.logger.log('Video feeds settings updated');
  }

  private randomPick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async fetchVideoForNiche(niche: string): Promise<SourcedVideo | null> {
    const nicheContent = this.config.niches[niche];
    if (!nicheContent) return null;

    const term = this.randomPick(nicheContent.search_terms);
    const sources = this.shuffle([...this.config.settings.video_sources]);

    for (const source of sources) {
      try {
        const video = await this.fetchFromSource(source as any, term);
        if (video && !this.usedVideoIds.has(video.videoId)) {
          return video;
        }
      } catch (error) {
        this.logger.warn(`${source} fetch failed for "${term}": ${error.message}`);
      }
    }
    return null;
  }

  private async fetchFromSource(source: 'pexels' | 'pixabay', query: string): Promise<SourcedVideo | null> {
    if (source === 'pexels') return this.fetchFromPexels(query);
    if (source === 'pixabay') return this.fetchFromPixabay(query);
    return null;
  }

  private async fetchFromPexels(query: string): Promise<SourcedVideo | null> {
    const apiKey = this.configService.get<string>('PEXELS_API_KEY');
    if (!apiKey) return null;

    const page = Math.floor(Math.random() * 5) + 1;
    const res = await axios.get('https://api.pexels.com/videos/search', {
      params: { query, per_page: 15, page },
      headers: { Authorization: apiKey },
    });

    const videos = res.data?.videos || [];
    if (videos.length === 0) return null;

    const video: any = this.randomPick<any>(videos);
    const files = video.video_files || [];
    const file = files.find((f: any) => f.quality === 'hd') || files[0];
    if (!file) return null;

    return {
      videoUrl: file.link,
      thumbnailUrl: video.image,
      source: 'pexels',
      photographer: video.user?.name,
      sourceLink: video.url,
      videoId: `pexels-${video.id}`,
    };
  }

  private async fetchFromPixabay(query: string): Promise<SourcedVideo | null> {
    const apiKey = this.configService.get<string>('PIXABAY_API_KEY');
    if (!apiKey) return null;

    const page = Math.floor(Math.random() * 5) + 1;
    const res = await axios.get('https://pixabay.com/api/videos/', {
      params: { key: apiKey, q: query, per_page: 15, page, safesearch: true },
    });

    const hits = res.data?.hits || [];
    if (hits.length === 0) return null;

    const video: any = this.randomPick<any>(hits);
    const file = video.videos?.medium || video.videos?.small || video.videos?.large;
    if (!file) return null;

    return {
      videoUrl: file.url,
      thumbnailUrl: undefined,
      source: 'pixabay',
      photographer: video.user,
      sourceLink: video.pageURL,
      videoId: `pixabay-${video.id}`,
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

  async createVideoPost(persona: BotPersona, botUserId: string): Promise<any> {
    const niche = persona.niche || 'dance';
    const video = await this.fetchVideoForNiche(niche);
    if (!video) {
      throw new Error(`No video found for niche ${niche}`);
    }

    const caption = this.generateCaption(niche);
    let content = caption;

    if (this.config.settings.show_attribution && video.photographer) {
      content = `${caption}\n\n🎥 ${video.photographer} / ${video.source}`;
    }

    const { data: post, error } = await insertBotPost(this.supabaseClient, {
      user_id: botUserId,
      content,
      media_urls: [video.videoUrl],
      media_type: 'video',
      privacy_level: 'public',
    });

    if (error) throw error;

    const { error: mediaError } = await this.supabaseClient.from('post_media').insert({
      post_id: post.id,
      media_type: 'video',
      media_url: video.videoUrl,
      order_index: 0,
    });

    if (mediaError) {
      this.logger.warn(`Failed to insert post_media row for post ${post.id}`, mediaError.message);
    }

    this.usedVideoIds.add(video.videoId);
    this.saveUsedItems();

    this.logger.log(`Posted video (${video.source}) for ${persona.username}: "${caption}"`);
    return post;
  }
}
