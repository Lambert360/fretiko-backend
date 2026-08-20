import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { RssFeedsService } from './rss-feeds.service';
import { RssFeedsScheduler } from './rss-feeds.scheduler';

@Controller('admin/rss-feeds')
export class RssFeedsController {
  constructor(
    private readonly rssFeedsService: RssFeedsService,
    private readonly rssFeedsScheduler: RssFeedsScheduler,
  ) {}

  @Get('config')
  getConfig() {
    return {
      success: true,
      config: this.rssFeedsService.getConfig(),
    };
  }

  @Get('status')
  getStatus() {
    const queueStatus = this.rssFeedsScheduler.getQueueStatus();
    return {
      success: true,
      status: {
        ...queueStatus,
        processedItemsCount: this.rssFeedsService.getProcessedItemsCount(),
        isEnabled: this.rssFeedsService.getConfig().settings.enable_auto_posting,
      },
    };
  }

  @Get('feeds/:category')
  getFeeds(@Param('category') category: string) {
    const config = this.rssFeedsService.getConfig();
    const feeds = config.feeds[category];
    
    if (!feeds) {
      return { success: false, message: 'Category not found' };
    }

    return { success: true, feeds };
  }

  @Post('fetch')
  async fetchFeeds() {
    try {
      const items = await this.rssFeedsService.fetchAllFeeds();
      return {
        success: true,
        message: `Fetched ${items.length} items from RSS feeds`,
        itemsCount: items.length,
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  @Post('post-now')
  async postNow() {
    return await this.rssFeedsScheduler.manualFetchAndPost();
  }

  @Put('toggle-feed/:category/:feedName')
  async toggleFeed(
    @Param('category') category: string,
    @Param('feedName') feedName: string,
    @Body('active') active: boolean,
  ) {
    try {
      await this.rssFeedsService.toggleFeed(category, feedName, active);
      return { success: true, message: `Feed ${feedName} updated` };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  @Put('settings')
  async updateSettings(@Body() settings: any) {
    try {
      const config = this.rssFeedsService.getConfig();
      await this.rssFeedsService.updateConfig({
        ...config,
        settings: { ...config.settings, ...settings },
      });
      return { success: true, message: 'Settings updated' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  @Delete('queue')
  clearQueue() {
    this.rssFeedsScheduler.clearQueue();
    return { success: true, message: 'Queue cleared' };
  }

  @Delete('processed-items')
  clearProcessedItems() {
    this.rssFeedsService.clearProcessedItems();
    return { success: true, message: 'Processed items cleared' };
  }

  @Get('preview/:feedUrl')
  async previewFeed(@Param('feedUrl') feedUrl: string) {
    try {
      const decodedUrl = decodeURIComponent(feedUrl);
      const feed = await this.rssFeedsService.fetchFeed(decodedUrl);
      
      return {
        success: true,
        feed: {
          title: feed.title,
          description: feed.description,
          link: feed.link,
          itemsCount: feed.items.length,
          items: feed.items.slice(0, 5).map((item) => ({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
          })),
        },
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}
