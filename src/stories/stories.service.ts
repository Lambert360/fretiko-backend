import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { CreateStoryDto, UpdateStoryDto, CreateStoryCommentDto, StoryQueryDto } from './dto/story.dto';

@Injectable()
export class StoriesService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async createStory(userId: string, createStoryDto: CreateStoryDto, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

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

    const { data, error } = await supabaseClient
      .from('stories')
      .insert(storyData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create story: ${error.message}`);
    }

    return data;
  }

  async getStoriesForFeed(userId: string, options: StoryQueryDto, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Get stories from users that the current user is connected to (plugged with)
    // This implements the "plugged users only" requirement
    let query = supabaseClient
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
      query = query.eq('user_id', options.user_id);
    } else {
      // Only show stories from connected users
      // Using EXISTS subquery to filter by user connections
      query = query.or(`user_id.eq.${userId},user_id.in.(
        SELECT CASE
          WHEN requester_id = '${userId}' THEN addressee_id
          WHEN addressee_id = '${userId}' THEN requester_id
        END as connected_user_id
        FROM user_connections
        WHERE status = 'accepted'
        AND ('${userId}' = requester_id OR '${userId}' = addressee_id)
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
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    const { data, error } = await supabaseClient
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
      const { data: connection } = await supabaseClient
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
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Check if current user can view target user's stories
    if (targetUserId !== currentUserId) {
      const { data: connection } = await supabaseClient
        .from('user_connections')
        .select('id')
        .eq('status', 'accepted')
        .or(`and(requester_id.eq.${currentUserId},addressee_id.eq.${targetUserId}),and(addressee_id.eq.${currentUserId},requester_id.eq.${targetUserId})`)
        .single();

      if (!connection) {
        throw new ForbiddenException('You can only view stories from users you are connected to');
      }
    }

    const { data, error } = await supabaseClient
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
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Verify story ownership
    const { data: existingStory } = await supabaseClient
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

    const { data, error } = await supabaseClient
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
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Verify story ownership
    const { data: existingStory } = await supabaseClient
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

    const { error } = await supabaseClient
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

    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // For view tracking, use a less restrictive check - just verify story exists
    console.log('📋 Searching for story in database:', storyId);
    const { data: story, error } = await supabaseClient
      .from('stories')
      .select('id, user_id')
      .eq('id', storyId)
      .single();

    console.log('📋 Story query result:', { story, error: error?.message });

    if (error || !story) {
      // Let's check what stories actually exist for this user
      const { data: userStories } = await supabaseClient
        .from('stories')
        .select('id, user_id, created_at, is_active, expires_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      console.log('🔍 Recent stories for this user:', userStories);

      // Also check if the story exists but for a different user
      const { data: storyExists } = await supabaseClient
        .from('stories')
        .select('id, user_id, is_active, expires_at')
        .eq('id', storyId)
        .single();

      console.log('🔍 Story exists check:', storyExists);

      throw new NotFoundException(`Story not found for view tracking: ${error?.message || 'Story does not exist'}`);
    }

    // Check if user has access to this story (must be connected to story owner or own story)
    if (story.user_id !== userId) {
      const { data: connection } = await supabaseClient
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
    const { data: existingView } = await supabaseClient
      .from('story_views')
      .select('id')
      .eq('story_id', storyId)
      .eq('viewer_id', userId)
      .single();

    if (!existingView) {
      // Create view record
      const { error } = await supabaseClient
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
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Check if story exists and user has access
    await this.getStoryById(storyId, userId, userToken);

    // Check if user has already liked this story
    const { data: existingLike } = await supabaseClient
      .from('story_likes')
      .select('id')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .single();

    if (existingLike) {
      // Remove like
      const { error } = await supabaseClient
        .from('story_likes')
        .delete()
        .eq('id', existingLike.id);

      if (error) {
        throw new Error(`Failed to unlike story: ${error.message}`);
      }

      return { liked: false, message: 'Story unliked' };
    } else {
      // Add like
      const { error } = await supabaseClient
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

  async addComment(userId: string, storyId: string, createCommentDto: CreateStoryCommentDto, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Check if story exists and user has access
    await this.getStoryById(storyId, userId, userToken);

    const { data, error } = await supabaseClient
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

    return data;
  }

  async getStoryComments(storyId: string, userId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Check if story exists and user has access
    await this.getStoryById(storyId, userId, userToken);

    const { data, error } = await supabaseClient
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
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Get the story to ensure it exists and user has access
    const { data: story, error: storyError } = await supabaseClient
      .from('stories')
      .select('id, user_id, user_profiles(id, username)')
      .eq('id', storyId)
      .single();

    if (storyError || !story) {
      throw new NotFoundException('Story not found');
    }

    // Create notification record (if notifications table exists)
    try {
      const { data: notification, error: notificationError } = await supabaseClient
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
    const { data, error } = await this.supabase
      .rpc('cleanup_expired_stories');

    if (error) {
      throw new Error(`Failed to cleanup expired stories: ${error.message}`);
    }

    return { deletedCount: data };
  }

  // Get stories grouped by user for the discovery screen
  async getStoriesGroupedByUser(currentUserId: string, userToken?: string) {
    // Force use of authenticated user client for RLS policies
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    console.log('🔐 Using client type:', userToken ? 'User authenticated' : 'Service role');

    // Debug: Let's first check if there are ANY stories in the database
    console.log('🔍 Debug: Checking current time:', new Date().toISOString());

    const { data: allStories, error: allError } = await supabaseClient
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

    // Get stories from connected users grouped by user (EXCLUDE current user's own stories)
    // This is for the discovery feed - user's own stories should be shown separately
    const { data, error } = await supabaseClient
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

    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    const { data, error } = await supabaseClient
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

      const supabaseClient = userToken
        ? createUserSupabaseClient(this.configService, userToken)
        : this.supabase;

      // Generate unique filename
      const fileExtension = file.originalname.split('.').pop() || 'jpg';
      const timestamp = Date.now();
      const uniqueFileName = `${userId}/${timestamp}-story.${fileExtension}`;

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabaseClient.storage
        .from('stories')
        .upload(uniqueFileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      // Get public URL
      const { data: urlData } = supabaseClient.storage
        .from('stories')
        .getPublicUrl(uniqueFileName);

      const publicUrl = urlData.publicUrl;

      // Create story record
      const storyData = {
        user_id: userId,
        media_url: publicUrl,
        media_type: file.mimetype.startsWith('image/') ? 'image' : 'video',
        caption: caption || null,
        duration: duration || null,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        is_active: true,
        view_count: 0,
        like_count: 0,
      };

      const { data, error } = await supabaseClient
        .from('stories')
        .insert(storyData)
        .select()
        .single();

      if (error) {
        // Cleanup uploaded file if story creation fails
        await supabaseClient.storage.from('stories').remove([uniqueFileName]);
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