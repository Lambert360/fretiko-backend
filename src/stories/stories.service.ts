import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { CreateStoryDto, UpdateStoryDto, CreateStoryCommentDto, StoryQueryDto } from './dto/story.dto';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';
import { TagsService } from '../tags/tags.service';
import { MentionsService } from '../mentions/mentions.service';

const unlinkAsync = promisify(fs.unlink);

@Injectable()
export class StoriesService {
  private supabase;
  private serviceSupabase;

  constructor(
    private configService: ConfigService,
    private clientManager: SupabaseClientManager,
    private tagsService: TagsService,
    private mentionsService: MentionsService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.serviceSupabase = this.clientManager.getServiceClient();
  }

  async createStory(userId: string, createStoryDto: CreateStoryDto, userToken?: string) {
    const storyData = {
      user_id: userId,
      media_url: createStoryDto.media_url,
      media_type: createStoryDto.media_type,
      thumbnail_url: createStoryDto.thumbnail_url,
      caption: createStoryDto.caption,
      duration: createStoryDto.duration,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
      is_active: true,
      view_count: 0,
      like_count: 0,
    };

    const { data, error } = await this.serviceSupabase
      .from('stories')
      .insert(storyData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create story: ${error.message}`);
    }
    // Sync tags and mentions based on caption
    const captionForSync = createStoryDto.caption || '';

    if (captionForSync) {
      try {
        await this.tagsService.syncTaggings(data.id, 'story', captionForSync);
      } catch (e) {
        console.error('Failed to sync tags for story', data.id, e);
      }

      try {
        await this.mentionsService.createMentions(userId, data.id, 'story', captionForSync);
      } catch (e) {
        console.error('Failed to create mentions for story', data.id, e);
      }
    }

    return data;
  }

  async getStoriesForFeed(userId: string, options: StoryQueryDto, userToken?: string) {
    // Get stories from users that the current user is connected to (plugged with)
    // This implements the "plugged users only" requirement
    let query = this.serviceSupabase
      .from('stories')
      .select(`
        *,
        user_profiles!stories_user_id_fkey (
          id,
          username,
          avatar_url
        ),
        story_views!left (
          id,
          viewer_id
        ),
        story_likes!left (
          id,
          user_id
        )
      `)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    // Apply user filter if specified
    if (options.user_id) {
      // Explicit user filter: used when viewing a specific user's stories
      query = query.eq('user_id', options.user_id);
    } else {
      // Only show stories from users that the current user has plugged into
      // i.e. rows where current user is the requester and creator is the addressee
      // Also always include the current user's own stories
      query = query.or(`user_id.eq.${userId},user_id.in.(
        SELECT addressee_id
        FROM user_connections
        WHERE requester_id = '${userId}'
        AND status = 'accepted'
      )`);
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    if (options.offset) {
      query = query.range(options.offset, (options.offset || 0) + (options.limit || 10) - 1);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Stories feed error:', error);
      throw new Error(`Failed to fetch stories: ${error.message}`);
    }

    // Transform data to include user interaction status
    const storiesWithInteractions = data?.map(story => ({
      ...story,
      has_viewed: story.story_views?.some((view: any) => view.viewer_id === userId) || false,
      is_liked: story.story_likes?.some((like: any) => like.user_id === userId) || false,
      // Remove the raw relations from response
      story_views: undefined,
      story_likes: undefined,
    })) || [];

    return storiesWithInteractions;
  }

  async getStoryById(storyId: string, userId: string, userToken?: string) {
    const { data, error } = await this.serviceSupabase
      .from('stories')
      .select(`
        *,
        user_profiles!stories_user_id_fkey (
          id,
          username,
          avatar_url
        ),
        story_views!left (
          id,
          viewer_id
        ),
        story_likes!left (
          id,
          user_id
        )
      `)
      .eq('id', storyId)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (error) {
      throw new NotFoundException(`Story not found: ${error.message}`);
    }

    // Check if user has access to this story (must be connected to story owner or own story)
    if (data.user_id !== userId) {
      const { data: connection } = await this.serviceSupabase
        .from('user_connections')
        .select('id')
        .eq('status', 'accepted')
        .or(`and(requester_id.eq.${userId},addressee_id.eq.${data.user_id}),and(addressee_id.eq.${userId},requester_id.eq.${data.user_id})`)
        .single();

      if (!connection) {
        throw new ForbiddenException('You can only view stories from users you are connected to');
      }
    }

    return {
      ...data,
      has_viewed: data.story_views?.some((view: any) => view.viewer_id === userId) || false,
      is_liked: data.story_likes?.some((like: any) => like.user_id === userId) || false,
      story_views: undefined,
      story_likes: undefined,
    };
  }

  async getUserStories(targetUserId: string, currentUserId: string, userToken?: string) {
    // Check if current user can view target user's stories
    if (targetUserId !== currentUserId) {
      const { data: connection } = await this.serviceSupabase
        .from('user_connections')
        .select('id')
        .eq('status', 'accepted')
        .or(`and(requester_id.eq.${currentUserId},addressee_id.eq.${targetUserId}),and(addressee_id.eq.${currentUserId},requester_id.eq.${targetUserId})`)
        .single();

      if (!connection) {
        throw new ForbiddenException('You can only view stories from users you are connected to');
      }
    }

    const { data, error } = await this.serviceSupabase
      .from('stories')
      .select(`
        *,
        user_profiles!stories_user_id_fkey (
          id,
          username,
          avatar_url
        )
      `)
      .eq('user_id', targetUserId)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch user stories: ${error.message}`);
    }

    return data;
  }

  async updateStory(userId: string, storyId: string, updateStoryDto: UpdateStoryDto, userToken?: string) {
    // Verify story ownership
    const { data: existingStory } = await this.serviceSupabase
      .from('stories')
      .select('user_id')
      .eq('id', storyId)
      .single();

    if (!existingStory) {
      throw new NotFoundException('Story not found');
    }

    if (existingStory.user_id !== userId) {
      throw new ForbiddenException('You can only update your own stories');
    }

    const { data, error } = await this.serviceSupabase
      .from('stories')
      .update(updateStoryDto)
      .eq('id', storyId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update story: ${error.message}`);
    }

    return data;
  }

  async deleteStory(userId: string, storyId: string, userToken?: string) {
    // Verify story ownership
    const { data: existingStory } = await this.serviceSupabase
      .from('stories')
      .select('user_id')
      .eq('id', storyId)
      .single();

    if (!existingStory) {
      throw new NotFoundException('Story not found');
    }

    if (existingStory.user_id !== userId) {
      throw new ForbiddenException('You can only delete your own stories');
    }

    const { error } = await this.serviceSupabase
      .from('stories')
      .delete()
      .eq('id', storyId);

    if (error) {
      throw new Error(`Failed to delete story: ${error.message}`);
    }

    return { message: 'Story deleted successfully' };
  }

  async viewStory(userId: string, storyId: string, userToken?: string) {
    console.log('🔍 viewStory called:', { userId, storyId, hasToken: !!userToken });

    // For view tracking, use a less restrictive check - just verify story exists
    console.log('📋 Searching for story in database:', storyId);
    const { data: story, error } = await this.serviceSupabase
      .from('stories')
      .select('id, user_id')
      .eq('id', storyId)
      .single();

    console.log('📋 Story query result:', { story, error: error?.message });

    if (error || !story) {
      // Let's check what stories actually exist for this user
      const { data: userStories } = await this.serviceSupabase
        .from('stories')
        .select('id, user_id, created_at, is_active, expires_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      console.log('🔍 Recent stories for this user:', userStories);

      // Also check if the story exists but for a different user
      const { data: storyExists } = await this.serviceSupabase
        .from('stories')
        .select('id, user_id, is_active, expires_at')
        .eq('id', storyId)
        .single();

      console.log('🔍 Story exists check:', storyExists);

      throw new NotFoundException(`Story not found for view tracking: ${error?.message || 'Story does not exist'}`);
    }

    // Check if user has access to this story (must be connected to story owner or own story)
    if (story.user_id !== userId) {
      const { data: connection } = await this.serviceSupabase
        .from('user_connections')
        .select('id')
        .eq('status', 'accepted')
        .or(`and(requester_id.eq.${userId},addressee_id.eq.${story.user_id}),and(addressee_id.eq.${userId},requester_id.eq.${story.user_id})`)
        .single();

      if (!connection) {
        throw new ForbiddenException('You can only view stories from users you are connected to');
      }
    }

    // Check if user has already viewed this story
    const { data: existingView } = await this.serviceSupabase
      .from('story_views')
      .select('id')
      .eq('story_id', storyId)
      .eq('viewer_id', userId)
      .single();

    if (!existingView) {
      // Create view record
      const { error } = await this.serviceSupabase
        .from('story_views')
        .insert({
          story_id: storyId,
          viewer_id: userId,
        });

      if (error) {
        throw new Error(`Failed to record story view: ${error.message}`);
      }
    }

    return { message: 'Story view recorded', story };
  }

  async toggleLike(userId: string, storyId: string, userToken?: string) {
    // Check if story exists and user has access
    await this.getStoryById(storyId, userId, userToken);

    // Check if user has already liked this story
    const { data: existingLike } = await this.serviceSupabase
      .from('story_likes')
      .select('id')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .single();

    if (existingLike) {
      // Remove like
      const { error } = await this.serviceSupabase
        .from('story_likes')
        .delete()
        .eq('id', existingLike.id);

      if (error) {
        throw new Error(`Failed to unlike story: ${error.message}`);
      }

      return { liked: false, message: 'Story unliked' };
    } else {
      // Add like
      const { error } = await this.serviceSupabase
        .from('story_likes')
        .insert({
          story_id: storyId,
          user_id: userId,
        });

      if (error) {
        throw new Error(`Failed to like story: ${error.message}`);
      }

      return { liked: true, message: 'Story liked' };
    }
  }

  async getStoryLikers(storyId: string, limit: number = 50, offset: number = 0) {
    const { data, error } = await this.serviceSupabase
      .from('story_likes')
      .select(`
        user_id,
        created_at,
        user:user_profiles(id, username, avatar_url, is_verified)
      `)
      .eq('story_id', storyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Failed to fetch story likers: ${error.message}`);

    return (data || []).map((row: any) => ({
      id: row.user?.id,
      username: row.user?.username,
      avatarUrl: row.user?.avatar_url || null,
      isVerified: row.user?.is_verified || false,
      likedAt: row.created_at,
    }));
  }

  async addComment(userId: string, storyId: string, createCommentDto: CreateStoryCommentDto, userToken?: string) {
    // Check if story exists and user has access
    await this.getStoryById(storyId, userId, userToken);

    const { data, error } = await this.serviceSupabase
      .from('story_comments')
      .insert({
        story_id: storyId,
        user_id: userId,
        content: createCommentDto.content,
      })
      .select(`
        *,
        user_profiles!story_comments_user_id_fkey (
          username,
          avatar_url
        )
      `)
      .single();

    if (error) {
      throw new Error(`Failed to add comment: ${error.message}`);
    }

    // Sync tags and mentions for the new comment
    const contentForSync = createCommentDto.content || '';

    if (contentForSync) {
      try {
        await this.tagsService.syncTaggings(data.id, 'comment', contentForSync);
      } catch (e) {
        console.error('Failed to sync tags for story comment', data.id, e);
      }

      try {
        await this.mentionsService.createMentions(userId, data.id, 'comment', contentForSync);
      } catch (e) {
        console.error('Failed to create mentions for story comment', data.id, e);
      }
    }

    return data;
  }

  async getStoryComments(storyId: string, userId: string, userToken?: string) {
    // Check if story exists and user has access
    await this.getStoryById(storyId, userId, userToken);

    const { data, error } = await this.serviceSupabase
      .from('story_comments')
      .select(`
        *,
        user_profiles!story_comments_user_id_fkey (
          username,
          avatar_url
        )
      `)
      .eq('story_id', storyId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch comments: ${error.message}`);
    }

    return data;
  }

  async notifyComment(userId: string, storyId: string, notifyCommentDto: any, userToken?: string) {
    // Get the story to ensure it exists and user has access
    const { data: story, error: storyError } = await this.serviceSupabase
      .from('stories')
      .select('id, user_id, user_profiles(id, username)')
      .eq('id', storyId)
      .single();

    if (storyError || !story) {
      throw new NotFoundException('Story not found');
    }

    // Create notification record (if notifications table exists)
    try {
      const { data: notification, error: notificationError } = await this.serviceSupabase
        .from('notifications')
        .insert({
          user_id: story.user_id,
          type: 'social',
          title: 'New comment on your story',
          message: `${notifyCommentDto.commenterUsername} commented on your story`,
          data: {
            storyId: storyId,
            commenterId: notifyCommentDto.commenterId,
            commenterUsername: notifyCommentDto.commenterUsername,
            commentText: notifyCommentDto.commentText,
          },
        })
        .select()
        .single();

      return { success: true, notification };
    } catch (error) {
      // If notifications table doesn't exist, just return success
      console.log('Notifications table not found, skipping formal notification');
      return { success: true, message: 'Comment notification handled via DM' };
    }
  }

  async cleanupExpiredStories() {
    const { data, error } = await this.serviceSupabase
      .rpc('cleanup_expired_stories');

    if (error) {
      throw new Error(`Failed to cleanup expired stories: ${error.message}`);
    }

    return { deletedCount: data };
  }

  // Get stories grouped by user for the discovery screen
  async getStoriesGroupedByUser(currentUserId: string, userToken?: string) {
    console.log('🔐 Using service client to bypass RLS');

    // Debug: Let's first check if there are ANY stories in the database
    console.log('🔍 Debug: Checking current time:', new Date().toISOString());

    const { data: allStories, error: allError } = await this.serviceSupabase
      .from('stories')
      .select('id, user_id, is_active, expires_at, created_at')
      .order('created_at', { ascending: false });

    console.log('📊 All stories in database:', allStories?.length || 0);
    if (allStories && allStories.length > 0) {
      console.log('📖 Latest story:', {
        id: allStories[0].id,
        user_id: allStories[0].user_id,
        is_active: allStories[0].is_active,
        expires_at: allStories[0].expires_at,
        created_at: allStories[0].created_at
      });
    }

    // Get stories from users that the current user has plugged into (followers/clients perspective)
    // EXCLUDE current user's own stories here; they are fetched separately via getMyStories

    // First, fetch the list of connected user IDs (accepted connections where current user is requester)
    const { data: connections, error: connectionsError } = await this.serviceSupabase
      .from('user_connections')
      .select('addressee_id')
      .eq('requester_id', currentUserId)
      .eq('status', 'accepted');

    if (connectionsError) {
      throw new Error(`Failed to fetch grouped stories: ${connectionsError.message}`);
    }

    const connectedUserIds = (connections || [])
      .map((c: any) => c.addressee_id)
      .filter((id: string | null | undefined) => !!id);

    // If user has no accepted connections, there are no grouped stories to show
    if (connectedUserIds.length === 0) {
      console.log('📊 No connected users for grouped stories - returning empty array');
      return [];
    }

    const { data, error } = await this.serviceSupabase
      .from('stories')
      .select(`
        id,
        user_id,
        media_url,
        thumbnail_url,
        media_type,
        created_at,
        user_profiles!stories_user_id_fkey (
          id,
          username,
          avatar_url
        ),
        story_views!left (
          id,
          viewer_id
        )
      `)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .neq('user_id', currentUserId) // Exclude current user's stories
      .in('user_id', connectedUserIds)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch grouped stories: ${error.message}`);
    }

    console.log('🔍 Raw stories data fetched:', data?.length || 0, 'stories');
    if (data && data.length > 0) {
      console.log('📖 First story sample:', {
        id: data[0].id,
        user_id: data[0].user_id,
        media_type: data[0].media_type,
        created_at: data[0].created_at,
        user_profile: data[0].user_profiles?.username
      });
    }

    // Group stories by user
    const groupedStories = data?.reduce((acc, story) => {
      const storyUserId = story.user_id;
      if (!acc[storyUserId]) {
        acc[storyUserId] = {
          user: story.user_profiles,
          stories: [],
          hasUnviewed: false,
        };
      }

      const hasViewed = story.story_views?.some((view: any) => view.viewer_id === currentUserId) || false;
      if (!hasViewed) {
        acc[storyUserId].hasUnviewed = true;
      }

      acc[storyUserId].stories.push({
        id: story.id,
        media_url: story.media_url,
        thumbnail_url: story.thumbnail_url,
        media_type: story.media_type,
        created_at: story.created_at,
        has_viewed: hasViewed,
      });

      return acc;
    }, {} as any) || {};

    // Convert to array and sort by unviewed first, then by latest story
    const storiesArray = Object.values(groupedStories).sort((a: any, b: any) => {
      // Unviewed stories first
      if (a.hasUnviewed && !b.hasUnviewed) return -1;
      if (!a.hasUnviewed && b.hasUnviewed) return 1;

      // Then by latest story
      const latestA = new Date(a.stories[0]?.created_at || 0);
      const latestB = new Date(b.stories[0]?.created_at || 0);
      return latestB.getTime() - latestA.getTime();
    });

    console.log('📊 Final grouped stories result:', {
      totalGroups: storiesArray.length,
      groups: storiesArray.map((group: any) => ({
        user: group.user?.username,
        storyCount: group.stories.length,
        hasUnviewed: group.hasUnviewed
      }))
    });

    return storiesArray;
  }

  // Get current user's own active stories
  async getMyStories(userId: string, userToken?: string) {
    console.log('📚 getMyStories called for user:', userId);

    const { data, error } = await this.serviceSupabase
      .from('stories')
      .select(`
        id,
        user_id,
        media_url,
        thumbnail_url,
        media_type,
        caption,
        duration,
        created_at,
        expires_at,
        is_active,
        view_count,
        like_count,
        updated_at,
        user_profiles!stories_user_id_fkey (
          id,
          username,
          avatar_url
        ),
        story_views!left (
          id,
          viewer_id
        )
      `)
      .eq('user_id', userId)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    console.log('📚 getMyStories query result:', {
      dataCount: data?.length || 0,
      error: error?.message,
      firstStoryId: data?.[0]?.id
    });

    if (data?.length > 0) {
      console.log('📚 First story structure:', JSON.stringify(data[0], null, 2));
    }

    if (error) {
      console.error('📚 getMyStories error:', error);
      throw new Error(`Failed to fetch my stories: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Generate video thumbnail using FFmpeg
   */
  private async generateVideoThumbnail(
    videoBuffer: Buffer,
    userId: string,
    timestamp: number,
    supabaseClient: any
  ): Promise<string | null> {
    const tempVideoPath = path.join('/tmp', `${timestamp}-temp-video.mp4`);
    const tempThumbnailPath = path.join('/tmp', `${timestamp}-thumbnail.jpg`);

    try {
      // Write video buffer to temp file
      fs.writeFileSync(tempVideoPath, videoBuffer);

      // Generate thumbnail
      await new Promise((resolve, reject) => {
        ffmpeg(tempVideoPath)
          .screenshots({
            timestamps: ['00:00:01'], // 1 second into video
            filename: `${timestamp}-thumbnail.jpg`,
            folder: '/tmp',
            size: '720x1280'
          })
          .on('end', resolve)
          .on('error', reject);
      });

      // Read thumbnail
      const thumbnailBuffer = fs.readFileSync(tempThumbnailPath);

      // Upload thumbnail to Supabase
      const thumbnailFileName = `${userId}/${timestamp}-thumbnail.jpg`;
      const { data: thumbnailData, error: thumbnailError } = await supabaseClient.storage
        .from('stories')
        .upload(thumbnailFileName, thumbnailBuffer, {
          contentType: 'image/jpeg',
          upsert: false,
        });

      if (thumbnailError) {
        console.warn('⚠️ Thumbnail upload failed:', thumbnailError.message);
        return null;
      }

      // Get public URL
      const { data: thumbnailUrlData } = supabaseClient.storage
        .from('stories')
        .getPublicUrl(thumbnailFileName);

      console.log('✅ Thumbnail generated successfully:', thumbnailUrlData.publicUrl);
      return thumbnailUrlData.publicUrl;

    } catch (error) {
      console.error('❌ Thumbnail generation failed:', error);
      return null;
    } finally {
      // Cleanup temp files
      try {
        if (fs.existsSync(tempVideoPath)) await unlinkAsync(tempVideoPath);
        if (fs.existsSync(tempThumbnailPath)) await unlinkAsync(tempThumbnailPath);
      } catch (cleanupError) {
        console.warn('⚠️ Temp file cleanup warning:', cleanupError);
      }
    }
  }

  /**
   * Upload story with file handling (using multer)
   */
  async uploadStoryWithFile(
    userId: string,
    file: Express.Multer.File,
    caption?: string,
    duration?: number,
    userToken?: string
  ): Promise<any> {
    try {
      if (!file) {
        throw new BadRequestException('No file provided');
      }

      // Debug: Log file details
      console.log('🔍 Received file details:', {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        fieldname: file.fieldname
      });

      // Validate file
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'video/mp4', 'video/mov', 'video/quicktime'];
      if (!allowedTypes.includes(file.mimetype)) {
        console.error('❌ Invalid MIME type:', file.mimetype, 'Expected one of:', allowedTypes);
        throw new BadRequestException(`Invalid file type: ${file.mimetype}. Only images and videos are allowed.`);
      }

      const maxSize = 25 * 1024 * 1024; // 25MB
      if (file.size > maxSize) {
        throw new BadRequestException('File too large. Maximum size is 25MB.');
      }

      // Generate unique filename
      const fileExtension = file.originalname.split('.').pop() || 'jpg';
      const timestamp = Date.now();
      const uniqueFileName = `${userId}/${timestamp}-story.${fileExtension}`;

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await this.serviceSupabase.storage
        .from('stories')
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      // Get public URL
      const { data: urlData } = this.serviceSupabase.storage
        .from('stories')
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      // Generate thumbnail for videos
      let thumbnailUrl: string | null = null;
      const isVideo = file.mimetype.startsWith('video/');
      
      if (isVideo) {
        console.log('🎬 Generating thumbnail for video...');
        thumbnailUrl = await this.generateVideoThumbnail(file.buffer, userId, timestamp, this.serviceSupabase);
      }

      // Create story record
      const storyData = {
        user_id: userId,
        media_url: publicUrl,
        media_type: isVideo ? 'video' : 'image',
        thumbnail_url: thumbnailUrl,
        caption: caption || null,
        duration: duration || null,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        is_active: true,
        view_count: 0,
        like_count: 0,
      };

      const { data, error } = await this.serviceSupabase
        .from('stories')
        .insert(storyData)
        .select()
        .single();

      if (error) {
        // Cleanup uploaded file if story creation fails
        await this.serviceSupabase.storage.from('stories').remove([uniqueFileName]);
        throw new BadRequestException(`Failed to create story: ${error.message}`);
      }

      return {
        ...data,
        message: 'Story uploaded successfully',
      };

    } catch (error) {
      console.error('Story upload error:', error);
      throw error;
    }
  }
}