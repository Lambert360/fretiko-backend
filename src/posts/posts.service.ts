import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { TagsService } from '../tags/tags.service';
import { MentionsService } from '../mentions/mentions.service';
import { ServicesService } from '../services/services.service';
import { VideoProcessingHelper } from '../shared/video-processing.helper';
import { Post, PostInteraction, PostMedia, UnifiedFeedItem, LiveStreamData, UserInfo, InteractionType, MediaType, PrivacyLevel, FeedItemType } from './interfaces/post.interface';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { CreateInteractionDto } from './dto/interaction.dto';
import { FeedQueryDto } from './dto/feed-query.dto';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

@Injectable()
export class PostsService {
  constructor(
    private configService: ConfigService,
    private tagsService: TagsService,
    private mentionsService: MentionsService,
    private servicesService: ServicesService,
  ) {}

  private get supabase() {
    return createServiceSupabaseClient(this.configService);
  }

  // Create a new post
  async create(userId: string, createPostDto: CreatePostDto): Promise<Post> {
    const { data: post, error } = await this.supabase
      .from('posts')
      .insert({
        user_id: userId,
        content: createPostDto.content || null,
        media_urls: createPostDto.media?.map(m => m.mediaUrl) || [],
        media_type: createPostDto.mediaType || this.determineMediaType(createPostDto.media),
        privacy_level: createPostDto.privacyLevel || PrivacyLevel.PUBLIC,
      })
      .select()
      .single();

    if (error) throw error;

    // Insert media metadata if provided
    let insertedMedia: any[] | null = null;
    if (createPostDto.media && createPostDto.media.length > 0) {
      const mediaData = createPostDto.media.map((m, index) => ({
        post_id: post.id,
        media_type: m.mediaType,
        media_url: m.mediaUrl,
        thumbnail_url: m.thumbnailUrl || null,
        duration: m.duration != null ? Math.round(m.duration) : null,
        width: m.width || null,
        height: m.height || null,
        mime_type: m.mimeType || null,
        file_size: m.fileSize || null,
        order_index: index,
      }));

      const { data: mediaResult, error: mediaError } = await this.supabase
        .from('post_media')
        .insert(mediaData)
        .select('id, media_url, media_type, thumbnail_url, order_index');
      insertedMedia = mediaResult;

      if (mediaError) throw mediaError;

      // Fire-and-forget video processing for incompatible codecs
      if (insertedMedia && insertedMedia.length > 0) {
        insertedMedia.forEach((mediaItem: any, index: number) => {
          if (mediaItem.media_type === 'video') {
            VideoProcessingHelper.checkAndQueue(
              mediaItem.media_url,
              userId,
              'post_media',
              mediaItem.id,
              index,
              post.id,
            ).catch(() => {
              // Silent fail — original video still works
            });
          }
        });
      }
    }

    // Attach media metadata so mapToPost can include thumbnail URLs
    post.post_media = insertedMedia || [];

    const mapped = this.mapToPost(post);

    // Sync tags and mentions (fire-and-forget style, but awaited here for consistency)
    try {
      await this.tagsService.syncTaggings(post.id, 'post', createPostDto.content || null);
    } catch (e) {
      // Do not block post creation on tag failures
      console.error('Failed to sync tags for post', post.id, e);
    }

    try {
      await this.mentionsService.createMentions(userId, post.id, 'post', createPostDto.content || null);
    } catch (e) {
      console.error('Failed to create mentions for post', post.id, e);
    }

    return mapped;
  }

  // Upload media to Supabase storage
  async uploadMedia(userId: string, file: Express.Multer.File): Promise<{ url: string; path: string; thumbnailUrl?: string }> {
    try {
      const fileExt = file.originalname.split('.').pop() || 'jpg';
      const fileName = `${userId}/posts/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      
      const { data, error } = await this.supabase.storage
        .from('posts-media')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '3600',
          upsert: false,
        });

      if (error) {
        throw new Error(`Upload failed: ${error.message}`);
      }

      // Get public URL
      const { data: publicUrlData } = this.supabase.storage
        .from('posts-media')
        .getPublicUrl(data.path);

      // Generate a JPG thumbnail for videos at the 1-second mark
      let thumbnailUrl: string | undefined;
      if (file.mimetype?.startsWith('video/')) {
        thumbnailUrl = await this.generateVideoThumbnail(file.buffer, userId);
      }

      return {
        url: publicUrlData.publicUrl,
        path: data.path,
        thumbnailUrl,
      };
    } catch (error) {
      console.error('Media upload error:', error);
      throw error;
    }
  }

  // Generate a thumbnail from a video file using ffmpeg
  private async generateVideoThumbnail(videoBuffer: Buffer, userId: string): Promise<string | undefined> {
    const tempDir = os.tmpdir();
    const timestamp = Date.now();
    const videoPath = path.join(tempDir, `post-video-${timestamp}.mp4`);
    const thumbnailPath = path.join(tempDir, `post-thumb-${timestamp}.jpg`);

    try {
      fs.writeFileSync(videoPath, videoBuffer);
      const ffmpegCommand = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=640:-1" -y "${thumbnailPath}"`;
      await execAsync(ffmpegCommand);

      if (!fs.existsSync(thumbnailPath)) {
        console.warn('⚠️ Thumbnail file not generated');
        return undefined;
      }

      const thumbnailBuffer = fs.readFileSync(thumbnailPath);
      const uniqueFileName = `${userId}/posts/${timestamp}-thumb.jpg`;
      const { data, error } = await this.supabase.storage
        .from('posts-media')
        .upload(uniqueFileName, thumbnailBuffer, {
          contentType: 'image/jpeg',
          cacheControl: '3600',
          upsert: false,
        });

      if (error) {
        console.warn('⚠️ Thumbnail upload failed:', error.message);
        return undefined;
      }

      const { data: publicUrlData } = this.supabase.storage
        .from('posts-media')
        .getPublicUrl(data.path);

      return publicUrlData.publicUrl;
    } catch (error) {
      console.error('⚠️ Failed to generate post video thumbnail:', error);
      return undefined;
    } finally {
      try {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // Get post by ID with user info and interactions
  async findById(id: string, currentUserId?: string): Promise<Post> {
    const { data: post, error } = await this.supabase
      .from('posts')
      .select(`
        *,
        user:user_profiles(id, username, avatar_url, is_verified, display_name)
      `)
      .eq('id', id)
      .eq('is_deleted', false)
      .single();

    if (error || !post) {
      throw new NotFoundException('Post not found');
    }

    // Load per-media metadata so mapToPost can build thumbnailUrls
    const { data: postMedia, error: postMediaError } = await this.supabase
      .from('post_media')
      .select('id, media_url, media_type, thumbnail_url, order_index')
      .eq('post_id', id)
      .order('order_index');
    if (postMediaError) {
      console.error('Failed to fetch post media:', postMediaError);
    }
    post.post_media = postMedia || [];

    const mappedPost = this.mapToPost(post);
    
    // Add user info
    if (post.user) {
      mappedPost.user = this.mapToUserInfo(post.user);
    }

    // Check if current user has liked/bookmarked
    if (currentUserId) {
      mappedPost.isLiked = await this.hasUserLiked(id, currentUserId);
      mappedPost.isBookmarked = await this.hasUserBookmarked(id, currentUserId);
    }

    return mappedPost;
  }

  // Get posts by user
  async findByUser(userId: string, currentUserId?: string, limit: number = 20, offset: number = 0): Promise<Post[]> {
    const { data: posts, error } = await this.supabase
      .from('posts')
      .select(`
        *,
        user:user_profiles(id, username, avatar_url, is_verified, display_name),
        post_media(id, media_url, media_type, thumbnail_url, order_index)
      `)
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return Promise.all(posts.map(async (post) => {
      const mapped = this.mapToPost(post);
      if (post.user) mapped.user = this.mapToUserInfo(post.user);
      
      if (currentUserId) {
        mapped.isLiked = await this.hasUserLiked(post.id, currentUserId);
        mapped.isBookmarked = await this.hasUserBookmarked(post.id, currentUserId);
      }
      
      return mapped;
    }));
  }

  // Generate personalized feed (mix of posts and services)
  async getFeed(userId: string, query: FeedQueryDto): Promise<UnifiedFeedItem[]> {
    const { limit = 20, offset = 0 } = query;

    // Candidate pool must grow with the requested offset, otherwise deep pages
    // keep re-slicing the same fixed-size window and pagination dead-ends
    // long before the database is actually exhausted.
    const candidatePoolSize = offset + limit * 2;

    // Get posts for feed
    const { data: posts, error: postsError } = await this.supabase
      .from('posts')
      .select(`
        *,
        user:user_profiles(id, username, avatar_url, is_verified, display_name),
        post_media(id, media_url, media_type, thumbnail_url, order_index)
      `)
      .eq('is_deleted', false)
      .eq('privacy_level', PrivacyLevel.PUBLIC)
      .order('created_at', { ascending: false })
      .range(0, candidatePoolSize); // Get more to mix with services

    if (postsError) throw postsError;

    // Bulk-fetch bookmark counts for candidate posts (avoids N+1 count queries)
    const postIds = (posts || []).map((p) => p.id);
    const bookmarkCountsByPost = await this.getBookmarkCountsForPosts(postIds);

    const postFeedItems: UnifiedFeedItem[] = await Promise.all(
      posts.map(async (post) => {
        const mappedPost = this.mapToPost(post);
        if (post.user) mappedPost.user = this.mapToUserInfo(post.user);
        mappedPost.isLiked = await this.hasUserLiked(post.id, userId);
        mappedPost.isBookmarked = await this.hasUserBookmarked(post.id, userId);

        return {
          id: post.id,
          type: FeedItemType.POST,
          itemId: post.id,
          score: this.calculatePostScore(mappedPost, bookmarkCountsByPost.get(post.id) || 0),
          isSeen: false,
          createdAt: new Date(post.created_at),
          postData: mappedPost,
        };
      })
    );

    // Get service videos to mix into the unified feed (fetch extra candidates, same as posts above)
    let serviceFeedItems: UnifiedFeedItem[] = [];
    try {
      const services = await this.servicesService.getVideoFeed(userId, { limit: candidatePoolSize, offset: 0 });
      serviceFeedItems = services.map((service: any) => ({
        id: `service-${service.id}`,
        type: FeedItemType.SERVICE,
        itemId: service.id,
        score: this.calculateServiceScore(service),
        isSeen: false,
        createdAt: service.createdAt ? new Date(service.createdAt) : new Date(),
        serviceData: service,
      }));
    } catch (serviceError) {
      // Service videos are non-critical to the feed; log and continue with posts only
      console.error('Failed to load service videos for unified feed:', serviceError);
    }

    // Get active live streams to mix into the unified feed
    let liveStreamFeedItems: UnifiedFeedItem[] = [];
    try {
      const { data: liveStreams, error: liveError } = await this.supabase
        .from('live_stream_stats')
        .select(`
          id,
          vendor_id,
          title,
          description,
          stream_type,
          status,
          viewer_count,
          total_viewers,
          total_sales,
          current_viewers,
          total_comments,
          total_reactions,
          total_gifts,
          total_transactions,
          thumbnail_url,
          preview_video_url,
          stream_url,
          created_at,
          started_at,
          vendor:user_profiles!vendor_id (
            id,
            username,
            avatar_url,
            is_verified,
            display_name
          )
        `)
        .eq('status', 'live')
        .order('viewer_count', { ascending: false })
        .order('started_at', { ascending: false })
        .range(0, Math.min(candidatePoolSize, 20));

      if (!liveError && liveStreams) {
        // Bulk-fetch the lowest live price for product streams
        const liveStreamIds = liveStreams.map((s: any) => s.id);
        let lowestProductPrices = new Map<string, number>();

        if (liveStreamIds.length > 0) {
          const { data: productPrices, error: priceError } = await this.supabase
            .from('live_stream_products')
            .select('stream_id, live_price')
            .in('stream_id', liveStreamIds);

          if (!priceError && productPrices) {
            productPrices.forEach((p: any) => {
              const current = lowestProductPrices.get(p.stream_id) ?? Infinity;
              if (typeof p.live_price === 'number' && p.live_price < current) {
                lowestProductPrices.set(p.stream_id, p.live_price);
              }
            });
          }
        }

        liveStreamFeedItems = liveStreams.map((stream: any) => {
          const lowestPrice = lowestProductPrices.get(stream.id);
          const mappedStream = this.mapToLiveStreamData(stream, lowestPrice);
          return {
            id: `live-stream-${stream.id}`,
            type: FeedItemType.LIVE_STREAM,
            itemId: stream.id,
            score: this.calculateLiveStreamScore(mappedStream),
            isSeen: false,
            createdAt: mappedStream.startedAt || mappedStream.createdAt,
            liveStreamData: mappedStream,
          };
        });
      }
    } catch (liveStreamError) {
      // Live streams are non-critical to the feed; log and continue
      console.error('Failed to load live streams for unified feed:', liveStreamError);
    }

    // Merge candidates from all sources — no fixed ratio
    let feedItems: UnifiedFeedItem[] = [...postFeedItems, ...serviceFeedItems, ...liveStreamFeedItems];

    // Soft-downrank items the user has already seen recently/repeatedly, so
    // unseen/fresh content is prioritized (Facebook-style "unread bump")
    feedItems = await this.applySeenPenalty(userId, feedItems);

    // Small jitter so near-equal-score items don't always sort in the exact
    // same order, without breaking the overall ranking. This MUST be
    // deterministic per item (not Math.random()) — otherwise the relative
    // order of the candidate pool changes on every single request, which
    // breaks offset-based pagination: slicing a differently-shuffled array
    // on each call causes deep pages to re-return items already sent on
    // earlier pages (they get deduped client-side and the feed appears to
    // stop loading / infinite scroll dead-ends).
    feedItems = feedItems.map((item) => ({
      ...item,
      score: item.score * (0.94 + this.seededJitter(item.id) * 0.12),
    }));

    feedItems.sort((a, b) => b.score - a.score);

    // Author-diversity re-rank: avoid the same author/creator appearing twice
    // in a row (TikTok/Facebook-style anti-repetition rule)
    feedItems = this.applyAuthorDiversity(feedItems);

    const page = feedItems.slice(offset, offset + limit);

    // Fire-and-forget: record impressions for the items being returned
    this.recordImpressions(userId, page).catch((e) =>
      console.error('Failed to record feed impressions:', e),
    );

    return page;
  }

  // Bulk-fetch bookmark counts for a set of post IDs in a single query
  private async getBookmarkCountsForPosts(postIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (postIds.length === 0) return counts;

    const { data, error } = await this.supabase
      .from('post_bookmarks')
      .select('post_id')
      .in('post_id', postIds);

    if (error || !data) return counts;

    data.forEach((row: { post_id: string }) => {
      counts.set(row.post_id, (counts.get(row.post_id) || 0) + 1);
    });
    return counts;
  }

  // Downrank items the user has already seen, scaled by how many times seen
  // and how recently. Items seen long ago (>24h) recover most of their score,
  // mirroring how X/Facebook/TikTok resurface content after enough time passes.
  private async applySeenPenalty(userId: string, items: UnifiedFeedItem[]): Promise<UnifiedFeedItem[]> {
    if (items.length === 0) return items;

    const { data: impressions, error } = await this.supabase
      .from('user_feed_impressions')
      .select('item_type, item_id, seen_count, last_seen_at')
      .eq('user_id', userId)
      .in('item_id', items.map((i) => i.itemId));

    if (error || !impressions || impressions.length === 0) return items;

    const impressionMap = new Map<string, { seenCount: number; lastSeenAt: Date }>();
    impressions.forEach((imp: any) => {
      impressionMap.set(`${imp.item_type}-${imp.item_id}`, {
        seenCount: imp.seen_count,
        lastSeenAt: new Date(imp.last_seen_at),
      });
    });

    return items.map((item) => {
      const impression = impressionMap.get(`${item.type}-${item.itemId}`);
      if (!impression) {
        item.isSeen = false;
        return item;
      }

      const hoursSinceSeen = (Date.now() - impression.lastSeenAt.getTime()) / (1000 * 60 * 60);
      // Recovers fully after ~48h; heavier repeat views decay score more
      const recoveryFactor = Math.min(1, hoursSinceSeen / 48);
      const repeatPenalty = Math.min(0.85, impression.seenCount * 0.2);
      const penalty = repeatPenalty * (1 - recoveryFactor);

      item.isSeen = true;
      item.score = item.score * (1 - penalty);
      return item;
    });
  }

  // Deterministic pseudo-random value in [0, 1) derived from an item's id.
  // Used instead of Math.random() for score jitter so that the relative
  // ordering of a given candidate pool stays stable across paginated
  // requests within the same feed pool (see comment at call site).
  private seededJitter(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash << 5) - hash + id.charCodeAt(i);
      hash |= 0;
    }
    return (hash >>> 0) / 4294967295;
  }

  // Ensure the same author/creator doesn't appear twice in a row in the final feed
  private applyAuthorDiversity(items: UnifiedFeedItem[]): UnifiedFeedItem[] {
    const result: UnifiedFeedItem[] = [];
    const remaining = [...items];

    while (remaining.length > 0) {
      const lastAuthorId = result.length > 0 ? this.getAuthorId(result[result.length - 1]) : null;

      let pickIndex = remaining.findIndex((item) => this.getAuthorId(item) !== lastAuthorId);
      if (pickIndex === -1) pickIndex = 0; // No alternative available; take the next best item

      result.push(remaining[pickIndex]);
      remaining.splice(pickIndex, 1);
    }

    return result;
  }

  private getAuthorId(item: UnifiedFeedItem): string | null {
    if (item.type === FeedItemType.POST) return item.postData?.userId || null;
    if (item.type === FeedItemType.LIVE_STREAM) return item.liveStreamData?.vendorId || null;
    return item.serviceData?.userId || null;
  }

  // Fire-and-forget upsert of feed impressions for items shown to the user
  private async recordImpressions(userId: string, items: UnifiedFeedItem[]): Promise<void> {
    if (items.length === 0) return;

    const { data: existing } = await this.supabase
      .from('user_feed_impressions')
      .select('item_type, item_id, seen_count')
      .eq('user_id', userId)
      .in('item_id', items.map((i) => i.itemId));

    const existingMap = new Map<string, number>();
    (existing || []).forEach((row: any) => {
      existingMap.set(`${row.item_type}-${row.item_id}`, row.seen_count);
    });

    const now = new Date().toISOString();
    const rows = items.map((item) => {
      const key = `${item.type}-${item.itemId}`;
      const previousCount = existingMap.get(key) || 0;
      return {
        user_id: userId,
        item_type: item.type,
        item_id: item.itemId,
        seen_count: previousCount + 1,
        last_seen_at: now,
      };
    });

    await this.supabase
      .from('user_feed_impressions')
      .upsert(rows, { onConflict: 'user_id,item_type,item_id' });
  }

  // Update post
  async update(id: string, userId: string, updatePostDto: UpdatePostDto): Promise<Post> {
    const post = await this.findById(id);
    
    if (post.userId !== userId) {
      throw new ForbiddenException('You can only update your own posts');
    }

    const updateData: any = {};
    if (updatePostDto.content !== undefined) updateData.content = updatePostDto.content;
    if (updatePostDto.privacyLevel !== undefined) updateData.privacy_level = updatePostDto.privacyLevel;
    if (updatePostDto.isPinned !== undefined) updateData.is_pinned = updatePostDto.isPinned;
    if (updatePostDto.mediaType !== undefined) updateData.media_type = updatePostDto.mediaType;

    // Update media if provided
    if (updatePostDto.media) {
      updateData.media_urls = updatePostDto.media.map(m => m.mediaUrl);
      
      // Delete old media
      await this.supabase.from('post_media').delete().eq('post_id', id);
      
      // Insert new media
      const mediaData = updatePostDto.media.map((m, index) => ({
        post_id: id,
        media_type: m.mediaType,
        media_url: m.mediaUrl,
        thumbnail_url: m.thumbnailUrl || null,
        duration: m.duration != null ? Math.round(m.duration) : null,
        width: m.width || null,
        height: m.height || null,
        mime_type: m.mimeType || null,
        file_size: m.fileSize || null,
        order_index: index,
      }));

      await this.supabase.from('post_media').insert(mediaData);
    }

    const { data: updated, error } = await this.supabase
      .from('posts')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const contentForSync = updatePostDto.content !== undefined ? updatePostDto.content : updated.content;

    try {
      await this.tagsService.syncTaggings(id, 'post', contentForSync || null);
    } catch (e) {
      console.error('Failed to sync tags for updated post', id, e);
    }

    try {
      await this.mentionsService.createMentions(userId, id, 'post', contentForSync || null);
    } catch (e) {
      console.error('Failed to create mentions for updated post', id, e);
    }

    return this.findById(id, userId);
  }

  // Soft delete post
  async delete(id: string, userId: string): Promise<void> {
    const post = await this.findById(id);
    
    if (post.userId !== userId) {
      throw new ForbiddenException('You can only delete your own posts');
    }

    const { error } = await this.supabase
      .from('posts')
      .update({ is_deleted: true })
      .eq('id', id);

    if (error) throw error;
  }

  // Create interaction (like, comment, share, gift)
  async createInteraction(
    postId: string, 
    userId: string, 
    dto: CreateInteractionDto
  ): Promise<PostInteraction> {
    console.log('💬 createInteraction called:', { postId, userId, interactionType: dto.interactionType, parentCommentId: dto.parentCommentId });

    // Check if post exists and is not deleted
    await this.findById(postId);

    // For likes and shares, check if already exists (prevent duplicates)
    if (dto.interactionType === InteractionType.LIKE || dto.interactionType === InteractionType.SHARE) {
      const { data: existing } = await this.supabase
        .from('post_interactions')
        .select('id')
        .eq('post_id', postId)
        .eq('user_id', userId)
        .eq('interaction_type', dto.interactionType)
        .single();

      if (existing) {
        throw new ForbiddenException(`You have already ${dto.interactionType}d this post`);
      }
    }

    // Validate parent comment exists if this is a reply
    if (dto.parentCommentId) {
      const { data: parentComment, error: parentError } = await this.supabase
        .from('post_interactions')
        .select('id')
        .eq('id', dto.parentCommentId)
        .eq('interaction_type', InteractionType.COMMENT)
        .eq('post_id', postId)
        .single();

      if (parentError || !parentComment) {
        console.error('❌ Parent comment not found:', parentError);
        throw new NotFoundException('Parent comment not found');
      }
    }

    const { data: interaction, error } = await this.supabase
      .from('post_interactions')
      .insert({
        post_id: postId,
        user_id: userId,
        interaction_type: dto.interactionType,
        content: dto.content || null,
        gift_id: dto.giftId || null,
        parent_comment_id: dto.parentCommentId || null,
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating interaction:', error);
      throw error;
    }

    console.log('✅ Interaction created successfully:', interaction.id);
    // If this interaction is a comment, sync tags and mentions based on its content
    if (dto.interactionType === InteractionType.COMMENT && dto.content) {
      try {
        await this.tagsService.syncTaggings(interaction.id, 'comment', dto.content);
      } catch (e) {
        console.error('Failed to sync tags for comment', interaction.id, e);
      }

      try {
        await this.mentionsService.createMentions(userId, interaction.id, 'comment', dto.content);
      } catch (e) {
        console.error('Failed to create mentions for comment', interaction.id, e);
      }
    }

    return this.mapToInteraction(interaction);
  }

  // Remove interaction (unlike, delete comment, etc.)
  async removeInteraction(postId: string, userId: string, interactionType: InteractionType): Promise<void> {
    const { error } = await this.supabase
      .from('post_interactions')
      .delete()
      .eq('post_id', postId)
      .eq('user_id', userId)
      .eq('interaction_type', interactionType);

    if (error) throw error;
  }

  // Get comments for a post
  async getComments(postId: string, limit: number = 50, offset: number = 0): Promise<PostInteraction[]> {
    const { data: comments, error } = await this.supabase
      .from('post_interactions')
      .select(`
        *,
        user:user_profiles(id, username, avatar_url, is_verified, display_name)
      `)
      .eq('post_id', postId)
      .eq('interaction_type', InteractionType.COMMENT)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return comments.map(comment => {
      const mapped = this.mapToInteraction(comment);
      if (comment.user) mapped.user = this.mapToUserInfo(comment.user);
      return mapped;
    });
  }

  // Get comments with reaction counts for a specific user
  async getCommentsWithReactions(
    postId: string,
    userId: string,
    limit: number = 50,
    offset: number = 0,
    sortBy: 'popular' | 'newest' = 'popular'
  ): Promise<PostInteraction[]> {
    // Get comments
    let query = this.supabase
      .from('post_interactions')
      .select(`
        *,
        user:user_profiles(id, username, avatar_url, is_verified, display_name)
      `)
      .eq('post_id', postId)
      .eq('interaction_type', InteractionType.COMMENT)
      .range(offset, offset + limit - 1);

    // Apply sorting
    if (sortBy === 'popular') {
      // Sort by engagement score: likes + (gifts * 5)
      query = query.order('likes_count', { ascending: false });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    const { data: comments, error } = await query;

    if (error) throw error;

    // Get user's likes for these comments
    const commentIds = comments.map(c => c.id);
    const { data: userLikes } = await this.supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', userId)
      .in('comment_id', commentIds);

    const likedCommentIds = new Set(userLikes?.map(like => like.comment_id) || []);

    // Get user's gifts for these comments
    const { data: userGifts } = await this.supabase
      .from('comment_gifts')
      .select('comment_id')
      .eq('from_user_id', userId)
      .in('comment_id', commentIds);

    const giftedCommentIds = new Set(userGifts?.map(gift => gift.comment_id) || []);

    // Map comments with reaction data
    return comments.map(comment => {
      const mapped = this.mapToInteraction(comment);
      if (comment.user) mapped.user = this.mapToUserInfo(comment.user);
      
      // Add reaction counts
      mapped.likesCount = comment.likes_count || 0;
      mapped.giftsCount = comment.gifts_count || 0;
      mapped.isLiked = likedCommentIds.has(comment.id);
      mapped.isGifted = giftedCommentIds.has(comment.id);
      
      return mapped;
    });
  }

  // Like a comment
  async likeComment(commentId: string, userId: string): Promise<PostInteraction> {
    // Check if comment exists
    const { data: comment, error: commentError } = await this.supabase
      .from('post_interactions')
      .select('*')
      .eq('id', commentId)
      .eq('interaction_type', InteractionType.COMMENT)
      .single();

    if (commentError || !comment) {
      throw new NotFoundException('Comment not found');
    }

    // Check if already liked
    const { data: existingLike } = await this.supabase
      .from('comment_likes')
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .single();

    if (existingLike) {
      throw new ForbiddenException('You have already liked this comment');
    }

    // Create like record
    const { error: likeError } = await this.supabase
      .from('comment_likes')
      .insert({ comment_id: commentId, user_id: userId });

    if (likeError) throw likeError;

    // Return updated comment
    const mapped = this.mapToInteraction(comment);
    mapped.likesCount = (comment.likes_count || 0) + 1;
    mapped.isLiked = true;
    
    return mapped;
  }

  // Unlike a comment
  async unlikeComment(commentId: string, userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('comment_likes')
      .delete()
      .eq('comment_id', commentId)
      .eq('user_id', userId);

    if (error) throw error;
  }

  // Send gift to comment
  async sendGiftToComment(
    commentId: string,
    userId: string,
    giftId: string,
  ): Promise<PostInteraction> {
    console.log('🎁 sendGiftToComment called:', { commentId, userId, giftId });

    // Check if comment exists and get comment author
    const { data: comment, error: commentError } = await this.supabase
      .from('post_interactions')
      .select('id, user_id, gifts_count')
      .eq('id', commentId)
      .eq('interaction_type', InteractionType.COMMENT)
      .single();

    if (commentError || !comment) {
      console.error('❌ Comment not found:', commentError);
      throw new NotFoundException('Comment not found');
    }

    const receiverId = comment.user_id;

    // Resolve gift by ID (like live sales) - check both tables
    let gift: any = null;

    // First try gift_types table
    const { data: giftTypeRow } = await this.supabase
      .from('gift_types')
      .select('id, name, base_value, is_active')
      .eq('id', giftId)
      .eq('is_active', true)
      .single();

    if (giftTypeRow) {
      gift = giftTypeRow;
    } else {
      // Fallback to virtual_gifts table
      const { data: virtualGiftRow } = await this.supabase
        .from('virtual_gifts')
        .select('id, name, credit_value, is_active')
        .eq('id', giftId)
        .eq('is_active', true)
        .single();

      if (virtualGiftRow) {
        gift = {
          id: virtualGiftRow.id,
          name: virtualGiftRow.name,
          base_value: virtualGiftRow.credit_value,
          is_active: virtualGiftRow.is_active,
        };
      }
    }

    if (!gift) {
      console.error('❌ Gift not found:', giftId);
      throw new NotFoundException('Gift not found or inactive');
    }

    // Check if user owns the gift
    const { data: userGift, error: userGiftError } = await this.supabase
      .from('user_gifts')
      .select('id, quantity')
      .eq('user_id', userId)
      .eq('gift_id', gift.id)
      .single();

    if (userGiftError || !userGift || userGift.quantity < 1) {
      console.error('❌ User does not own this gift:', userGiftError);
      throw new ForbiddenException('You do not own this gift');
    }

    // Deduct from sender's user_gifts
    const newSenderQuantity = userGift.quantity - 1;
    let deductError: any = null;

    if (newSenderQuantity === 0) {
      // Delete record if quantity reaches 0
      const { error: deleteError } = await this.supabase
        .from('user_gifts')
        .delete()
        .eq('id', userGift.id);
      deductError = deleteError;
    } else {
      // Decrement quantity
      const { error: updateError } = await this.supabase
        .from('user_gifts')
        .update({ quantity: newSenderQuantity })
        .eq('id', userGift.id);
      deductError = updateError;
    }

    if (deductError) {
      console.error('❌ Error deducting from sender:', deductError);
      throw deductError;
    }

    // Add to receiver's user_gifts
    const { data: receiverGift, error: receiverGiftError } = await this.supabase
      .from('user_gifts')
      .select('id, quantity')
      .eq('user_id', receiverId)
      .eq('gift_id', gift.id)
      .single();

    let addError: any = null;

    if (receiverGift) {
      // Increment existing quantity
      const { error: updateError } = await this.supabase
        .from('user_gifts')
        .update({ quantity: receiverGift.quantity + 1 })
        .eq('id', receiverGift.id);
      addError = updateError;
    } else {
      // Create new record
      const { error: insertError } = await this.supabase
        .from('user_gifts')
        .insert({
          user_id: receiverId,
          gift_id: gift.id,
          quantity: 1,
          source: 'received_post',
          received_from: userId,
        });
      addError = insertError;
    }

    if (addError) {
      console.error('❌ Error adding to receiver:', addError);
      // Rollback: restore sender quantity
      await this.supabase
        .from('user_gifts')
        .upsert({ id: userGift.id, user_id: userId, gift_id: gift.id, quantity: userGift.quantity });
      throw addError;
    }

    // Log transaction (session_type is NULL for comments, not call/stream/auction)
    const { error: transactionError } = await this.supabase
      .from('gift_transactions')
      .insert({
        user_id: userId,
        gift_id: gift.id,
        quantity: 1,
        transaction_type: 'send',
        recipient_id: receiverId,
        session_type: null,
        session_id: commentId,
      });

    if (transactionError) {
      console.error('⚠️ Error logging transaction (non-critical):', transactionError);
      // Don't throw - transaction logging is non-critical
    }

    // Create gift record
    const { error: giftRecordError } = await this.supabase
      .from('comment_gifts')
      .insert({
        comment_id: commentId,
        from_user_id: userId,
        to_user_id: receiverId,
        gift_id: gift.id,
        gift_value: gift.base_value || 0,
      });

    if (giftRecordError) {
      console.error('❌ Error creating comment_gifts record:', giftRecordError);
      // Rollback: restore sender, remove from receiver
      await this.supabase.from('user_gifts').upsert({ id: userGift.id, user_id: userId, gift_id: gift.id, quantity: userGift.quantity });
      if (receiverGift) {
        await this.supabase.from('user_gifts').update({ quantity: receiverGift.quantity }).eq('id', receiverGift.id);
      } else {
        await this.supabase.from('user_gifts').delete().eq('user_id', receiverId).eq('gift_id', gift.id);
      }
      throw giftRecordError;
    }

    console.log('✅ Gift sent successfully to comment:', { commentId, giftId: gift.id, receiverId });

    // Return updated comment
    const mapped = this.mapToInteraction(comment);
    mapped.giftsCount = (comment.gifts_count || 0) + 1;
    mapped.isGifted = true;
    
    return mapped;
  }

  // Send gift to post
  async sendGiftToPost(
    postId: string,
    userId: string,
    giftId: string,
  ): Promise<PostInteraction> {
    console.log('🎁 sendGiftToPost called:', { postId, userId, giftId });

    // Check if post exists and get post author
    const { data: post, error: postError } = await this.supabase
      .from('posts')
      .select('id, user_id')
      .eq('id', postId)
      .single();

    if (postError || !post) {
      console.error('❌ Post not found:', postError);
      throw new NotFoundException('Post not found');
    }

    const receiverId = post.user_id;

    // Resolve gift by ID (like live sales) - check both tables
    let gift: any = null;

    // First try gift_types table
    const { data: giftTypeRow } = await this.supabase
      .from('gift_types')
      .select('id, name, base_value, is_active')
      .eq('id', giftId)
      .eq('is_active', true)
      .single();

    if (giftTypeRow) {
      gift = giftTypeRow;
    } else {
      // Fallback to virtual_gifts table
      const { data: virtualGiftRow } = await this.supabase
        .from('virtual_gifts')
        .select('id, name, credit_value, is_active')
        .eq('id', giftId)
        .eq('is_active', true)
        .single();

      if (virtualGiftRow) {
        gift = {
          id: virtualGiftRow.id,
          name: virtualGiftRow.name,
          base_value: virtualGiftRow.credit_value,
          is_active: virtualGiftRow.is_active,
        };
      }
    }

    if (!gift) {
      console.error('❌ Gift not found:', giftId);
      throw new NotFoundException('Gift not found or inactive');
    }

    // Check if user owns the gift
    const { data: userGift, error: userGiftError } = await this.supabase
      .from('user_gifts')
      .select('id, quantity')
      .eq('user_id', userId)
      .eq('gift_id', gift.id)
      .single();

    if (userGiftError || !userGift || userGift.quantity < 1) {
      console.error('❌ User does not own this gift:', userGiftError);
      throw new ForbiddenException('You do not own this gift');
    }

    // Deduct from sender's user_gifts
    const newSenderQuantity = userGift.quantity - 1;
    let deductError: any = null;

    if (newSenderQuantity === 0) {
      // Delete record if quantity reaches 0
      const { error: deleteError } = await this.supabase
        .from('user_gifts')
        .delete()
        .eq('id', userGift.id);
      deductError = deleteError;
    } else {
      // Decrement quantity
      const { error: updateError } = await this.supabase
        .from('user_gifts')
        .update({ quantity: newSenderQuantity })
        .eq('id', userGift.id);
      deductError = updateError;
    }

    if (deductError) {
      console.error('❌ Error deducting from sender:', deductError);
      throw deductError;
    }

    // Add to receiver's user_gifts
    const { data: receiverGift, error: receiverGiftError } = await this.supabase
      .from('user_gifts')
      .select('id, quantity')
      .eq('user_id', receiverId)
      .eq('gift_id', gift.id)
      .single();

    let addError: any = null;

    if (receiverGift) {
      // Increment existing quantity
      const { error: updateError } = await this.supabase
        .from('user_gifts')
        .update({ quantity: receiverGift.quantity + 1 })
        .eq('id', receiverGift.id);
      addError = updateError;
    } else {
      // Create new record
      const { error: insertError } = await this.supabase
        .from('user_gifts')
        .insert({
          user_id: receiverId,
          gift_id: gift.id,
          quantity: 1,
          source: 'received_post',
          received_from: userId,
        });
      addError = insertError;
    }

    if (addError) {
      console.error('❌ Error adding to receiver:', addError);
      // Rollback: restore sender quantity
      await this.supabase
        .from('user_gifts')
        .upsert({ id: userGift.id, user_id: userId, gift_id: gift.id, quantity: userGift.quantity });
      throw addError;
    }

    // Log transaction
    const { error: transactionError } = await this.supabase
      .from('gift_transactions')
      .insert({
        user_id: userId,
        gift_id: gift.id,
        quantity: 1,
        transaction_type: 'send',
        recipient_id: receiverId,
        session_type: 'post',
        session_id: postId,
      });

    if (transactionError) {
      console.error('⚠️ Error logging transaction (non-critical):', transactionError);
      // Don't throw - transaction logging is non-critical
    }

    // Create gift interaction
    const { data: interaction, error } = await this.supabase
      .from('post_interactions')
      .insert({
        post_id: postId,
        user_id: userId,
        interaction_type: InteractionType.GIFT,
        gift_id: gift.id,
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating gift interaction:', error);
      // Rollback: restore sender, remove from receiver
      await this.supabase.from('user_gifts').upsert({ id: userGift.id, user_id: userId, gift_id: gift.id, quantity: userGift.quantity });
      if (receiverGift) {
        await this.supabase.from('user_gifts').update({ quantity: receiverGift.quantity }).eq('id', receiverGift.id);
      } else {
        await this.supabase.from('user_gifts').delete().eq('user_id', receiverId).eq('gift_id', gift.id);
      }
      throw error;
    }

    console.log('✅ Gift sent successfully to post:', { postId, giftId: gift.id, receiverId });
    return this.mapToInteraction(interaction);
  }

  // Toggle bookmark
  async toggleBookmark(postId: string, userId: string): Promise<boolean> {
    const { data: existing } = await this.supabase
      .from('post_bookmarks')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .single();

    if (existing) {
      await this.supabase.from('post_bookmarks').delete().eq('id', existing.id);
      return false;
    } else {
      await this.supabase.from('post_bookmarks').insert({
        post_id: postId,
        user_id: userId,
      });
      return true;
    }
  }

  // Get related posts (more from user + recommendations)
  async getRelatedPosts(postId: string, currentUserId?: string, limit: number = 10): Promise<Post[]> {
    // First get the post to find the user
    const { data: post, error: postError } = await this.supabase
      .from('posts')
      .select('user_id')
      .eq('id', postId)
      .single();

    if (postError || !post) {
      throw new NotFoundException('Post not found');
    }

    // Get more posts from the same user (excluding current post)
    const { data: userPosts, error: userPostsError } = await this.supabase
      .from('posts')
      .select(`
        *,
        user:user_profiles(id, username, avatar_url, is_verified, display_name),
        post_media(id, media_url, media_type, thumbnail_url, order_index)
      `)
      .eq('user_id', post.user_id)
      .eq('is_deleted', false)
      .neq('id', postId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (userPostsError) throw userPostsError;

    // Map and enrich posts
    const mappedPosts = await Promise.all(
      userPosts.map(async (p) => {
        const mapped = this.mapToPost(p);
        if (p.user) mapped.user = this.mapToUserInfo(p.user);

        if (currentUserId) {
          mapped.isLiked = await this.hasUserLiked(p.id, currentUserId);
          mapped.isBookmarked = await this.hasUserBookmarked(p.id, currentUserId);
        }

        return mapped;
      })
    );

    return mappedPosts;
  }

  // Get user's bookmarked posts
  async getUserBookmarks(userId: string, limit: number = 20, offset: number = 0): Promise<Post[]> {
    const { data: bookmarks, error } = await this.supabase
      .from('post_bookmarks')
      .select(`
        post:posts(
          *,
          user:user_profiles(id, username, avatar_url, is_verified, display_name),
          post_media(id, media_url, media_type, thumbnail_url, order_index)
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return Promise.all(
      bookmarks.map(async (bookmark: any) => {
        const post = Array.isArray(bookmark.post) ? bookmark.post[0] : bookmark.post;
        const mapped = this.mapToPost(post);
        if (post?.user) mapped.user = this.mapToUserInfo(post.user);
        mapped.isBookmarked = true;
        mapped.isLiked = await this.hasUserLiked(post?.id || bookmark.post_id, userId);
        return mapped;
      })
    );
  }

  // Get users who liked a post
  async getPostLikers(postId: string, limit: number = 50, offset: number = 0) {
    const { data, error } = await this.supabase
      .from('post_interactions')
      .select(`
        user_id,
        created_at,
        user:user_profiles(id, username, avatar_url, is_verified, display_name)
      `)
      .eq('post_id', postId)
      .eq('interaction_type', InteractionType.LIKE)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return (data || []).map((row: any) => ({
      id: row.user?.id,
      username: row.user?.username || row.user?.display_name || 'Unknown',
      avatarUrl: row.user?.avatar_url || null,
      isVerified: row.user?.is_verified || false,
      likedAt: row.created_at,
    }));
  }

  async getPostGifters(postId: string, limit: number = 50, offset: number = 0) {
    const { data, error } = await this.supabase
      .from('post_interactions')
      .select(`
        user_id,
        created_at,
        gift_id,
        user:user_profiles(id, username, avatar_url, is_verified, display_name)
      `)
      .eq('post_id', postId)
      .eq('interaction_type', InteractionType.GIFT)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Group by user so a user who gifted multiple times appears only once
    const byUser = new Map<string, { id: string; username: string; avatarUrl: string | null; isVerified: boolean; count: number; latestAt: string }>();

    for (const row of (data || []) as any[]) {
      const uid = row.user?.id;
      if (!uid) continue;
      if (byUser.has(uid)) {
        byUser.get(uid)!.count += 1;
      } else {
        byUser.set(uid, {
          id: uid,
          username: row.user?.username || row.user?.display_name || '',
          avatarUrl: row.user?.avatar_url || null,
          isVerified: row.user?.is_verified || false,
          count: 1,
          latestAt: row.created_at,
        });
      }
    }

    return Array.from(byUser.values()).map((u) => ({
      id: u.id,
      username: u.username,
      avatarUrl: u.avatarUrl,
      isVerified: u.isVerified,
      subtitle: u.count > 1 ? `Gifted ${u.count} times` : undefined,
    }));
  }

  // Helper methods
  private async hasUserLiked(postId: string, userId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('post_interactions')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .eq('interaction_type', InteractionType.LIKE)
      .single();
    return !!data;
  }

  private async hasUserBookmarked(postId: string, userId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('post_bookmarks')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .single();
    return !!data;
  }

  private determineMediaType(media?: any[]): MediaType {
    if (!media || media.length === 0) return MediaType.TEXT;
    if (media.length === 1) {
      const type = media[0].mediaType;
      if (type === 'video') return MediaType.VIDEO;
      if (type === 'image') return MediaType.IMAGE;
      return MediaType.TEXT;
    }
    const hasImages = media.some(m => m.mediaType === 'image');
    const hasVideos = media.some(m => m.mediaType === 'video');
    if (hasImages && hasVideos) return MediaType.MIXED;
    return hasVideos ? MediaType.VIDEO : MediaType.IMAGE;
  }

  // Cold-start test window (hours): brand-new items get a flat visibility
  // boost regardless of engagement, mirroring TikTok's initial test-audience batch
  private static readonly COLD_START_WINDOW_HOURS = 2;
  private static readonly COLD_START_BOOST = 40;

  private calculatePostScore(post: Post, bookmarksCount: number = 0): number {
    let score = 0;

    // Time decay (newer = higher score)
    const hoursOld = (Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60 * 60);
    score += Math.max(0, 100 - hoursOld * 2);

    // Engagement weighting — comments/shares weighted higher than likes
    // (mirrors X/Facebook: deeper interactions predict more time-on-app)
    score += (post.likesCount || 0) * 5;
    score += bookmarksCount * 15;
    score += (post.commentsCount || 0) * 25;
    score += (post.sharesCount || 0) * 35;
    score += (post.giftsCount || 0) * 50;

    // Media type boost
    if (post.mediaType === 'video') score *= 1.2;
    if (post.mediaType === 'mixed') score *= 1.1;

    if (hoursOld <= PostsService.COLD_START_WINDOW_HOURS) {
      score += PostsService.COLD_START_BOOST;
    }

    return score;
  }

  private calculateServiceScore(service: any): number {
    let score = 0;

    // Time decay (newer = higher score)
    const hoursOld = service.createdAt
      ? (Date.now() - new Date(service.createdAt).getTime()) / (1000 * 60 * 60)
      : 0;
    score += Math.max(0, 100 - hoursOld * 2);

    // Engagement weighting (service fields are stringified counts)
    score += (parseInt(service.likes, 10) || 0) * 5;
    score += (parseInt(service.saves, 10) || 0) * 15;
    score += (parseInt(service.comments, 10) || 0) * 25;
    score += (parseInt(service.shares, 10) || 0) * 35;
    score += Math.min(service.viewCount || 0, 500) * 1; // passive signal, capped

    // All service feed items are video — same boost posts get for video media
    score *= 1.2;

    if (hoursOld <= PostsService.COLD_START_WINDOW_HOURS) {
      score += PostsService.COLD_START_BOOST;
    }

    return score;
  }

  private calculateLiveStreamScore(stream: LiveStreamData): number {
    let score = 0;

    // Time decay — live streams are time-sensitive, but not as heavily weighted as before
    const hoursOld = stream.startedAt
      ? (Date.now() - stream.startedAt.getTime()) / (1000 * 60 * 60)
      : 0;
    score += Math.max(0, 100 - hoursOld * 2);

    // Engagement weighting
    score += (stream.viewerCount || 0) * 3;
    score += (stream.currentViewers || 0) * 6;
    score += (stream.totalReactions || 0) * 10;
    score += (stream.totalSales || 0) * 25;
    score += (stream.totalTransactions || 0) * 20;
    score += (stream.totalGifts || 0) * 15;

    // Soft live boost — makes them more discoverable without dominating the feed
    score *= 1.2;

    if (hoursOld <= PostsService.COLD_START_WINDOW_HOURS) {
      score += PostsService.COLD_START_BOOST;
    }

    return score;
  }

  private mapToLiveStreamData(data: any, lowestProductPrice?: number): LiveStreamData {
    const fallbackVendor: UserInfo = {
      id: data.vendor_id,
      username: 'Unknown',
      avatarUrl: null,
      isVerified: false,
    };

    return {
      id: data.id,
      vendorId: data.vendor_id,
      vendor: data.vendor ? this.mapToUserInfo(data.vendor) : fallbackVendor,
      title: data.title || 'Live Stream',
      price: data.stream_type === 'products' ? lowestProductPrice : undefined,
      description: data.description || null,
      thumbnailUrl: data.thumbnail_url || data.vendor?.avatar_url || null,
      previewVideoUrl: data.preview_video_url || null,
      streamUrl: data.stream_url || null,
      streamType: data.stream_type,
      status: data.status,
      viewerCount: data.viewer_count || 0,
      currentViewers: data.current_viewers || 0,
      totalViewers: data.total_viewers || 0,
      totalReactions: data.total_reactions || 0,
      totalGifts: data.total_gifts || 0,
      totalSales: data.total_sales || 0,
      totalTransactions: data.total_transactions || 0,
      createdAt: new Date(data.created_at),
      startedAt: data.started_at ? new Date(data.started_at) : null,
    };
  }

  // Mapping methods
  private mapToPost(data: any): Post {
    return {
      id: data.id,
      userId: data.user_id,
      content: data.content,
      mediaUrls: data.media_urls || [],
      processedMediaUrls: data.processed_media_urls || [],
      thumbnailUrls: [...(data.post_media || [])]
        .sort((a: any, b: any) => (a.order_index ?? 0) - (b.order_index ?? 0))
        .map((m: any) => m.thumbnail_url || m.media_url),
      mediaType: data.media_type,
      privacyLevel: data.privacy_level,
      likesCount: data.likes_count || 0,
      commentsCount: data.comments_count || 0,
      sharesCount: data.shares_count || 0,
      giftsCount: data.gifts_count || 0,
      isPinned: data.is_pinned || false,
      isDeleted: data.is_deleted || false,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
    };
  }

  private mapToInteraction(data: any): PostInteraction {
    return {
      id: data.id,
      postId: data.post_id,
      userId: data.user_id,
      interactionType: data.interaction_type,
      content: data.content,
      giftId: data.gift_id,
      parentCommentId: data.parent_comment_id,
      createdAt: new Date(data.created_at),
    };
  }

  private mapToUserInfo(data: any): UserInfo {
    return {
      id: data.id,
      username: data.username || data.display_name || 'Unknown',
      avatarUrl: data.avatar_url,
      isVerified: data.is_verified || false,
    };
  }
}
