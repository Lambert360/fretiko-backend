import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';
import { VideoProcessingHelper } from '../shared/video-processing.helper';
import { TagsService } from '../tags/tags.service';
import { MentionsService } from '../mentions/mentions.service';

@Injectable()
export class ServicesService {
  private supabase;
  private serviceSupabase;

  constructor(
    private configService: ConfigService,
    private supabaseClientManager: SupabaseClientManager,
    private tagsService: TagsService,
    private mentionsService: MentionsService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async getCategories() {
    const { data, error } = await this.supabase
      .from('service_categories')
      .select('*')
      .eq('is_active', true)
      .order('sort_order');

    if (error) {
      throw new Error(`Failed to fetch service categories: ${error.message}`);
    }

    return data;
  }

  async createService(userId: string, createServiceDto: CreateServiceDto, userToken?: string) {
    // Use serviceSupabase for all DB operations - user tokens can't be used for Supabase DB queries
    const supabaseClient = this.serviceSupabase;

    // First verify the user is a seller or rider
    console.log('👤 Checking user profile for service creation, userId:', userId);
    const { data: profile, error: profileError } = await supabaseClient
      .from('user_profiles')
      .select('is_seller, is_rider')
      .eq('id', userId)
      .single();

    console.log('📋 User profile data:', profile);
    console.log('❌ Profile error:', profileError);

    if (!profile?.is_seller && !profile?.is_rider) {
      console.log('🚫 User is not a seller or rider. is_seller:', profile?.is_seller, 'is_rider:', profile?.is_rider);
      throw new ForbiddenException('Only sellers and riders can create services');
    }

    console.log('✅ User role check passed. is_seller:', profile?.is_seller, 'is_rider:', profile?.is_rider);

    // Verify category exists
    const { data: category } = await supabaseClient
      .from('service_categories')
      .select('id')
      .eq('id', createServiceDto.category_id)
      .eq('is_active', true)
      .single();

    if (!category) {
      throw new NotFoundException('Service category not found');
    }

    const serviceData = {
      user_id: userId,
      category_id: createServiceDto.category_id,
      name: createServiceDto.name,
      description: createServiceDto.description,
      base_price: createServiceDto.base_price,
      duration: createServiceDto.duration,
      images: createServiceDto.images || [],
      videos: createServiceDto.videos || [],
      primary_media_url: createServiceDto.images?.[0] || createServiceDto.videos?.[0] || null,
      media_type: (createServiceDto.images && createServiceDto.images.length > 0) ? 'image' : 'video',
      location: createServiceDto.location,
      service_area: createServiceDto.service_area,
      availability: createServiceDto.availability,
      tags: createServiceDto.tags || [],
      booking_type: createServiceDto.booking_type || 'add_to_cart',
      status: 'active',
      is_featured: false,
      view_count: 0,
      like_count: 0,
      save_count: 0,
      booking_count: 0,
    };

    const { data, error } = await supabaseClient
      .from('services')
      .insert(serviceData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create service: ${error.message}`);
    }

    // Fire-and-forget video processing for incompatible codecs
    if (data.videos && data.videos.length > 0) {
      data.videos.forEach((videoUrl: string, index: number) => {
        VideoProcessingHelper.checkAndQueue(videoUrl, userId, 'service', data.id, index).catch(() => {
          // Silent fail — original video still works
        });
      });
    }

    // Sync tags and mentions based on description
    const descriptionForSync = createServiceDto.description || '';

    try {
      await this.tagsService.syncTaggings(data.id, 'service', descriptionForSync);
    } catch (e) {
      console.error('Failed to sync tags for service', data.id, e);
    }

    try {
      await this.mentionsService.createMentions(userId, data.id, 'service', descriptionForSync);
    } catch (e) {
      console.error('Failed to create mentions for service', data.id, e);
    }

    return data;
  }

  async getServicesByUser(userId: string, userToken?: string) {
    // Use serviceSupabase - user tokens can't be used for DB operations
    const supabaseClient = this.serviceSupabase;

    const { data, error } = await supabaseClient
      .from('services')
      .select(`
        *,
        service_categories (
          name,
          icon_name,
          color_hex
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch user services: ${error.message}`);
    }

    return data;
  }

  async getServices(options: {
    category_id?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    let query = this.serviceSupabase
      .from('services')
      .select(`
        *,
        service_categories (
          name,
          icon_name,
          color_hex
        ),
        user_profiles!services_user_id_fkey (
          username,
          avatar_url,
          is_verified,
          display_name
        )
      `)
      .eq('status', 'active');

    if (options.category_id) {
      query = query.eq('category_id', options.category_id);
    }

    if (options.search) {
      query = query.or(
        `name.ilike.%${options.search}%,description.ilike.%${options.search}%,tags.cs.{${options.search}}`
      );
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    if (options.offset) {
      query = query.range(options.offset, (options.offset || 0) + (options.limit || 10) - 1);
    }

    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch services: ${error.message}`);
    }

    console.log('🔍 Raw services from DB:', data?.length || 0, 'services');
    if (data && data.length > 0) {
      console.log('🔍 First raw service:', {
        id: data[0].id,
        name: data[0].name,
        base_price: data[0].base_price,
        user_profiles: data[0].user_profiles,
      });
    }

    // Transform data to match frontend expectations
    const transformedData = data?.map(service => {
      const transformed = {
        ...service,
        // Add price field (frontend expects 'price', not 'base_price')
        price: service.base_price,
        // Flatten user_profiles data to provider fields
        provider_name: service.user_profiles?.username || service.user_profiles?.display_name || 'Unknown Rider',
        provider_avatar: service.user_profiles?.avatar_url || null,
        provider_verified: service.user_profiles?.is_verified || false,
        provider_id: service.user_id,
        // Add category name
        category_name: service.service_categories?.name || null,
      };

      console.log('✅ Transformed service:', {
        id: transformed.id,
        name: transformed.name,
        price: transformed.price,
        provider_name: transformed.provider_name,
        provider_avatar: transformed.provider_avatar,
      });

      return transformed;
    }) || [];

    return transformedData;
  }

  async getVideoFeed(userId: string | null, options: { limit?: number; offset?: number }) {
    console.log('🎥 getVideoFeed called with userId:', userId, 'options:', options);

    // Get services that have videos for the TikTok-style video feed
    const query = this.serviceSupabase
      .from('services')
      .select(`
        *,
        service_categories (
          name,
          icon_name,
          color_hex
        ),
        user_profiles!services_user_id_fkey (
          username,
          avatar_url,
          display_name
        )
      `)
      .eq('status', 'active')
      .not('videos', 'eq', '{}')  // Only services with videos
      .order('created_at', { ascending: false })  // Most recent first
      .limit(options.limit || 10);

    if (options.offset) {
      query.range(options.offset, (options.offset || 0) + (options.limit || 10) - 1);
    }

    const { data, error } = await query;

    console.log('🎥 Raw services data from DB:', data?.length || 0, 'items');
    console.log('🎥 First service data:', data?.[0]);

    if (error) {
      console.error('🎥 Database error:', error);
      throw new Error(`Failed to fetch video feed: ${error.message}`);
    }

    // Get user's liked services and bookmarks if userId is provided
    let likedServiceIds: Set<string> = new Set();
    let bookmarkedServiceIds: Set<string> = new Set();

    if (userId) {
      // Fetch likes
      const { data: likes, error: likesError } = await this.serviceSupabase
        .from('service_likes')
        .select('service_id')
        .eq('user_id', userId);

      if (!likesError && likes) {
        likedServiceIds = new Set(likes.map(like => like.service_id));
        console.log('🎥 User has liked', likedServiceIds.size, 'services');
      }

      // Fetch bookmarks
      const { data: bookmarks, error: bookmarksError } = await this.serviceSupabase
        .from('service_bookmarks')
        .select('service_id')
        .eq('user_id', userId);

      if (!bookmarksError && bookmarks) {
        bookmarkedServiceIds = new Set(bookmarks.map(bm => bm.service_id));
        console.log('🎥 User has bookmarked', bookmarkedServiceIds.size, 'services');
      }
    }

    // Get comment counts for all services
    const serviceIds = data?.map(s => s.id) || [];
    const commentCountsMap = new Map<string, number>();

    if (serviceIds.length > 0) {
      const { data: commentCounts, error: commentsError } = await this.serviceSupabase
        .from('service_comments')
        .select('service_id')
        .in('service_id', serviceIds);

      if (!commentsError && commentCounts) {
        // Count comments per service
        commentCounts.forEach(comment => {
          const count = commentCountsMap.get(comment.service_id) || 0;
          commentCountsMap.set(comment.service_id, count + 1);
        });
        console.log('🎥 Fetched comment counts for', commentCountsMap.size, 'services');
      }
    }

    // Transform services data to video feed format
    const videoFeed = data?.map(service => {
      const isLiked = likedServiceIds.has(service.id);
      const isBookmarked = bookmarkedServiceIds.has(service.id);
      const commentCount = commentCountsMap.get(service.id) || 0;

      console.log('🎥 Transforming service:', {
        id: service.id,
        name: service.name,
        base_price: service.base_price,
        like_count: service.like_count,
        booking_count: service.booking_count,
        average_rating: service.average_rating,
        user_id: service.user_id,
        username: service.user_profiles?.username || service.user_profiles?.display_name || null,
        isLiked,
        isBookmarked,
        commentCount,
      });

      return {
        id: service.id,
        title: service.name,
        thumbnail: service.images?.[0] || null,
        videoUri: service.processed_videos?.[0] || service.videos?.[0] || null,
        userId: service.user_id,
        username: service.user_profiles?.username || service.user_profiles?.display_name || 'user',
        userAvatar: service.user_profiles?.avatar_url || null,
        description: service.description || '',
        likes: (service.like_count || 0).toString(),
        comments: commentCount.toString(),
        shares: (service.share_count || 0).toString(),
        price: parseFloat(service.base_price) || 0,
        originalPrice: null, // No original price concept for services yet
        location: service.location || 'Location not set',
        serviceProvider: service.user_profiles?.username || service.user_profiles?.display_name || 'Unknown Rider',
        rating: parseFloat(service.average_rating) || 4.5, // Default to 4.5 if no rating yet
        completedJobs: (service.booking_count || 0).toString(),
        isLiked: isLiked, // User-specific like status from service_likes table
        isBookmarked: isBookmarked, // User-specific bookmark status from service_bookmarks table
      };
    }) || [];

    console.log('🎥 Final video feed items:', videoFeed.length);
    if (videoFeed.length > 0) {
      console.log('🎥 First transformed item:', JSON.stringify(videoFeed[0], null, 2));
    }

    return videoFeed;
  }

  async getService(id: string) {
    const { data, error } = await this.serviceSupabase
      .from('services')
      .select(`
        *,
        service_categories (
          name,
          icon_name,
          color_hex
        ),
        user_profiles!services_user_id_fkey (
          username,
          avatar_url,
          display_name
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      throw new NotFoundException(`Service not found: ${error.message}`);
    }

    // Increment view count
    await this.serviceSupabase
      .from('services')
      .update({ view_count: data.view_count + 1 })
      .eq('id', id);

    return data;
  }

  async updateService(userId: string, serviceId: string, updateServiceDto: UpdateServiceDto, userToken?: string) {
    // Use serviceSupabase for all DB operations
    const supabaseClient = this.serviceSupabase;

    // First verify the service belongs to the user
    const { data: existingService } = await supabaseClient
      .from('services')
      .select('user_id')
      .eq('id', serviceId)
      .single();

    if (!existingService) {
      throw new NotFoundException('Service not found');
    }

    if (existingService.user_id !== userId) {
      throw new ForbiddenException('You can only update your own services');
    }

    // Verify category exists if provided
    if (updateServiceDto.category_id) {
      const { data: category } = await supabaseClient
        .from('service_categories')
        .select('id')
        .eq('id', updateServiceDto.category_id)
        .eq('is_active', true)
        .single();

      if (!category) {
        throw new NotFoundException('Service category not found');
      }
    }

    const updateData: any = { ...updateServiceDto };
    
    // Update media info if images or videos changed
    if (updateServiceDto.images || updateServiceDto.videos) {
      const images = updateServiceDto.images || [];
      const videos = updateServiceDto.videos || [];
      updateData.primary_media_url = images[0] || videos[0] || null;
      updateData.media_type = images.length > 0 ? 'image' : 'video';
    }

    const { data, error } = await supabaseClient
      .from('services')
      .update(updateData)
      .eq('id', serviceId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update service: ${error.message}`);
    }
    // Sync tags and mentions based on the final description
    const descriptionForSync = updateServiceDto.description !== undefined
      ? updateServiceDto.description
      : data.description;

    try {
      await this.tagsService.syncTaggings(serviceId, 'service', descriptionForSync || '');
    } catch (e) {
      console.error('Failed to sync tags for updated service', serviceId, e);
    }

    try {
      await this.mentionsService.createMentions(userId, serviceId, 'service', descriptionForSync || '');
    } catch (e) {
      console.error('Failed to create mentions for updated service', serviceId, e);
    }

    return data;
  }

  async deleteService(userId: string, serviceId: string, userToken?: string) {
    // Use serviceSupabase for all DB operations
    const supabaseClient = this.serviceSupabase;

    // First verify the service belongs to the user
    const { data: existingService } = await supabaseClient
      .from('services')
      .select('user_id')
      .eq('id', serviceId)
      .single();

    if (!existingService) {
      throw new NotFoundException('Service not found');
    }

    if (existingService.user_id !== userId) {
      throw new ForbiddenException('You can only delete your own services');
    }

    const { error } = await supabaseClient
      .from('services')
      .delete()
      .eq('id', serviceId);

    if (error) {
      throw new Error(`Failed to delete service: ${error.message}`);
    }

    return { message: 'Service deleted successfully' };
  }

  async getServiceLikers(serviceId: string, limit: number = 50, offset: number = 0) {
    const { data, error } = await this.serviceSupabase
      .from('service_likes')
      .select(`
        user_id,
        created_at,
        user:user_profiles(id, username, avatar_url, is_verified, display_name)
      `)
      .eq('service_id', serviceId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Failed to fetch service likers: ${error.message}`);

    return (data || []).map((row: any) => ({
      id: row.user?.id,
      username: row.user?.username || row.user?.display_name || 'Unknown',
      avatarUrl: row.user?.avatar_url || null,
      isVerified: row.user?.is_verified || false,
      likedAt: row.created_at,
    }));
  }

  async toggleLike(userId: string, serviceId: string, userToken?: string) {
    // Use serviceSupabase to bypass RLS for like operations
    const supabaseClient = this.serviceSupabase;

    // Check if user has already liked this service
    const { data: existingLike, error: checkError } = await supabaseClient
      .from('service_likes')
      .select('id')
      .eq('service_id', serviceId)
      .eq('user_id', userId)
      .maybeSingle(); // Use maybeSingle() instead of single() to allow null results

    console.log('🔍 Checking existing like:', { existingLike, userId, serviceId });

    let liked: boolean;
    let newLikeCount: number;

    if (existingLike) {
      // User has already liked - remove like
      console.log('❌ Removing like from service_likes table');
      const { error: deleteError } = await supabaseClient
        .from('service_likes')
        .delete()
        .eq('id', existingLike.id);

      if (deleteError) {
        console.error('❌ Failed to delete like:', deleteError);
        throw new Error(`Failed to remove like: ${deleteError.message}`);
      }

      console.log('✅ Like removed from service_likes table');

      // Database trigger automatically decrements like_count, so just fetch the updated value
      const { data: service } = await supabaseClient
        .from('services')
        .select('like_count')
        .eq('id', serviceId)
        .single();

      newLikeCount = service?.like_count || 0;
      console.log('✅ Like count after trigger (decremented):', newLikeCount);

      liked = false;
    } else {
      // User hasn't liked - add like
      console.log('➕ Adding like to service_likes table');
      const { error: insertError } = await supabaseClient
        .from('service_likes')
        .insert({ service_id: serviceId, user_id: userId });

      if (insertError) {
        console.error('❌ Failed to insert like:', insertError);
        throw new Error(`Failed to add like: ${insertError.message}`);
      }

      console.log('✅ Like added to service_likes table');

      // Database trigger automatically increments like_count, so just fetch the updated value
      const { data: service } = await supabaseClient
        .from('services')
        .select('like_count')
        .eq('id', serviceId)
        .single();

      newLikeCount = service?.like_count || 0;
      console.log('✅ Like count after trigger (incremented):', newLikeCount);

      liked = true;
    }

    return { liked, likeCount: newLikeCount };
  }

  async toggleBookmark(userId: string, serviceId: string, userToken?: string) {
    // Use serviceSupabase to bypass RLS
    const supabaseClient = this.serviceSupabase;

    // Check if user has already bookmarked this service
    const { data: existingBookmark } = await supabaseClient
      .from('service_bookmarks')
      .select('id')
      .eq('service_id', serviceId)
      .eq('user_id', userId)
      .single();

    let bookmarked: boolean;
    let newSaveCount: number;

    if (existingBookmark) {
      // User has already bookmarked - remove bookmark
      const { error: deleteError } = await supabaseClient
        .from('service_bookmarks')
        .delete()
        .eq('id', existingBookmark.id);

      if (deleteError) {
        throw new Error(`Failed to remove bookmark: ${deleteError.message}`);
      }

      // Decrement save count
      const { data: service } = await supabaseClient
        .from('services')
        .select('save_count')
        .eq('id', serviceId)
        .single();

      newSaveCount = Math.max(0, (service?.save_count || 0) - 1);

      await supabaseClient
        .from('services')
        .update({ save_count: newSaveCount })
        .eq('id', serviceId);

      bookmarked = false;
    } else {
      // User hasn't bookmarked - add bookmark
      const { error: insertError } = await supabaseClient
        .from('service_bookmarks')
        .insert({ service_id: serviceId, user_id: userId });

      if (insertError) {
        throw new Error(`Failed to add bookmark: ${insertError.message}`);
      }

      // Increment save count
      const { data: service } = await supabaseClient
        .from('services')
        .select('save_count')
        .eq('id', serviceId)
        .single();

      newSaveCount = (service?.save_count || 0) + 1;

      await supabaseClient
        .from('services')
        .update({ save_count: newSaveCount })
        .eq('id', serviceId);

      bookmarked = true;
    }

    return { bookmarked, saveCount: newSaveCount };
  }

  async getBookmarkedServices(userId: string, userToken?: string) {
    // Use serviceSupabase to bypass RLS
    const supabaseClient = this.serviceSupabase;

    const { data: bookmarks, error } = await supabaseClient
      .from('service_bookmarks')
      .select(`
        service:services(
          *,
          service_categories (
            name,
            icon_name,
            color_hex
          ),
          user_profiles!services_user_id_fkey (
            username,
            avatar_url,
            is_verified,
            display_name
          )
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch bookmarked services: ${error.message}`);
    }

    // Extract services from bookmarks and add isBookmarked flag
    const services = bookmarks?.map((bookmark: any) => ({
      ...bookmark.service,
      isBookmarked: true,
    })) || [];

    return services;
  }

  async incrementShareCount(serviceId: string, userToken?: string) {
    // Use serviceSupabase to bypass RLS
    const supabaseClient = this.serviceSupabase;

    // Get current service
    const { data: service } = await supabaseClient
      .from('services')
      .select('share_count')
      .eq('id', serviceId)
      .single();

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    const newShareCount = (service.share_count || 0) + 1;

    const { error } = await supabaseClient
      .from('services')
      .update({ share_count: newShareCount })
      .eq('id', serviceId);

    if (error) {
      throw new Error(`Failed to increment share count: ${error.message}`);
    }

    return { shareCount: newShareCount };
  }

  async getServiceComments(serviceId: string, userToken?: string) {
    // Use serviceSupabase to bypass RLS on user_profiles JOIN
    const { data: comments, error } = await this.serviceSupabase
      .from('service_comments')
      .select(`
        id,
        content,
        like_count,
        reply_count,
        created_at,
        user_profiles!service_comments_user_id_fkey (
          id,
          username,
          avatar_url
        )
      `)
      .eq('service_id', serviceId)
      .is('parent_comment_id', null) // Only get top-level comments
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch comments: ${error.message}`);
    }

    // Transform to match frontend format
    return comments?.map(comment => ({
      id: comment.id,
      userId: comment.user_profiles?.id || '',
      userName: comment.user_profiles?.username || comment.user_profiles?.display_name || 'Unknown User',
      userAvatar: comment.user_profiles?.avatar_url || null,
      comment: comment.content,
      createdAt: comment.created_at,
      likes: comment.like_count || 0,
      replies: comment.reply_count || 0,
    })) || [];
  }

  async addComment(userId: string, serviceId: string, content: string, userToken?: string) {
    // Use serviceSupabase to bypass RLS on user_profiles JOIN
    const { data: comment, error } = await this.serviceSupabase
      .from('service_comments')
      .insert({
        service_id: serviceId,
        user_id: userId,
        content: content,
      })
      .select(`
        id,
        content,
        like_count,
        reply_count,
        created_at,
        user_profiles!service_comments_user_id_fkey (
          id,
          username,
          avatar_url
        )
      `)
      .single();

    if (error) {
      throw new Error(`Failed to add comment: ${error.message}`);
    }

    // Return transformed comment
    return {
      id: comment.id,
      userId: comment.user_profiles?.id || '',
      userName: comment.user_profiles?.username || comment.user_profiles?.display_name || 'Unknown User',
      userAvatar: comment.user_profiles?.avatar_url || null,
      comment: comment.content,
      createdAt: comment.created_at,
      likes: comment.like_count || 0,
      replies: comment.reply_count || 0,
    };
  }

  async addRating(userId: string, serviceId: string, rating: number, userToken?: string) {
    // Use serviceSupabase to bypass RLS
    const supabaseClient = this.serviceSupabase;

    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }

    // Get current service to calculate new average
    const { data: service } = await supabaseClient
      .from('services')
      .select('average_rating, rating_count')
      .eq('id', serviceId)
      .single();

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    // Calculate new average rating
    const currentRating = service.average_rating || 0;
    const currentCount = service.rating_count || 0;
    const newCount = currentCount + 1;
    const newAverage = ((currentRating * currentCount) + rating) / newCount;

    const { data, error } = await supabaseClient
      .from('services')
      .update({
        average_rating: newAverage,
        rating_count: newCount
      })
      .eq('id', serviceId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to add rating: ${error.message}`);
    }

    return {
      rating: newAverage,
      ratingCount: newCount,
      userRating: rating
    };
  }

  /**
   * Upload service with media files handling (using multer)
   */
  async uploadServiceWithFiles(
    userId: string,
    files: Express.Multer.File[],
    serviceData: CreateServiceDto,
    userToken?: string
  ): Promise<any> {
    try {
      if (!files || files.length === 0) {
        throw new BadRequestException('At least one media file is required');
      }

      // Debug: Log file details for each file
      console.log('🔍 Received files details:');
      files.forEach((file, index) => {
        console.log(`File ${index + 1}:`, {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          fieldname: file.fieldname
        });
      });

      // Validate files - expanded video format support
      const allowedTypes = [
        'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
        'video/mp4', 'video/mov', 'video/quicktime', 'video/avi', 'video/webm'
      ];
      const maxSize = 50 * 1024 * 1024; // 50MB per file (larger for videos)

      for (const file of files) {
        if (!allowedTypes.includes(file.mimetype)) {
          console.error('❌ Invalid MIME type for service upload:', file.mimetype, 'Expected one of:', allowedTypes);
          throw new BadRequestException(`Invalid file type: ${file.mimetype}. Only JPEG, PNG, WebP images and MP4, MOV, AVI, WebM videos are allowed.`);
        }
        if (file.size > maxSize) {
          throw new BadRequestException('Media file too large. Maximum size is 50MB per file.');
        }
      }

      // Use service role client for storage uploads - user tokens cannot be used
      // with Supabase Storage because they use a different JWT signing secret
      const supabaseClient = this.serviceSupabase;

      // Verify user is a seller or rider using serviceSupabase to bypass RLS
      const { data: userProfile } = await this.serviceSupabase
        .from('user_profiles')
        .select('is_seller, is_rider')
        .eq('id', userId)
        .single();

      if (!userProfile?.is_seller && !userProfile?.is_rider) {
        throw new ForbiddenException('Only sellers and riders can create services');
      }

      // Upload all media files to Supabase Storage
      const uploadPromises = files.map(async (file, index) => {
        const fileExtension = file.originalname.split('.').pop() || 'jpg';
        const timestamp = Date.now();
        const uniqueFileName = `${userId}/${timestamp}-${index}-service.${fileExtension}`;

        const { data: uploadData, error: uploadError } = await supabaseClient.storage
          .from('media')
          .upload(uniqueFileName, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
          });

        if (uploadError) {
          throw new BadRequestException(`Media upload failed: ${uploadError.message}`);
        }

        // Get public URL
        const { data: urlData } = supabaseClient.storage
          .from('media')
          .getPublicUrl(uniqueFileName);

        return {
          url: urlData.publicUrl,
          type: file.mimetype.startsWith('image/') ? 'image' : 'video',
        };
      });

      const mediaFiles = await Promise.all(uploadPromises);
      const imageUrls = mediaFiles.filter(m => m.type === 'image').map(m => m.url);
      const videoUrls = mediaFiles.filter(m => m.type === 'video').map(m => m.url);

      // Create service with uploaded media URLs
      const createServiceDto: CreateServiceDto = {
        ...serviceData,
        images: imageUrls,
        videos: videoUrls,
        primary_image_url: imageUrls[0] || videoUrls[0], // First image or video as primary
      };

      // Create service record
      const service = await this.createService(userId, createServiceDto, userToken);

      return {
        ...service,
        message: 'Service uploaded successfully',
      };

    } catch (error) {
      console.error('Service upload error:', error);
      throw error;
    }
  }
}