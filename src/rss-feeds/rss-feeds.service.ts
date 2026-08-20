import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Parser from 'rss-parser';
import * as fs from 'fs';
import * as path from 'path';
import { createServiceSupabaseClient } from '../shared/supabase.client';

export interface RssFeed {
  name: string;
  url: string;
  category: string;
  active: boolean;
  note?: string;
}

export interface RssConfig {
  feeds: Record<string, RssFeed[]>;
  settings: {
    fetch_interval_minutes: number;
    max_items_per_fetch: number;
    post_interval_minutes: number;
    enable_auto_posting: boolean;
    categories_enabled: string[];
  };
}

export interface ParsedFeedItem {
  title: string;
  content: string;
  description: string;
  link: string;
  pubDate: Date;
  category: string;
  tags: string[];
  location?: string;
  feedName: string;
  imageUrl?: string;
  author?: string;
}

@Injectable()
export class RssFeedsService {
  private readonly logger = new Logger(RssFeedsService.name);
  private parser: Parser;
  private config: RssConfig;
  private configPath: string;
  private processedItems: Set<string> = new Set();
  private supabaseClient: any;

  constructor(private readonly configService: ConfigService) {
    this.supabaseClient = createServiceSupabaseClient(this.configService);
    this.parser = new Parser({
      customFields: {
        item: [
          ['media:content', 'media'],
          ['media:thumbnail', 'thumbnail'],
          ['enclosure', 'enclosure'],
          ['content:encoded', 'contentEncoded'],
          ['georss:point', 'geoPoint'],
          ['geo:lat', 'geoLat'],
          ['geo:long', 'geoLong'],
        ],
      },
    });
    this.configPath = path.join(process.cwd(), 'rss-feeds-config.json');
    this.loadConfig();
    this.loadProcessedItems();
  }

  private loadConfig(): void {
    try {
      const configData = fs.readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(configData);
      this.logger.log('RSS config loaded successfully');
    } catch (error) {
      this.logger.error('Failed to load RSS config', error.stack);
      throw new Error('RSS configuration file not found');
    }
  }

  private loadProcessedItems(): void {
    try {
      const itemsPath = path.join(process.cwd(), 'rss-processed-items.json');
      if (fs.existsSync(itemsPath)) {
        const data = fs.readFileSync(itemsPath, 'utf-8');
        const items = JSON.parse(data);
        this.processedItems = new Set(items);
        this.logger.log(`Loaded ${this.processedItems.size} processed items`);
      }
    } catch (error) {
      this.logger.warn('Could not load processed items', error.message);
    }
  }

  private saveProcessedItems(): void {
    try {
      const itemsPath = path.join(process.cwd(), 'rss-processed-items.json');
      const items = Array.from(this.processedItems);
      fs.writeFileSync(itemsPath, JSON.stringify(items, null, 2));
    } catch (error) {
      this.logger.error('Failed to save processed items', error.stack);
    }
  }

  async fetchFeed(feedUrl: string): Promise<Parser.Output<any>> {
    try {
      const feed = await this.parser.parseURL(feedUrl);
      return feed;
    } catch (error) {
      this.logger.error(`Failed to fetch feed: ${feedUrl}`, error.stack);
      throw error;
    }
  }

  async fetchAllFeeds(): Promise<ParsedFeedItem[]> {
    const allItems: ParsedFeedItem[] = [];
    const enabledCategories = this.config.settings.categories_enabled;

    for (const categoryKey of enabledCategories) {
      const feeds = this.config.feeds[categoryKey];
      if (!feeds) continue;

      for (const feed of feeds) {
        if (!feed.active) continue;

        try {
          this.logger.log(`Fetching feed: ${feed.name} (${feed.url})`);
          const parsedFeed = await this.fetchFeed(feed.url);
          
          const items = parsedFeed.items
            .slice(0, this.config.settings.max_items_per_fetch)
            .map((item) => this.parseFeedItem(item, feed));

          allItems.push(...items);
          this.logger.log(`Fetched ${items.length} items from ${feed.name}`);
        } catch (error) {
          this.logger.error(`Error fetching ${feed.name}:`, error.message);
        }
      }
    }

    return allItems;
  }

  private parseFeedItem(item: any, feed: RssFeed): ParsedFeedItem {
    const imageUrl = this.extractImageUrl(item);
    const rawText = item.contentEncoded || item.content || item.contentSnippet || item.description || '';

    const itemCategories: string[] = Array.isArray(item.categories)
      ? item.categories.filter((c: any) => typeof c === 'string' && c.trim().length > 0)
      : [];
    const tags = Array.from(new Set([feed.category, ...itemCategories].filter(Boolean)));

    return {
      title: item.title || 'Untitled',
      content: this.cleanContent(rawText, 280),
      description: this.cleanContent(rawText, 900),
      link: item.link || '',
      pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
      category: feed.category,
      tags,
      location: this.extractLocation(item),
      feedName: feed.name,
      imageUrl,
      author: item.creator || item.author || feed.name,
    };
  }

  private extractLocation(item: any): string | undefined {
    if (item.geoPoint) {
      return String(item.geoPoint).trim();
    }
    if (item.geoLat && item.geoLong) {
      return `${item.geoLat}, ${item.geoLong}`;
    }
    return undefined;
  }

  private extractImageUrl(item: any): string | undefined {
    if (item.enclosure?.url) return item.enclosure.url;
    if (item.media?.$ && item.media.$.url) return item.media.$.url;
    if (item.thumbnail?.$ && item.thumbnail.$.url) return item.thumbnail.$.url;
    
    const content = item.contentEncoded || item.content || item.description || '';
    const imgMatch = content.match(/<img[^>]+src="([^">]+)"/);
    return imgMatch ? imgMatch[1] : undefined;
  }

  private cleanContent(content: string, maxLength = 500): string {
    return content
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .substring(0, maxLength)
      .trim();
  }

  async getNewItems(): Promise<ParsedFeedItem[]> {
    const allItems = await this.fetchAllFeeds();
    
    const newItems = allItems.filter((item) => {
      const itemId = `${item.link}-${item.title}`;
      return !this.processedItems.has(itemId);
    });

    this.logger.log(`Found ${newItems.length} new items out of ${allItems.length} total`);
    return newItems;
  }

  async markItemAsProcessed(item: ParsedFeedItem): Promise<void> {
    const itemId = `${item.link}-${item.title}`;
    this.processedItems.add(itemId);
    
    if (this.processedItems.size % 10 === 0) {
      this.saveProcessedItems();
    }
  }

  buildCaptionFromItem(item: ParsedFeedItem): string {
    const parts: string[] = [item.title.trim()];

    if (item.description && item.description !== item.title) {
      parts.push(item.description);
    }

    if (item.location) {
      parts.push(`📍 ${item.location}`);
    }

    const hashtagSource = item.tags.length > 0 ? item.tags : [item.category];
    const hashtags = hashtagSource
      .slice(0, 4)
      .map((t) => `#${t.replace(/[^a-zA-Z0-9]/g, '')}`)
      .filter((t) => t.length > 1)
      .join(' ');

    if (hashtags) parts.push(hashtags);

    return parts.join('\n\n');
  }

  async createPostFromRssItem(item: ParsedFeedItem, botUserId: string): Promise<any> {
    try {
      const content = this.buildCaptionFromItem(item);
      const hasImage = !!item.imageUrl;

      const { data: post, error } = await this.supabaseClient
        .from('posts')
        .insert({
          user_id: botUserId,
          content,
          media_urls: hasImage ? [item.imageUrl] : [],
          media_type: hasImage ? 'image' : 'text',
          privacy_level: 'public',
        })
        .select()
        .single();

      if (error) throw error;

      if (hasImage) {
        const { error: mediaError } = await this.supabaseClient
          .from('post_media')
          .insert({
            post_id: post.id,
            media_type: 'image',
            media_url: item.imageUrl,
            order_index: 0,
          });
        if (mediaError) {
          this.logger.warn(`Failed to insert post_media row for post ${post.id}`, mediaError.message);
        }
      }

      this.logger.log(`Created post from RSS: ${item.title}`);
      await this.markItemAsProcessed(item);

      return post;
    } catch (error) {
      this.logger.error('Failed to create post from RSS item', error.stack);
      throw error;
    }
  }

  getConfig(): RssConfig {
    return this.config;
  }

  async updateConfig(newConfig: Partial<RssConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    this.logger.log('RSS config updated');
  }

  async toggleFeed(categoryKey: string, feedName: string, active: boolean): Promise<void> {
    const feeds = this.config.feeds[categoryKey];
    if (!feeds) throw new Error(`Category ${categoryKey} not found`);

    const feed = feeds.find((f) => f.name === feedName);
    if (!feed) throw new Error(`Feed ${feedName} not found in category ${categoryKey}`);

    feed.active = active;
    await this.updateConfig(this.config);
    this.logger.log(`Feed ${feedName} set to ${active ? 'active' : 'inactive'}`);
  }

  getProcessedItemsCount(): number {
    return this.processedItems.size;
  }

  clearProcessedItems(): void {
    this.processedItems.clear();
    this.saveProcessedItems();
    this.logger.log('Cleared all processed items');
  }
}
