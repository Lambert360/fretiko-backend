import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';

@Injectable()
export class ServicesService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
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
    // Create user-specific Supabase client if token is provided
    const supabaseClient = userToken 
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

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

    return data;
  }

  async getServicesByUser(userId: string, userToken?: string) {
    const supabaseClient = userToken 
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

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
    let query = this.supabase
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
          avatar_url
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

    return data;
  }

  async getVideoFeed(options: { limit?: number; offset?: number }) {
    console.log('🎥 getVideoFeed called with options:', options);

    // Get services that have videos for the TikTok-style video feed
    const query = this.supabase
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
          avatar_url
        )
      `)
      .eq('status', 'active')
      // Temporarily remove video filter to see if we have any services at all
      // .not('videos', 'eq', '{}')  // Only services with videos
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

    // Transform services data to video feed format
    const videoFeed = data?.map(service => {
      console.log('🎥 Transforming service:', service.id, 'user_id:', service.user_id);
      return {
        id: service.id,
        title: service.name,
        thumbnail: service.images?.[0] || null,
        videoUri: service.videos?.[0] || null,
        userId: service.user_id, // Add the missing userId field
        username: service.user_profiles?.username || 'user',
        userAvatar: service.user_profiles?.avatar_url || null,
        description: service.description || '',
        likes: service.like_count?.toString() || '0',
        comments: '0', // Will need comments table
        shares: '0',   // Will need shares functionality
        price: service.base_price,
        originalPrice: null, // No original price concept for services yet
        location: service.location || '',
        serviceProvider: service.user_profiles?.username || 'Unknown Provider',
        rating: service.average_rating || 0,
        completedJobs: service.booking_count?.toString() || '0',
        isLiked: false, // Will need user-specific like status
        isBookmarked: false, // Will need bookmarks functionality
      };
    }) || [];

    console.log('🎥 Final video feed items:', videoFeed.length);
    console.log('🎥 First video feed item userId:', videoFeed[0]?.userId);

    return videoFeed;
  }

  async getService(id: string) {
    const { data, error } = await this.supabase
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
          avatar_url
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      throw new NotFoundException(`Service not found: ${error.message}`);
    }

    // Increment view count
    await this.supabase
      .from('services')
      .update({ view_count: data.view_count + 1 })
      .eq('id', id);

    return data;
  }

  async updateService(userId: string, serviceId: string, updateServiceDto: UpdateServiceDto, userToken?: string) {
    const supabaseClient = userToken 
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

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

    return data;
  }

  async deleteService(userId: string, serviceId: string, userToken?: string) {
    const supabaseClient = userToken 
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

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

  async toggleLike(userId: string, serviceId: string, userToken?: string) {
    const supabaseClient = userToken 
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Check if user has already liked this service
    // For now, we'll just increment/decrement the counter
    // In a full implementation, you'd have a likes table to track user-service relationships
    
    // Get current service
    const { data: service } = await supabaseClient
      .from('services')
      .select('like_count')
      .eq('id', serviceId)
      .single();

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    // For simplicity, toggle the like count (in production, you'd check user's like status)
    const newLikeCount = service.like_count + 1;
    
    const { data, error } = await supabaseClient
      .from('services')
      .update({ like_count: newLikeCount })
      .eq('id', serviceId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to toggle like: ${error.message}`);
    }

    return { liked: true, likeCount: newLikeCount };
  }

  async toggleBookmark(userId: string, serviceId: string, userToken?: string) {
    const supabaseClient = userToken 
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    // Get current service
    const { data: service } = await supabaseClient
      .from('services')
      .select('save_count')
      .eq('id', serviceId)
      .single();

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    // For simplicity, increment save count (in production, you'd check user's bookmark status)
    const newSaveCount = service.save_count + 1;
    
    const { data, error } = await supabaseClient
      .from('services')
      .update({ save_count: newSaveCount })
      .eq('id', serviceId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to toggle bookmark: ${error.message}`);
    }

    return { bookmarked: true, saveCount: newSaveCount };
  }

  async addRating(userId: string, serviceId: string, rating: number, userToken?: string) {
    const supabaseClient = userToken 
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

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

      const supabaseClient = userToken
        ? createUserSupabaseClient(this.configService, userToken)
        : this.supabase;

      // Verify user is a seller or rider
      const { data: userProfile } = await supabaseClient
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