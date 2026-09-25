import { Injectable, NotFoundException, BadRequestException, ForbiddenException, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { CreateAuctionDto, PlaceBidDto, AuctionFilterDto, UpdateProxyBidDto, WatchlistDto, CreateAuctionItemDto } from './dto';
import { Auction, AuctionWithDetails, AuctionBid, AuctionCategory, AuctionCategoryWithStats, PublicBidHistoryItem, AuctionItem, AuctionItemWithDetails } from './entities';
import { WalletService } from '../wallet/wallet.service';
import { AuctionGateway } from './auction.gateway';
import { PushNotificationService } from '../notifications/push-notification.service';
import { EmailNotificationService } from '../notifications/email-notification.service';
import {
  auctionWonEmail,
  auctionWinForfeitedEmail,
  outbidEmail,
} from '../notifications/email-templates';
import { isAdultViewer } from '../shared/viewer-age';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class AuctionsService {
  private supabase;
  private serviceSupabase;
  private processingProxyBids = new Set<string>(); // Track auctions currently processing proxy bids

  constructor(
    private configService: ConfigService,
    private walletService: WalletService,
    @Inject(forwardRef(() => AuctionGateway))
    private auctionGateway: AuctionGateway,
    private pushNotificationService: PushNotificationService,
    private emailNotificationService: EmailNotificationService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Get all auction categories with optional stats
   */
  async getCategories(includeStats = false): Promise<AuctionCategory[] | AuctionCategoryWithStats[]> {
    let query = this.supabase
      .from('auction_categories')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    const { data, error } = await query;

    if (error) {
      throw new Error(`Database error: ${error.message}`);
    }

    if (!includeStats) {
      return data || [];
    }

    // Add auction counts for each category
    const categoriesWithStats = await Promise.all(
      (data || []).map(async (category) => {
        const { count: totalCount } = await this.supabase
          .from('auctions')
          .select('*', { count: 'exact', head: true })
          .eq('category_id', category.id);

        const { count: activeCount } = await this.supabase
          .from('auctions')
          .select('*', { count: 'exact', head: true })
          .eq('category_id', category.id)
          .eq('status', 'active');

        return {
          ...category,
          auction_count: totalCount || 0,
          active_auction_count: activeCount || 0,
        };
      })
    );

    return categoriesWithStats;
  }

  /**
   * Get auctions with filtering and pagination
   */
  async findAuctions(filters: AuctionFilterDto, userId?: string): Promise<{ auctions: AuctionWithDetails[]; total: number }> {
    // Vendor catalog visibility: hide auctions from unlisted sellers, and from
    // adult-content sellers unless the viewer is 18+. A seller viewing their
    // own auctions (my-auctions) bypasses both filters.
    const isSelfList = !!filters.seller_id && filters.seller_id === userId;
    const viewerIsAdult = isSelfList ? true : await isAdultViewer(this.serviceSupabase, userId);

    const applyFilters = (q: any) => {
      if (!isSelfList) {
        q = q.eq('seller_catalog_hidden', false);
        if (!viewerIsAdult) {
          q = q.eq('seller_is_adult_content', false);
        }
      }

      if (filters.search) {
        q = q.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
      }

      if (filters.category_id) {
        q = q.eq('category_id', filters.category_id);
      }

      if (filters.category_slug) {
        q = q.eq('category_slug', filters.category_slug);
      }

      if (filters.status) {
        q = q.eq('status', filters.status);
      }

      if (filters.auction_type) {
        q = q.eq('auction_type', filters.auction_type);
      }

      if (filters.min_price) {
        q = q.gte('current_bid', filters.min_price);
      }

      if (filters.max_price) {
        q = q.lte('current_bid', filters.max_price);
      }

      if (filters.time_filter) {
        const now = new Date();
        switch (filters.time_filter) {
          case 'ending_soon':
            // Ending within next 2 hours
            const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
            q = q.lte('end_time', twoHoursFromNow.toISOString()).eq('status', 'active');
            break;
          case 'just_started':
            // Started within last 2 hours
            const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
            q = q.gte('start_time', twoHoursAgo.toISOString()).eq('status', 'active');
            break;
          case 'upcoming':
            q = q.eq('time_status', 'upcoming');
            break;
        }
      }

      if (filters.no_reserve) {
        q = q.is('reserve_price', null);
      }

      if (filters.seller_id) {
        q = q.eq('seller_id', filters.seller_id);
      }

      return q;
    };

    // Build count query (same filters, no pagination/sort)
    let countQuery = this.supabase
      .from('auction_summary')
      .select('*', { count: 'exact', head: true });
    countQuery = applyFilters(countQuery);

    // Build data query
    let query = this.supabase
      .from('auction_summary')
      .select('*');
    query = applyFilters(query);

    // Apply sorting
    switch (filters.sort) {
      case 'price_asc':
        query = query.order('current_bid', { ascending: true });
        break;
      case 'price_desc':
        query = query.order('current_bid', { ascending: false });
        break;
      case 'time_asc':
        query = query.order('end_time', { ascending: true });
        break;
      case 'time_desc':
        query = query.order('end_time', { ascending: false });
        break;
      case 'bids_desc':
        query = query.order('total_bids', { ascending: false });
        break;
      case 'created_desc':
      default:
        query = query.order('created_at', { ascending: false });
        break;
    }

    // Get total count for pagination
    const { count } = await countQuery;

    // Apply pagination
    const limit = filters.limit || 20;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      throw new Error(`Database error: ${error.message}`);
    }

    // Add user-specific data if userId provided
    let auctions = data || [];
    if (userId && auctions.length > 0) {
      auctions = await this.addUserSpecificData(auctions, userId);
    }

    return {
      auctions,
      total: count || 0,
    };
  }

  /**
   * Get single auction by ID with full details.
   * `enforceAdultGate` should be true for public/detail endpoints: auctions by
   * adult-content sellers then 403 for viewers who are not verified 18+.
   * Unlisted (catalog_hidden) sellers still resolve — direct links work.
   * Internal callers leave it false so seller/admin flows are unaffected.
   */
  async findById(id: string, userId?: string, enforceAdultGate = false): Promise<AuctionWithDetails> {
    const { data, error } = await this.supabase
      .from('auction_summary')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException('Auction not found');
    }

    if (
      enforceAdultGate &&
      data.seller_is_adult_content &&
      data.seller_id !== userId &&
      !(await isAdultViewer(this.serviceSupabase, userId))
    ) {
      throw new ForbiddenException({
        code: 'ADULT_CONTENT_RESTRICTED',
        message: 'This content is restricted to viewers 18 and older',
      });
    }

    // Add user-specific data if userId provided
    let auction = data;
    if (userId) {
      const auctionsWithUserData = await this.addUserSpecificData([auction], userId);
      auction = auctionsWithUserData[0];
    }

    // Track view count (only for authenticated users, unique per user)
    if (userId) {
      try {
        // Check if user has already viewed this auction
        const { data: existingView } = await this.serviceSupabase
          .from('auction_views')
          .select('id')
          .eq('auction_id', id)
          .eq('viewer_id', userId)
          .single();

        if (!existingView) {
          // Insert view record (trigger will auto-increment view_count)
          const { error: insertError } = await this.serviceSupabase
            .from('auction_views')
            .insert({
              auction_id: id,
              viewer_id: userId,
            });

          if (!insertError) {
            // Fetch updated view_count after trigger execution
            const { data: updatedStats } = await this.serviceSupabase
      .from('auctions')
              .select('view_count')
              .eq('id', id)
              .single();

            if (updatedStats) {
              // Update the auction object with the new view_count
              auction.view_count = updatedStats.view_count;

              // Broadcast view count update via WebSocket
              try {
                await this.auctionGateway.broadcastViewCountUpdate(id, updatedStats.view_count);
              } catch (error) {
                console.error(`[Auction ${id}] Error broadcasting view count update:`, error);
                // Don't throw - WebSocket broadcast failure shouldn't fail the request
              }
            }
          } else {
            // Log error but don't fail the request
            console.error(`[Auction ${id}] Error recording view for user ${userId}:`, insertError);
          }
        }
        // If view already exists, do nothing (view already counted)
      } catch (error) {
        // Log error but don't fail the request - view tracking is non-critical
        console.error(`[Auction ${id}] Error in view tracking:`, error);
      }
    }
    // If userId is not provided (unauthenticated), don't increment view count

    return auction;
  }

  /**
   * Get the seller ID of an auction without side effects
   * Used by guards to avoid incrementing view counts
   */
  async getAuctionSellerId(auctionId: string): Promise<string | null> {
    const { data, error } = await this.serviceSupabase
      .from('auctions')
      .select('seller_id')
      .eq('id', auctionId)
      .single();

    if (error || !data) {
      return null;
    }

    return data.seller_id;
  }

  /**
   * Get auction status/time fields without view-count side effects
   * Used by guards to avoid incrementing views
   */
  async getAuctionForGuard(auctionId: string): Promise<any | null> {
    const { data, error } = await this.serviceSupabase
      .from('auctions')
      .select('id, status, start_time, end_time, seller_id, bid_increment, auction_type, current_item_id')
      .eq('id', auctionId)
      .single();

    if (error || !data) {
      return null;
    }

    return data;
  }

  /**
   * Track auction view (increment viewer count)
   * Called from the dedicated endpoint for real-time viewer count updates
   */
  async trackAuctionView(auctionId: string, userId: string): Promise<number> {
    try {
      // Use service client to bypass RLS for view tracking
      // Check if user has already viewed this auction
      const { data: existingView } = await this.serviceSupabase
        .from('auction_views')
        .select('id')
        .eq('auction_id', auctionId)
        .eq('viewer_id', userId)
        .single();

      if (!existingView) {
        // Insert view record (trigger will auto-increment view_count)
        const { error: insertError } = await this.serviceSupabase
          .from('auction_views')
          .insert({
            auction_id: auctionId,
            viewer_id: userId,
          });

        if (!insertError) {
          // Fetch updated view_count after trigger execution
          const { data: updatedStats } = await this.serviceSupabase
            .from('auctions')
            .select('view_count')
            .eq('id', auctionId)
            .single();

          if (updatedStats) {
            // Broadcast view count update via WebSocket
            try {
              await this.auctionGateway.broadcastViewCountUpdate(auctionId, updatedStats.view_count);
              console.log(`📊 Broadcasted view count update for auction ${auctionId}: ${updatedStats.view_count}`);
            } catch (error) {
              console.error(`[Auction ${auctionId}] Error broadcasting view count update:`, error);
              // Don't throw - WebSocket broadcast failure shouldn't fail the request
            }

            return updatedStats.view_count;
          }
        } else {
          // Log error but don't fail the request
          console.error(`[Auction ${auctionId}] Error recording view for user ${userId}:`, insertError);
        }
      }
      // If view already exists, just return current count without broadcasting again
      const { data: currentStats } = await this.serviceSupabase
        .from('auctions')
        .select('view_count')
        .eq('id', auctionId)
        .single();

      return currentStats?.view_count || 0;
    } catch (error) {
      // Log error but don't fail the request - view tracking is non-critical
      console.error(`[Auction ${auctionId}] Error in trackAuctionView for user ${userId}:`, error);
      return 0;
    }
  }

  /**
   * Generate a thumbnail from a video file using ffmpeg
   */
  private async generateVideoThumbnail(
    videoFile: Express.Multer.File,
    userId: string,
    supabaseClient: any
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      // Create temporary paths
      const tempDir = os.tmpdir();
      const videoPath = path.join(tempDir, `video-${Date.now()}.mp4`);
      const thumbnailPath = path.join(tempDir, `thumbnail-${Date.now()}.jpg`);

      try {
        // Write video buffer to temporary file
        fs.writeFileSync(videoPath, videoFile.buffer);

        // Extract thumbnail at 1 second mark
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ['00:00:01.000'],
            filename: path.basename(thumbnailPath),
            folder: path.dirname(thumbnailPath),
            size: '640x?', // Maintain aspect ratio
          })
          .on('end', async () => {
            try {
              // Read the generated thumbnail
              const thumbnailBuffer = fs.readFileSync(thumbnailPath);

              // Upload thumbnail to Supabase Storage
              const timestamp = Date.now();
              const uniqueFileName = `${userId}/${timestamp}-auction-video-thumbnail.jpg`;

              const { error: uploadError } = await supabaseClient.storage
                .from('media')
                .upload(uniqueFileName, thumbnailBuffer, {
                  contentType: 'image/jpeg',
                  upsert: false,
                });

              if (uploadError) {
                console.error('❌ Thumbnail upload error:', uploadError);
                resolve(null);
              } else {
                // Get public URL
                const { data: urlData } = supabaseClient.storage
                  .from('media')
                  .getPublicUrl(uniqueFileName);

                resolve(urlData.publicUrl);
              }

              // Clean up temporary files
              fs.unlinkSync(videoPath);
              fs.unlinkSync(thumbnailPath);
            } catch (error) {
              console.error('❌ Error processing thumbnail:', error);
              // Clean up on error
              if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
              if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);
              resolve(null);
            }
          })
          .on('error', (error) => {
            console.error('❌ FFmpeg error:', error);
            // Clean up on error
            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            resolve(null);
          });
      } catch (error) {
        console.error('❌ Error writing video file:', error);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        resolve(null);
      }
    });
  }

  /**
   * Create a new auction
   */
  async createAuction(
    userId: string, 
    createAuctionDto: CreateAuctionDto, 
    userToken?: string, 
    images?: Express.Multer.File[], 
    video?: Express.Multer.File[]
  ): Promise<Auction> {
    // Use serviceSupabase for all operations - user tokens can't be used for Supabase DB/Storage
    const client = this.serviceSupabase;

    // Verify user is a seller using serviceSupabase to bypass RLS
    const { data: userProfile } = await this.serviceSupabase
      .from('user_profiles')
      .select('is_seller')
      .eq('id', userId)
      .single();

    if (!userProfile?.is_seller) {
      throw new ForbiddenException('Only sellers can create auctions');
    }

    // Verify category exists using serviceSupabase
    const { data: category } = await client
      .from('auction_categories')
      .select('id')
      .eq('id', createAuctionDto.category_id)
      .single();

    if (!category) {
      throw new BadRequestException('Invalid category');
    }

    // Validate timing
    const startTime = new Date(createAuctionDto.start_time);
    const endTime = new Date(createAuctionDto.end_time);
    const now = new Date();

    if (startTime <= now) {
      throw new BadRequestException('Start time must be in the future');
    }

    if (endTime <= startTime) {
      throw new BadRequestException('End time must be after start time');
    }

    // Validate live auction has items if provided
    if (createAuctionDto.auction_type === 'live' && (!createAuctionDto.items || createAuctionDto.items.length === 0)) {
      throw new BadRequestException('Live auctions must have at least one item');
    }
    // Handle media uploads based on auction type
    let imageUrls: string[] = [];
    let videoUrl: string | undefined = createAuctionDto.video_url;

    if (createAuctionDto.auction_type === 'timed') {
      // Timed auctions: upload images and video as before
      imageUrls = await this.uploadImages(images || [], userId, client);
      videoUrl = await this.uploadVideo(video?.[0], userId, client, createAuctionDto.video_url);
    } else {
      // Live auctions: files will be handled per item
      console.log('📦 Live auction - files will be processed per item');
      // Upload images for live auction
      imageUrls = await this.uploadImages(images || [], userId, client);
    }

    // Generate thumbnail
    let thumbnailUrl: string | null | undefined = createAuctionDto.thumbnail_url;
    if (imageUrls.length > 0) {
      thumbnailUrl = imageUrls[0];
    } else if (video && video.length > 0 && !createAuctionDto.thumbnail_url) {
      thumbnailUrl = await this.generateVideoThumbnail(video[0], userId, client);
    }

    // Prepare auction data
    const auctionData = {
      seller_id: userId,
      category_id: createAuctionDto.category_id,
      title: createAuctionDto.title,
      description: createAuctionDto.description,
      lot_number: createAuctionDto.lot_number,
      starting_price: createAuctionDto.starting_price,
      reserve_price: createAuctionDto.reserve_price,
      bid_increment: createAuctionDto.bid_increment || 1.0,
      auction_type: createAuctionDto.auction_type,
      start_time: createAuctionDto.start_time,
      end_time: createAuctionDto.end_time,
      soft_close_enabled: createAuctionDto.soft_close_enabled ?? true,
      soft_close_extension: createAuctionDto.soft_close_extension || 300,
      images: imageUrls.length > 0 ? imageUrls : (createAuctionDto.images || []),
      video_url: videoUrl,
      thumbnail_url: thumbnailUrl,
      stream_url: createAuctionDto.stream_url,
      auctioneer_enabled: createAuctionDto.auctioneer_enabled ?? true,
      crowd_sounds_enabled: createAuctionDto.crowd_sounds_enabled ?? true,
    };

    const { data, error } = await client
      .from('auctions')
      .insert(auctionData)
      .select()
      .single();

    if (error) {
      throw new BadRequestException(`Failed to create auction: ${error.message}`);
    }

    // Handle items based on auction type
    if (createAuctionDto.auction_type === 'live') {
      // Combine images and videos for live auction processing
      const allFiles = [...(images || []), ...(video || [])];
      console.log('🔧 Live auction - combining files for processing:', {
        images: images?.length || 0,
        videos: video?.length || 0,
        totalFiles: allFiles.length
      });
      await this.createLiveAuctionItems(data.id, createAuctionDto.items || [], allFiles, userId, client);
    } else {
      // Timed auctions: create initial item from auction data
      await this.createTimedAuctionItem(data.id, createAuctionDto, imageUrls, videoUrl, userId, client);
    }

    // Broadcast auction creation event for scheduled auctions
    if (data.status === 'scheduled') {
      await this.auctionGateway.broadcastAuctionStatusChange(data.id, 'scheduled', {
        message: 'New auction created',
        auction: data,
      });
    }

    console.log('✅ Auction created successfully:', data.id);
    return data;
  }

  /**
   * Helper method to upload images
   */
  private async uploadImages(images: Express.Multer.File[], userId: string, client: any): Promise<string[]> {
    const imageUrls: string[] = [];
    if (images && images.length > 0) {
      console.log(`📤 Uploading ${images.length} images to Supabase Storage...`);

      for (const image of images) {
        const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.${image.originalname.split('.').pop()}`;

        const { data: uploadData, error: uploadError } = await client.storage
          .from('media')
          .upload(fileName, image.buffer, {
            contentType: image.mimetype,
            cacheControl: '3600',
          });

        if (uploadError) {
          console.error('❌ Image upload failed:', uploadError);
          throw new BadRequestException(`Failed to upload image: ${uploadError.message}`);
        }

        // Get public URL
        const { data: publicUrlData } = client.storage
          .from('media')
          .getPublicUrl(fileName);

        imageUrls.push(publicUrlData.publicUrl);
        console.log(`✅ Image uploaded: ${publicUrlData.publicUrl}`);
      }
    }
    return imageUrls;
  }

  /**
   * Helper method to upload video
   */
  private async uploadVideo(video: Express.Multer.File | undefined, userId: string, client: any, existingVideoUrl?: string): Promise<string | undefined> {
    let videoUrl: string | undefined = existingVideoUrl;
    
    if (video) {
      console.log(`🎥 Uploading video to Supabase Storage...`);

      // Validate video file type
      const allowedVideoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
      if (!allowedVideoTypes.includes(video.mimetype)) {
        throw new BadRequestException('Invalid video file type. Only MP4, MOV, and AVI are allowed.');
      }

      // Validate video file size (50MB max)
      const maxVideoSize = 50 * 1024 * 1024; // 50MB
      if (video.size > maxVideoSize) {
        throw new BadRequestException('Video file too large. Maximum size is 50MB.');
      }

      const fileExtension = video.originalname.split('.').pop() || 'mp4';
      const timestamp = Date.now();
      const fileName = `${userId}/${timestamp}-auction-video.${fileExtension}`;

      const { data: uploadData, error: uploadError } = await client.storage
        .from('media')
        .upload(fileName, video.buffer, {
          contentType: video.mimetype,
          cacheControl: '3600',
        });

      if (uploadError) {
        console.error('❌ Video upload failed:', uploadError);
        throw new BadRequestException(`Failed to upload video: ${uploadError.message}`);
      }

      // Get public URL
      const { data: publicUrlData } = client.storage
        .from('media')
        .getPublicUrl(fileName);

      videoUrl = publicUrlData.publicUrl;
      console.log(`✅ Video uploaded: ${publicUrlData.publicUrl}`);
    }
    
    return videoUrl;
  }

  /**
   * Helper method to create items for live auctions
   */
  private async createLiveAuctionItems(
    auctionId: string, 
    items: CreateAuctionItemDto[], 
    files: Express.Multer.File[], 
    userId: string, 
    client: any
  ): Promise<void> {
    console.log(`📦 Creating ${items.length} items for live auction ${auctionId}`);
    console.log('📦 Raw items data:', JSON.stringify(items, null, 2));
    
    // Group files by item index (assuming frontend sends files with item index prefixes)
    const filesByItem = this.groupFilesByItem(files, items.length);
    console.log('📦 Files grouped by item:', Object.keys(filesByItem).map(key => `${key}: ${filesByItem[key].length} files`));
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemFiles = filesByItem[i] || [];
      
      console.log(`📦 Processing item ${i}:`, {
        title: item.title,
        description: item.description,
        starting_price: item.starting_price,
        lot_number: item.lot_number,
        hasFiles: itemFiles.length > 0
      });
      
      // Upload images for this item
      const itemImageUrls = await this.uploadImages(
        itemFiles.filter(file => file.mimetype.startsWith('image/')), 
        userId, 
        client
      );
      
      // Upload video for this item
      const itemVideo = itemFiles.find(file => file.mimetype.startsWith('video/'));
      console.log(`🎥 Item ${i} video check:`, {
        totalFiles: itemFiles.length,
        videoFound: !!itemVideo,
        videoDetails: itemVideo ? {
          originalname: itemVideo.originalname,
          mimetype: itemVideo.mimetype,
          size: itemVideo.size
        } : null
      });
      const itemVideoUrl = await this.uploadVideo(itemVideo, userId, client);
      
      // Create auction item
      const itemData = {
        auction_id: auctionId,
        title: item.title,
        description: item.description || '',
        lot_number: item.lot_number || `LOT-${i + 1}`,
        starting_price: item.starting_price,
        reserve_price: item.reserve_price,
        current_bid: 0,
        bid_increment: item.bid_increment || 1.0,
        bidding_status: 'waiting',
        order_in_auction: i + 1,
        bidding_duration: item.bidding_duration || 120,
        images: itemImageUrls,
        video_url: itemVideoUrl,
      };

      const { data: createdItem, error: itemError } = await client
        .from('auction_items')
        .insert(itemData)
        .select()
        .single();

      if (itemError) {
        console.error(`⚠️ Failed to create auction item ${i + 1}:`, itemError);
        throw new BadRequestException(`Failed to create auction item ${i + 1}: ${itemError.message}`);
      }

      console.log(`✅ Created auction item ${i + 1}:`, createdItem.id);

      // Set first item as current item
      if (i === 0) {
        await client
          .from('auctions')
          .update({ current_item_id: createdItem.id })
          .eq('id', auctionId);
      }
    }
  }

  /**
   * Helper method to create item for timed auctions
   */
  private async createTimedAuctionItem(
    auctionId: string,
    createAuctionDto: CreateAuctionDto,
    imageUrls: string[],
    videoUrl: string | undefined,
    userId: string,
    client: any
  ): Promise<void> {
    const initialItemData = {
      auction_id: auctionId,
      title: createAuctionDto.title,
      description: createAuctionDto.description,
      lot_number: createAuctionDto.lot_number,
      starting_price: createAuctionDto.starting_price,
      reserve_price: createAuctionDto.reserve_price,
      current_bid: 0,
      bid_increment: createAuctionDto.bid_increment || 1.0,
      bidding_status: 'waiting',
      order_in_auction: 1,
      bidding_duration: 120, // Default 2 minutes
      images: imageUrls.length > 0 ? imageUrls : (createAuctionDto.images || []),
      video_url: videoUrl,
    };

    const { data: initialItem, error: itemError } = await client
      .from('auction_items')
      .insert(initialItemData)
      .select()
      .single();

    if (itemError) {
      console.error('⚠️ Failed to create initial auction item:', itemError);
      // Don't fail the auction creation if item creation fails
    } else {
      // Set this as the current item
      await client
        .from('auctions')
        .update({ current_item_id: initialItem.id })
        .eq('id', auctionId);
      console.log('✅ Initial auction item created for timed auction');
    }
  }

  /**
   * Helper method to group files by item index
   * Expects files to be named with item index prefix (e.g., "item-0-image-0", "item-1-video-0")
   */
  private groupFilesByItem(files: Express.Multer.File[], itemCount: number): Record<number, Express.Multer.File[]> {
    const filesByItem: Record<number, Express.Multer.File[]> = {};
    
    // Initialize empty arrays for each item
    for (let i = 0; i < itemCount; i++) {
      filesByItem[i] = [];
    }
    
    // Group files by item index
    files.forEach(file => {
      console.log(`🔍 Processing file: ${file.originalname}, mimetype: ${file.mimetype}`);
      // Try to extract item index from filename (new format: item-0-image-0)
      const match = file.originalname.match(/item-(\d+)-(image|video)-\d+/);
      if (match) {
        const itemIndex = parseInt(match[1]);
        if (itemIndex < itemCount) {
          filesByItem[itemIndex].push(file);
          console.log(`📁 Grouped file ${file.originalname} to item ${itemIndex}`);
        }
      } else {
        // If no item index, assume it belongs to first item (backward compatibility)
        filesByItem[0].push(file);
        console.log(`📁 Grouped file ${file.originalname} to item 0 (default)`);
      }
    });
    
    console.log('📦 Final file grouping:', Object.keys(filesByItem).map(key => `${key}: ${filesByItem[parseInt(key)].length} files`));
    return filesByItem;
  }

  /**
   * Place a bid on an auction
   */
  async placeBid(
    userId: string,
    placeBidDto: PlaceBidDto,
    userToken?: string,
    bidContext?: { ipAddress?: string; userAgent?: string },
  ): Promise<AuctionBid> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get auction details
    const auction = await this.findById(placeBidDto.auction_id);

    // Adult-content sellers: bids are purchase actions — require verified 18+.
    if (
      (auction as any).seller_is_adult_content &&
      !(await isAdultViewer(this.serviceSupabase, userId))
    ) {
      throw new ForbiddenException({
        code: 'ADULT_CONTENT_RESTRICTED',
        message: 'This content is restricted to viewers 18 and older',
      });
    }

    const itemId = auction.auction_type === 'live'
      ? (placeBidDto.item_id || (auction as any).current_item_id)
      : null;

    // Validate auction status
    if (auction.status !== 'active') {
      throw new BadRequestException('Auction is not active');
    }

    // Check if user is the seller (can't bid on own auction)
    if (auction.seller_id === userId) {
      throw new BadRequestException('You cannot bid on your own auction');
    }

    // For live auctions, validate against the current active item
    let item: any = null;
    if (auction.auction_type === 'live') {
      if (!itemId) {
        throw new BadRequestException('No active item in this live auction');
      }

      item = await this.getAuctionItem(itemId);
      if (!item) {
        throw new BadRequestException('Current auction item not found');
      }
      if (item.auction_id !== placeBidDto.auction_id) {
        throw new BadRequestException('Item does not belong to this auction');
      }
      if (item.bidding_status !== 'active') {
        throw new BadRequestException(`Bidding for this item is currently ${item.bidding_status}`);
      }
    }

    // Validate bid amount against the item (live) or the auction (timed)
    const currentBase = auction.auction_type === 'live' ? item.current_bid : auction.current_bid;
    const currentIncrement = auction.auction_type === 'live' ? item.bid_increment : auction.bid_increment;
    const minimumBid = currentBase + currentIncrement;
    if (placeBidDto.amount < minimumBid) {
      throw new BadRequestException(`Minimum bid is ${minimumBid} Freti`);
    }

    // Validate wallet balance (the bidder must be able to cover their maximum commitment)
    const walletCheckAmount = placeBidDto.max_bid_amount ?? placeBidDto.amount;
    const { data: wallet, error: walletError } = await this.serviceSupabase
      .from('wallets')
      .select('available_balance')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      throw new BadRequestException('Insufficient wallet balance to place this bid. Please add funds to your wallet.');
    }

    const availableBalance = parseFloat(wallet.available_balance ?? 0);

    // Outstanding commitments: bids the user is currently winning that have
    // not settled into winner-time holds yet. Without this, the same balance
    // could be pledged as the leading bid on every item in a live auction.
    const NULL_UUID = '00000000-0000-0000-0000-000000000000';
    const { data: liveCommitments } = await this.serviceSupabase
      .from('auction_bids')
      .select('amount, max_bid_amount, item_id, auction_items!inner(bidding_status)')
      .eq('bidder_id', userId)
      .eq('is_winning', true)
      .eq('is_valid', true)
      .not('item_id', 'is', null)
      .in('auction_items.bidding_status', ['active', 'countdown', 'ended'])
      .neq('item_id', itemId ?? NULL_UUID);

    const { data: timedCommitments } = await this.serviceSupabase
      .from('auction_bids')
      .select('amount, max_bid_amount, auction_id, auctions!inner(status)')
      .eq('bidder_id', userId)
      .eq('is_winning', true)
      .eq('is_valid', true)
      .is('item_id', null)
      .eq('auctions.status', 'active')
      .neq('auction_id', placeBidDto.auction_id);

    const outstanding = [...(liveCommitments || []), ...(timedCommitments || [])]
      .reduce((sum, b: any) => sum + Math.max(parseFloat(b.amount) || 0, parseFloat(b.max_bid_amount) || 0), 0);

    const effectiveAvailable = availableBalance - outstanding;
    if (effectiveAvailable < walletCheckAmount) {
      throw new BadRequestException(
        `Insufficient wallet balance to place this bid. Available: ₣${availableBalance.toFixed(2)}` +
        (outstanding > 0 ? ` (₣${outstanding.toFixed(2)} committed to your active winning bids)` : '') +
        `, required: ₣${walletCheckAmount.toFixed(2)}`
      );
    }

    // For proxy bids, validate max_bid_amount
    if (placeBidDto.bid_type === 'proxy' && placeBidDto.max_bid_amount) {
      if (placeBidDto.max_bid_amount < placeBidDto.amount) {
        throw new BadRequestException('Maximum bid amount must be greater than or equal to current bid');
      }
    }

    // Generate bidder_display_id - check if this bidder has already bid on this auction
    let bidderDisplayId: string;
    const existingBid = await client
      .from('auction_bids')
      .select('bidder_display_id')
      .eq('auction_id', placeBidDto.auction_id)
      .eq('bidder_id', userId)
      .eq('is_valid', true)
      .limit(1)
      .maybeSingle();

    if (existingBid.data && existingBid.data.bidder_display_id) {
      // Use existing display ID if this bidder has bid before
      bidderDisplayId = existingBid.data.bidder_display_id;
    } else {
      // Count unique bidders for this auction to generate new display ID
      // Use serviceSupabase to bypass RLS - need to see ALL bids, not just user's own
      const { data: allBids } = await this.serviceSupabase
        .from('auction_bids')
        .select('bidder_id')
        .eq('auction_id', placeBidDto.auction_id)
        .eq('is_valid', true);

      // Count unique bidder_ids
      const uniqueBidderIds = new Set((allBids || []).map(bid => bid.bidder_id));
      const uniqueBidderCount = uniqueBidderIds.size;
      const bidderNumber = uniqueBidderCount + 1;
      bidderDisplayId = `Bidder #${bidderNumber}`;
    }

    // Capture the current winning bidder before this bid replaces them
    // (the bid trigger flips is_winning per auction/item scope)
    const previousWinnerId = await this.getCurrentWinnerId(placeBidDto.auction_id, itemId);

    // Place the bid
    const bidData = {
      auction_id: placeBidDto.auction_id,
      bidder_id: userId,
      item_id: itemId,
      amount: placeBidDto.amount,
      bid_type: placeBidDto.bid_type || 'manual',
      max_bid_amount: placeBidDto.max_bid_amount,
      is_proxy_bid: placeBidDto.bid_type === 'proxy',
      bidder_display_id: bidderDisplayId,
      // Server-side request metadata for fraud detection — never client-supplied
      ip_address: bidContext?.ipAddress ?? null,
      user_agent: bidContext?.userAgent ?? null,
    };

    const { data, error } = await client
      .from('auction_bids')
      .insert(bidData)
      .select()
      .single();

    if (error) {
      throw new BadRequestException(`Failed to place bid: ${error.message}`);
    }

    // Broadcast WebSocket event for real-time updates
    // Query auction stats directly from auctions table (faster, more reliable, ensures fresh data)
    try {
      const { data: auctionStats, error: statsError } = await this.serviceSupabase
        .from('auctions')
        .select('current_bid, total_bids, unique_bidders, view_count, watch_count')
        .eq('id', placeBidDto.auction_id)
        .single();

      if (!statsError && auctionStats) {
      await this.auctionGateway.broadcastBidUpdate(placeBidDto.auction_id, {
        amount: data.amount,
        bidder_display_id: data.bidder_display_id,
        item_id: data.item_id,
          current_bid: auctionStats.current_bid,
          total_bids: auctionStats.total_bids,
          unique_bidders: auctionStats.unique_bidders,
          view_count: auctionStats.view_count,
          watch_count: auctionStats.watch_count,
        is_winning: true,
      });
      }
    } catch (error) {
      console.error(`[Auction ${placeBidDto.auction_id}] Error broadcasting bid update:`, error);
      // Don't throw - WebSocket broadcast failure shouldn't fail the bid
    }

    // Notify the bidder this bid just outbid (persistent + real-time)
    await this.notifyOutbidUser(
      placeBidDto.auction_id,
      previousWinnerId,
      userId,
      data.amount,
      itemId,
      auction.title,
      auction.auction_type,
    );

    // Notify the host a new bid landed on their lot
    await this.notifySellerOfBid(
      placeBidDto.auction_id,
      auction.seller_id,
      auction.title,
      data.amount,
      data.bidder_display_id,
      itemId,
      auction.auction_type,
    );

    // Process proxy bids for ANY bid type (both manual and proxy bids should trigger proxy processing)
    // This allows proxy bidders to counter-bid when other proxy bids are placed
    // Only skip if we're already processing proxy bids for this auction (prevents recursion loops)
    const proxyKey = `${placeBidDto.auction_id}:${itemId || 'none'}`;
    if (!this.processingProxyBids.has(proxyKey)) {
      // Process proxy bids asynchronously (don't block the response)
      this.processProxyBids(placeBidDto.auction_id, data.amount, data.bidder_id, data.id, itemId).catch(err => {
        console.error(`[Auction ${placeBidDto.auction_id}] Error processing proxy bids:`, err);
        // Don't throw - proxy bid processing failure shouldn't fail the original bid
      });
    }

    return data;
  }

  /**
   * Process proxy bids after any bid is placed (manual or proxy)
   * Automatically places counter-bids for proxy bidders who can outbid
   * Uses service role client to bypass RLS for automatic system actions
   */
  private async processProxyBids(
    auctionId: string,
    newBidAmount: number,
    newBidderId: string,
    newBidId: string,
    itemId: string | null = null,
    isRecursive: boolean = false,
  ): Promise<void> {
    const proxyKey = `${auctionId}:${itemId || 'none'}`;

    if (!isRecursive && this.processingProxyBids.has(proxyKey)) {
      return;
    }

    if (!isRecursive) {
      this.processingProxyBids.add(proxyKey);
    }

    try {
      const auction = await this.findById(auctionId);
      if (!auction || auction.status !== 'active') {
        return;
      }

      let bidIncrement = auction.bid_increment;
      let currentBid = auction.current_bid;
      let startingPrice = auction.starting_price;

      if (itemId) {
        const item = await this.getAuctionItem(itemId);
        if (item) {
          bidIncrement = item.bid_increment;
          currentBid = item.current_bid;
          startingPrice = item.starting_price;
        }
      }

      const minimumCounterBid = newBidAmount + bidIncrement;

      const winningBidQuery = this.serviceSupabase
        .from('auction_bids')
        .select('bidder_id, amount')
        .eq('auction_id', auctionId)
        .eq('is_winning', true)
        .eq('is_valid', true);
      if (itemId) winningBidQuery.eq('item_id', itemId);
      else winningBidQuery.is('item_id', null);
      const { data: currentWinningBid } = await winningBidQuery.maybeSingle();
      const currentWinningBidderId = currentWinningBid?.bidder_id;

      let proxyBidsQuery = this.serviceSupabase
        .from('auction_bids')
        .select('id, bidder_id, max_bid_amount, bidder_display_id')
        .eq('auction_id', auctionId)
        .eq('is_proxy_bid', true)
        .eq('is_valid', true)
        .is('proxy_bid_parent_id', null)
        .neq('bidder_id', newBidderId)
        .gte('max_bid_amount', minimumCounterBid);

      if (itemId) proxyBidsQuery = proxyBidsQuery.eq('item_id', itemId);
      else proxyBidsQuery = proxyBidsQuery.is('item_id', null);

      if (currentWinningBidderId) {
        proxyBidsQuery = proxyBidsQuery.neq('bidder_id', currentWinningBidderId);
      }

      const { data: proxyBids, error: findError } = await proxyBidsQuery
        .order('max_bid_amount', { ascending: false })
        .limit(1);

      if (findError || !proxyBids || proxyBids.length === 0) {
        return;
      }

      const proxyBid = proxyBids[0];
      const counterBidAmount = Math.min(minimumCounterBid, proxyBid.max_bid_amount);

      if (counterBidAmount <= newBidAmount) {
        return;
      }

      const currentMinBid = currentBid + bidIncrement;
      const finalCounterBid = Math.min(
        Math.max(counterBidAmount, currentMinBid),
        proxyBid.max_bid_amount,
      );

      if (finalCounterBid <= currentBid || finalCounterBid < startingPrice) {
        return;
      }

      await this.placeBidInternal(
        proxyBid.bidder_id,
        auctionId,
        itemId,
        finalCounterBid,
        proxyBid.max_bid_amount,
        proxyBid.bidder_display_id,
        proxyBid.id,
      );

      let counterQuery = this.serviceSupabase
        .from('auction_bids')
        .select('id, amount, bidder_id')
        .eq('auction_id', auctionId)
        .eq('bidder_id', proxyBid.bidder_id)
        .eq('proxy_bid_parent_id', proxyBid.id);
      if (itemId) counterQuery = counterQuery.eq('item_id', itemId);
      else counterQuery = counterQuery.is('item_id', null);

      const { data: counterBid } = await counterQuery
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (counterBid && counterBid.amount > newBidAmount) {
        await this.processProxyBids(
          auctionId,
          counterBid.amount,
          counterBid.bidder_id,
          counterBid.id,
          itemId,
          true,
        );
      }
    } catch (error) {
      console.error(`[Auction ${auctionId}] Error in processProxyBids:`, error);
    } finally {
      if (!isRecursive) {
        this.processingProxyBids.delete(proxyKey);
      }
    }
  }

  /**
   * Internal method to place a bid (used for proxy counter-bids)
   * Bypasses some validations since this is a system-generated bid
   */
  private async placeBidInternal(
    bidderId: string,
    auctionId: string,
    itemId: string | null,
    amount: number,
    maxBidAmount: number,
    bidderDisplayId: string,
    proxyBidParentId: string,
  ): Promise<AuctionBid> {
    // Capture the current winning bidder before this counter-bid replaces them
    const previousWinnerId = await this.getCurrentWinnerId(auctionId, itemId);

    const bidData: any = {
      auction_id: auctionId,
      bidder_id: bidderId,
      item_id: itemId,
      amount: amount,
      bid_type: 'proxy',
      max_bid_amount: maxBidAmount,
      is_proxy_bid: true,
      bidder_display_id: bidderDisplayId,
      proxy_bid_parent_id: proxyBidParentId,
    };

    const { data, error } = await this.serviceSupabase
      .from('auction_bids')
      .insert(bidData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to place proxy counter-bid: ${error.message}`);
    }

    try {
      const { data: auctionStats, error: statsError } = await this.serviceSupabase
        .from('auctions')
        .select('current_bid, total_bids, unique_bidders, view_count, watch_count')
        .eq('id', auctionId)
        .single();

      if (!statsError && auctionStats) {
        await this.auctionGateway.broadcastBidUpdate(auctionId, {
          amount: amount,
          bidder_display_id: bidderDisplayId,
          current_bid: auctionStats.current_bid,
          total_bids: auctionStats.total_bids,
          unique_bidders: auctionStats.unique_bidders,
          view_count: auctionStats.view_count,
          watch_count: auctionStats.watch_count,
          is_winning: true,
          is_proxy_bid: true,
          item_id: itemId,
        });
      }
    } catch (error) {
      console.error(`[Auction ${auctionId}] Error broadcasting proxy bid update:`, error);
    }

    await this.notifyOutbidUser(auctionId, previousWinnerId, bidderId, amount, itemId);
    await this.notifySellerOfBid(auctionId, undefined, undefined, amount, bidderDisplayId, itemId);

    return data;
  }

  /**
   * The bidder currently holding the winning bid for an auction (timed) or
   * an item (live). is_winning is maintained by the bid trigger in the same
   * auction/item scope.
   */
  private async getCurrentWinnerId(auctionId: string, itemId: string | null): Promise<string | null> {
    try {
      let query = this.serviceSupabase
        .from('auction_bids')
        .select('bidder_id')
        .eq('auction_id', auctionId)
        .eq('is_valid', true)
        .eq('is_winning', true);
      query = itemId ? query.eq('item_id', itemId) : query.is('item_id', null);
      const { data } = await query.limit(1).maybeSingle();
      return data?.bidder_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Notify the auction host that a new bid landed on their lot — persistent
   * notification row plus a real-time socket ping if they are connected.
   * Fetches seller_id/title when not supplied (proxy counter-bid path).
   */
  private async notifySellerOfBid(
    auctionId: string,
    sellerId: string | undefined,
    auctionTitle: string | undefined,
    amount: number,
    bidderDisplayId: string,
    itemId: string | null,
    auctionType?: string,
  ): Promise<void> {
    try {
      let ownerId = sellerId;
      let title = auctionTitle;
      let type = auctionType;
      if (!ownerId || !title || !type) {
        const { data: a } = await this.serviceSupabase
          .from('auctions')
          .select('seller_id, title, auction_type')
          .eq('id', auctionId)
          .single();
        ownerId = ownerId || a?.seller_id;
        title = title || a?.title;
        type = type || a?.auction_type;
      }
      if (!ownerId) return;

      const label = title || 'your auction';
      await this.supabase.from('notifications').insert({
        user_id: ownerId,
        type: 'new_bid',
        title: '🔨 New Bid on Your Auction',
        message: `${bidderDisplayId} bid ₣${amount.toFixed(2)} on "${label}".`,
        data: { auction_id: auctionId, auction_type: type, item_id: itemId, amount },
        created_at: new Date().toISOString(),
      });

      await this.auctionGateway.sendUserNotification(ownerId, {
        type: 'new_bid',
        title: 'New bid on your auction',
        message: `${bidderDisplayId} bid ₣${amount.toFixed(2)} on "${label}"`,
        auction_id: auctionId,
        item_id: itemId,
        amount,
      });

      await this.pushNotificationService.sendPushNotification(ownerId, {
        title: 'New Bid on Your Auction',
        body: `${bidderDisplayId} bid ₣${amount.toFixed(2)} on "${label}".`,
        data: { type: 'new_bid', auction_id: auctionId, auction_type: type, item_id: itemId },
      });
    } catch (error) {
      console.error(`Failed to send seller bid notification for auction ${auctionId}:`, error);
    }
  }

  /**
   * Notify a bidder that someone just outbid them — persistent notification
   * row plus a real-time socket ping if they are connected.
   */
  private async notifyOutbidUser(
    auctionId: string,
    previousWinnerId: string | null,
    newBidderId: string,
    amount: number,
    itemId: string | null,
    auctionTitle?: string,
    auctionType?: string,
  ): Promise<void> {
    if (!previousWinnerId || previousWinnerId === newBidderId) return;

    try {
      let title = auctionTitle;
      let type = auctionType;
      if (!title || !type) {
        const { data: a } = await this.serviceSupabase
          .from('auctions')
          .select('title, auction_type')
          .eq('id', auctionId)
          .single();
        title = title || a?.title || 'an auction';
        type = type || a?.auction_type;
      }

      await this.supabase.from('notifications').insert({
        user_id: previousWinnerId,
        type: 'outbid',
        title: '⚠️ You\'ve Been Outbid',
        message: `Someone outbid you on "${title}" — the bid is now ₣${amount.toFixed(2)}.`,
        data: { auction_id: auctionId, auction_type: type, item_id: itemId, amount },
        created_at: new Date().toISOString(),
      });

      await this.auctionGateway.sendUserNotification(previousWinnerId, {
        type: 'outbid',
        title: "You've been outbid",
        message: `The bid on "${title}" is now ₣${amount.toFixed(2)}`,
        auction_id: auctionId,
        item_id: itemId,
        amount,
      });

      await this.pushNotificationService.sendPushNotification(previousWinnerId, {
        title: "You've Been Outbid",
        body: `Someone outbid you on "${title}" — the bid is now ₣${amount.toFixed(2)}.`,
        data: { type: 'outbid', auction_id: auctionId, auction_type: type, item_id: itemId },
      });

      // Email is throttled to at most one per user per auction per 6h —
      // hot bidding wars would otherwise flood inboxes.
      await this.emailNotificationService.sendUserEmail(previousWinnerId, {
        subject: `You've been outbid on "${title}"`,
        category: 'auction',
        reminder: {
          type: 'outbid',
          entityType: 'auction',
          entityId: itemId || auctionId,
        },
        resendAfterHours: 6,
        buildHtml: ({ name }) => outbidEmail({
          name,
          title: title || 'an auction',
          amount,
          appUrl: this.configService.get('FRONTEND_URL') || 'https://fretiko.com',
        }),
      });
    } catch (error) {
      console.error(`Failed to send outbid notification for auction ${auctionId}:`, error);
    }
  }

  /**
   * Get bid history for an auction (public, anonymized)
   */
  async getBidHistory(auctionId: string, limit = 50): Promise<PublicBidHistoryItem[]> {
    const { data, error } = await this.supabase
      .from('auction_bids')
      .select('id, amount, bidder_display_id, is_winning, created_at, bid_type')
      .eq('auction_id', auctionId)
      .eq('is_valid', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Database error: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Add/remove auction from watchlist
   */
  async toggleWatchlist(userId: string, watchlistDto: WatchlistDto, userToken?: string): Promise<{ watched: boolean }> {
    // Use user token if provided (for RLS compliance), otherwise fall back to service client
    // The RLS policy requires auth.uid() = user_id, so we need the user's JWT token
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.serviceSupabase;
    
    // Check if watchlist entry exists using maybeSingle (returns null if not found)
    const { data: existing, error: findError } = await client
      .from('auction_watchlist')
      .select('id')
      .eq('user_id', userId)
      .eq('auction_id', watchlistDto.auction_id)
      .maybeSingle();

    if (findError) {
      const errorMessage = findError.message || findError.details || 'Unknown database error';
      throw new BadRequestException(`Failed to check watchlist: ${errorMessage}`);
    }

    if (existing) {
      // Remove from watchlist
      const { error: deleteError } = await client
        .from('auction_watchlist')
        .delete()
        .eq('id', existing.id);

      if (deleteError) {
        const errorMessage = deleteError.message || deleteError.details || 'Unknown database error';
        throw new BadRequestException(`Failed to remove from watchlist: ${errorMessage}`);
      }

      // Broadcast updated watch count
      try {
        const { data: updatedStats } = await this.serviceSupabase
          .from('auctions')
          .select('watch_count')
          .eq('id', watchlistDto.auction_id)
          .single();

        if (updatedStats) {
          await this.auctionGateway.broadcastWatchCountUpdate(
            watchlistDto.auction_id,
            updatedStats.watch_count
          );
        }
      } catch (error) {
        console.error('Error broadcasting watch count update:', error);
        // Don't throw - watch count broadcast failure shouldn't fail the operation
      }

      return { watched: false };
    } else {
      // Add to watchlist
      // Database foreign key constraint will ensure auction exists
      const { error: insertError } = await client
        .from('auction_watchlist')
        .insert({
          user_id: userId,
          auction_id: watchlistDto.auction_id,
          notification_enabled: watchlistDto.notification_enabled ?? true,
        });

      if (insertError) {
        // Check if error is due to invalid auction_id (foreign key violation)
        if (insertError.code === '23503' || insertError.message?.includes('foreign key')) {
          throw new NotFoundException('Auction not found');
        }
        const errorMessage = insertError.message || insertError.details || 'Unknown database error';
        throw new BadRequestException(`Failed to add to watchlist: ${errorMessage}`);
      }

      // Broadcast updated watch count
      try {
        const { data: updatedStats } = await this.serviceSupabase
          .from('auctions')
          .select('watch_count')
          .eq('id', watchlistDto.auction_id)
          .single();

        if (updatedStats) {
          await this.auctionGateway.broadcastWatchCountUpdate(
            watchlistDto.auction_id,
            updatedStats.watch_count
          );
        }
      } catch (error) {
        console.error('Error broadcasting watch count update:', error);
        // Don't throw - watch count broadcast failure shouldn't fail the operation
      }

      return { watched: true };
    }
  }

  /**
   * Get user's watchlist
   */
  async getUserWatchlist(userId: string, limit = 50, userToken?: string): Promise<AuctionWithDetails[]> {
    // Use user token if provided (for RLS compliance), otherwise fall back to service client
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.serviceSupabase;
    
    // First, get the auction IDs from the watchlist
    const { data: watchlistData, error: watchlistError } = await client
      .from('auction_watchlist')
      .select('auction_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (watchlistError) {
      throw new Error(`Database error: ${watchlistError.message}`);
    }

    if (!watchlistData || watchlistData.length === 0) {
      return [];
    }

    // Extract auction IDs
    const auctionIds = watchlistData.map(item => item.auction_id);

    // Query auction_summary view with those IDs
    const { data: auctions, error: auctionsError } = await this.supabase
      .from('auction_summary')
      .select('*')
      .in('id', auctionIds);

    if (auctionsError) {
      throw new Error(`Database error: ${auctionsError.message}`);
    }

    if (!auctions || auctions.length === 0) {
      return [];
    }

    // Preserve the order from watchlist (most recently added first)
    const auctionMap = new Map(auctions.map(auction => [auction.id, auction]));
    const orderedAuctions = auctionIds
      .map(id => auctionMap.get(id))
      .filter(Boolean) as AuctionWithDetails[];

    // Add user-specific data (watchlist status, bid status, etc.)
    const auctionsWithUserData = await this.addUserSpecificData(orderedAuctions, userId);

    return auctionsWithUserData;
  }

  /**
   * Complete auction sale and process payment
   */
  /**
   * Get user's bid history across all auctions
   */
  async getUserBidHistory(userId: string): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('auction_bids')
      .select(`
        *,
        auctions:auction_id (
          id,
          title,
          thumbnail_url,
          current_bid,
          status,
          time_status,
          end_time
        )
      `)
      .eq('bidder_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return data || [];
  }

  /**
   * Get unique auctions that a user has bid on
   * Returns distinct auctions (not individual bids) with full details
   */
  async getMyParticipatedAuctions(userId: string, filters?: AuctionFilterDto): Promise<{ auctions: AuctionWithDetails[]; total: number }> {
    // First, get distinct auction IDs from auction_bids where user has bid
    const { data: userBids, error: bidsError } = await this.serviceSupabase
      .from('auction_bids')
      .select('auction_id')
      .eq('bidder_id', userId)
      .eq('is_valid', true);

    if (bidsError) {
      throw new Error(`Database error: ${bidsError.message}`);
    }

    if (!userBids || userBids.length === 0) {
      return { auctions: [], total: 0 };
    }

    // Get unique auction IDs
    const auctionIds = [...new Set(userBids.map(bid => bid.auction_id))];

    // Now fetch auctions from auction_summary
    let query = this.supabase
      .from('auction_summary')
      .select('*')
      .in('id', auctionIds);

    // Apply filters if provided
    if (filters) {
      if (filters.status) {
        query = query.eq('status', filters.status);
      }

      if (filters.auction_type) {
        query = query.eq('auction_type', filters.auction_type);
      }

      if (filters.category_id) {
        query = query.eq('category_id', filters.category_id);
      }

      if (filters.search) {
        query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
      }

      // Apply sorting
      switch (filters.sort) {
        case 'price_asc':
          query = query.order('current_bid', { ascending: true });
          break;
        case 'price_desc':
          query = query.order('current_bid', { ascending: false });
          break;
        case 'time_asc':
          query = query.order('end_time', { ascending: true });
          break;
        case 'time_desc':
          query = query.order('end_time', { ascending: false });
          break;
        case 'bids_desc':
          query = query.order('total_bids', { ascending: false });
          break;
        case 'created_desc':
        default:
          query = query.order('created_at', { ascending: false });
          break;
      }
    } else {
      // Default sorting: most recent first
      query = query.order('created_at', { ascending: false });
    }

    // Get total count
    const { count } = await this.supabase
      .from('auction_summary')
      .select('*', { count: 'exact', head: true })
      .in('id', auctionIds);

    // Apply pagination
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data: auctions, error: auctionsError } = await query;

    if (auctionsError) {
      throw new Error(`Database error: ${auctionsError.message}`);
    }

    // Add user-specific data (watchlist status, etc.)
    let auctionsWithUserData = auctions || [];
    if (auctionsWithUserData.length > 0) {
      auctionsWithUserData = await this.addUserSpecificData(auctionsWithUserData, userId);
    }

    return {
      auctions: auctionsWithUserData,
      total: count || 0,
    };
  }

  /**
   * Update proxy bid maximum amount
   */
  async updateProxyBid(userId: string, auctionId: string, maxBidAmount: number): Promise<any> {
    // Load auction and current item (for live) first so the query is scoped correctly
    const auction = await this.findById(auctionId);
    const itemId = auction.auction_type === 'live' ? (auction as any).current_item_id : null;

    let item: any = null;
    let currentBase = auction.current_bid;
    let currentIncrement = auction.bid_increment;
    if (auction.auction_type === 'live') {
      if (!itemId) {
        throw new BadRequestException('No active item in this live auction');
      }
      item = await this.getAuctionItem(itemId);
      if (!item) {
        throw new BadRequestException('Current auction item not found');
      }
      currentBase = item.current_bid;
      currentIncrement = item.bid_increment;
    }

    // Find user's active proxy bid for the scoped item/auction
    let bidsQuery = this.supabase
      .from('auction_bids')
      .select('*')
      .eq('auction_id', auctionId)
      .eq('bidder_id', userId)
      .eq('is_proxy_bid', true)
      .eq('is_valid', true);

    if (itemId) {
      bidsQuery = bidsQuery.eq('item_id', itemId);
    } else {
      bidsQuery = bidsQuery.is('item_id', null);
    }

    const { data: existingBids, error: findError } = await bidsQuery
      .order('max_bid_amount', { ascending: false })
      .limit(1);

    if (findError) throw findError;

    if (!existingBids || existingBids.length === 0) {
      throw new BadRequestException('No active proxy bid found for this auction. Place a proxy bid first.');
    }

    // Validate the new max_bid_amount is higher than current bid
    if (maxBidAmount < currentBase + currentIncrement) {
      throw new BadRequestException(`Maximum bid amount must be at least ${currentBase + currentIncrement} Freti (current bid + increment)`);
    }

    // Update the proxy bid's max_bid_amount scoped the same way
    let updateQuery = this.supabase
      .from('auction_bids')
      .update({ max_bid_amount: maxBidAmount })
      .eq('auction_id', auctionId)
      .eq('bidder_id', userId)
      .eq('is_proxy_bid', true)
      .eq('is_valid', true);

    if (itemId) {
      updateQuery = updateQuery.eq('item_id', itemId);
    } else {
      updateQuery = updateQuery.is('item_id', null);
    }

    const { data, error } = await updateQuery
      .select()
      .order('created_at', { ascending: false });

    if (error) throw error;

    return { message: 'Proxy bid updated successfully', bid: data?.[0] };
  }

  /**
   * Update auction details (before it starts or while scheduled)
   */
  async updateAuction(auctionId: string, sellerId: string, updateData: any): Promise<any> {
    // Get current auction
    const auction = await this.findById(auctionId);

    if (auction.seller_id !== sellerId) {
      throw new Error('Unauthorized: You can only update your own auctions');
    }

    if (auction.status === 'active' || auction.status === 'sold') {
      throw new Error('Cannot update active or sold auctions');
    }

    // Only allow certain fields to be updated
    const allowedFields = ['title', 'description', 'reserve_price', 'start_time', 'end_time', 'images', 'thumbnail_url'];
    const filteredData: any = {};
    
    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        filteredData[field] = updateData[field];
      }
    }

    filteredData.updated_at = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('auctions')
      .update(filteredData)
      .eq('id', auctionId)
      .select()
      .single();

    if (error) throw error;
    return { message: 'Auction updated successfully', auction: data };
  }

  /**
   * Cancel auction (only if not started or no bids placed)
   */
  async cancelAuction(auctionId: string, sellerId: string): Promise<any> {
    const auction = await this.findById(auctionId);

    if (auction.seller_id !== sellerId) {
      throw new Error('Unauthorized: You can only cancel your own auctions');
    }

    if (auction.status === 'active') {
      throw new Error('Cannot cancel active auctions. Contact support if needed.');
    }

    if (auction.status === 'sold') {
      throw new Error('Cannot cancel sold auctions');
    }

    // Check for bids using serviceSupabase to bypass RLS
    const { count } = await this.serviceSupabase
      .from('auction_bids')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', auctionId);

    if (count && count > 0) {
      throw new Error('Cannot cancel auction with existing bids. Contact support.');
    }

    // Mark as cancelled using serviceSupabase to bypass RLS
    const { error } = await this.serviceSupabase
      .from('auctions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', auctionId);

    if (error) throw error;

    // Broadcast status change via WebSocket
    try {
      await this.auctionGateway.broadcastAuctionStatusChange(auctionId, 'cancelled', {
        message: 'Auction has been cancelled',
        seller_id: auction.seller_id,
      });
    } catch (error) {
      console.error(`[Auction ${auctionId}] Error broadcasting cancellation status:`, error);
      // Don't throw - WebSocket broadcast failure shouldn't fail the cancellation
    }

    return { message: 'Auction cancelled successfully' };
  }



  /**
   * Emergency extend auction (Admin only - for critical system failures)
   * Prominently logs to audit trail and notifies all bidders
   */
  async emergencyExtendAuction(
    adminId: string,
    auctionId: string,
    extensionMinutes: number,
    reason: string,
  ): Promise<{ success: boolean; message: string; new_end_time: string }> {
    // Get auction details
    const { data: auction, error: auctionError } = await this.supabase
      .from('auctions')
      .select('*, end_time, status, title')
      .eq('id', auctionId)
      .single();

    if (auctionError || !auction) {
      throw new NotFoundException('Auction not found');
    }

    if (auction.status !== 'active') {
      throw new BadRequestException('Can only extend active auctions');
    }

    // Validate extension (maximum 60 minutes)
    if (extensionMinutes < 1 || extensionMinutes > 60) {
      throw new BadRequestException('Extension must be between 1 and 60 minutes');
    }

    // Calculate new end time
    const oldEndTime = new Date(auction.end_time);
    const newEndTime = new Date(oldEndTime.getTime() + extensionMinutes * 60 * 1000);

    // Update auction end time
    const { error: updateError } = await this.supabase
      .from('auctions')
      .update({ 
        end_time: newEndTime.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', auctionId);

    if (updateError) {
      throw new Error(`Failed to extend auction: ${updateError.message}`);
    }

    // Get all bidders to notify
    const { data: bids } = await this.supabase
      .from('auction_bids')
      .select('bidder_id')
      .eq('auction_id', auctionId)
      .eq('is_valid', true);

    const uniqueBidders = [...new Set<string>((bids || []).map((b: { bidder_id: string }) => b.bidder_id))];

    // Send notifications to all bidders
    if (uniqueBidders.length > 0) {
      const notifications = uniqueBidders.map(bidderId => ({
        user_id: bidderId,
        type: 'auction_extended',
        title: '⏰ Auction Extended',
        message: `Auction "${auction.title}" has been extended by ${extensionMinutes} minutes. Reason: ${reason}`,
        data: {
          auction_id: auctionId,
          auction_type: auction.auction_type,
          extension_minutes: extensionMinutes,
          new_end_time: newEndTime.toISOString(),
          reason,
        },
      }));

      await this.supabase.from('notifications').insert(notifications);

      await Promise.all(
        uniqueBidders.map(bidderId =>
          this.pushNotificationService.sendPushNotification(bidderId, {
            title: 'Auction Extended',
            body: `"${auction.title}" has been extended by ${extensionMinutes} minutes.`,
            data: { type: 'auction_extended', auction_id: auctionId, auction_type: auction.auction_type },
          }),
        ),
      );
    }

    console.log(
      `🚨 EMERGENCY AUCTION EXTENSION 🚨\n` +
      `Auction: ${auction.title} (${auctionId})\n` +
      `Admin: ${adminId}\n` +
      `Extension: ${extensionMinutes} minutes\n` +
      `Old End: ${oldEndTime.toISOString()}\n` +
      `New End: ${newEndTime.toISOString()}\n` +
      `Reason: ${reason}\n` +
      `Bidders Notified: ${uniqueBidders.length}`,
    );

    return {
      success: true,
      message: `Auction extended by ${extensionMinutes} minutes`,
      new_end_time: newEndTime.toISOString(),
    };
  }

  /**
   * Private helper: Add user-specific data to auctions
   */
  private async addUserSpecificData(auctions: any[], userId: string): Promise<AuctionWithDetails[]> {
    const auctionIds = auctions.map(a => a.id);

    // Check which auctions user is watching
    // Use serviceSupabase to bypass RLS since we're already filtering by userId (safe read operation)
    const { data: watchedAuctions } = await this.serviceSupabase
      .from('auction_watchlist')
      .select('auction_id')
      .eq('user_id', userId)
      .in('auction_id', auctionIds);

    const watchedIds = new Set((watchedAuctions || []).map(w => w.auction_id));

    // Check which auctions user has bid on
    // Use serviceSupabase for consistency (safe read operation, already filtering by userId)
    const { data: userBids } = await this.serviceSupabase
      .from('auction_bids')
      .select('auction_id')
      .eq('bidder_id', userId)
      .in('auction_id', auctionIds);

    const bidIds = new Set((userBids || []).map(b => b.auction_id));

    return auctions.map(auction => ({
      ...auction,
      is_watched_by_user: watchedIds.has(auction.id),
      user_has_bid: bidIds.has(auction.id),
    }));
  }

  /**
   * Generate Agora RTC token for auction live streaming
   * Similar to liveSalesService.generateAgoraToken but for auctions
   */
  async generateAgoraToken(auctionId: string, sellerId: string, role: 'host' | 'audience'): Promise<{
    token: string;
    channel: string;
    uid: number;
    appId: string;
  }> {
    try {
      const appId = this.configService.get<string>('AGORA_APP_ID');
      const appCertificate = this.configService.get<string>('AGORA_APP_CERTIFICATE');

      if (!appId || !appCertificate) {
        throw new BadRequestException('Agora credentials not configured');
      }

      // Verify auction exists and is live type
      const { data: auction, error } = await this.serviceSupabase
        .from('auctions')
        .select('seller_id, auction_type, status')
        .eq('id', auctionId)
        .single();

      if (error || !auction) {
        throw new NotFoundException('Auction not found');
      }

      if (auction.auction_type !== 'live') {
        throw new BadRequestException('This auction is not a live auction');
      }

      if (role === 'host' && ['ended', 'sold', 'cancelled'].includes(auction.status)) {
        throw new BadRequestException('Cannot stream - auction has already ended');
      }

      if (auction.seller_id !== sellerId && role === 'host') {
        throw new ForbiddenException('Only auction owner can host the stream');
      }

      // Use auction ID as channel name
      const channelName = `auction_${auctionId}`;
      
      // Generate unique UID (use numeric part of seller ID hash)
      const uid = Math.abs(this.hashCode(sellerId || auctionId)) % 1000000;
      
      // Token expires in 24 hours
      const expirationTimeInSeconds = 86400;
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

      // Generate actual Agora token
      const { RtcTokenBuilder, RtcRole } = require('agora-token');
      const agoraRole = role === 'host' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
      
      const token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCertificate,
        channelName,
        uid,
        agoraRole,
        privilegeExpiredTs
      );

      return {
        token,
        channel: channelName,
        uid,
        appId,
      };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to generate streaming token');
    }
  }

  /**
   * Start broadcasting for a live auction
   * Updates stream_url to indicate broadcast has started
   */
  async startBroadcast(auctionId: string, sellerId: string): Promise<any> {
    try {
      // Verify auction exists and user is seller
      const auction = await this.findById(auctionId);
      
      if (auction.auction_type !== 'live') {
        throw new BadRequestException('This is not a live auction');
      }
      
      if (auction.seller_id !== sellerId) {
        throw new ForbiddenException('Only auction owner can start broadcast');
      }

      // Never resurrect an auction that has already ended
      if (['ended', 'sold', 'cancelled'].includes(auction.status)) {
        throw new BadRequestException('Cannot start broadcast - auction has already ended');
      }

      // Update auction with stream_url and set status to active (using Agora channel name as identifier)
      const streamUrl = `agora://auction_${auctionId}`;
      console.log(`🎬 Starting broadcast for auction ${auctionId}, setting status to 'active'`);
      const { data, error } = await this.serviceSupabase
        .from('auctions')
        .update({
          stream_url: streamUrl,
          status: 'active', // Set auction to active when broadcasting starts
          updated_at: new Date().toISOString(),
        })
        .eq('id', auctionId)
        .in('status', ['scheduled', 'active']) // Guard against a concurrent end
        .select();

      if (error) {
        throw new BadRequestException(`Failed to start broadcast: ${error.message}`);
      }

      if (!data || data.length === 0) {
        throw new BadRequestException('Cannot start broadcast - auction has already ended');
      }

      // Broadcast stream URL update to all viewers
      await this.auctionGateway.broadcastStreamUrlUpdate(auctionId, streamUrl);

      return { message: 'Broadcast started successfully', stream_url: streamUrl };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new BadRequestException('Failed to start broadcast');
    }
  }

  /**
   * Stop broadcasting for a live auction
   * Removes stream_url to indicate broadcast has ended
   */
  async stopBroadcast(auctionId: string, sellerId: string): Promise<any> {
    try {
      // Verify auction exists and user is seller
      const auction = await this.findById(auctionId);
      
      if (auction.seller_id !== sellerId) {
        throw new ForbiddenException('Only auction owner can stop broadcast');
      }

      // Remove stream_url
      const { data, error } = await this.serviceSupabase
        .from('auctions')
        .update({
          stream_url: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', auctionId)
        .select()
        .single();

      if (error) {
        throw new BadRequestException(`Failed to stop broadcast: ${error.message}`);
      }

      // Broadcast stream ended
      await this.auctionGateway.broadcastStreamUrlUpdate(auctionId, null);

      return { message: 'Broadcast stopped successfully' };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new BadRequestException('Failed to stop broadcast');
    }
  }

  /**
   * End a live auction.
   * Marks the auction as ended, clears the stream, closes any active/countdown item,
   * and broadcasts the end to all viewers.
   */
  async endLiveAuction(auctionId: string, sellerId: string): Promise<any> {
    try {
      // Verify auction exists and user is the seller
      const auction = await this.findById(auctionId);

      if (auction.seller_id !== sellerId) {
        throw new ForbiddenException('Only auction owner can end the live auction');
      }

      const client = this.serviceSupabase;
      const now = new Date().toISOString();

      // Snapshot items still in play so we can settle each one properly.
      // Includes 'ended' items: an item closed by endItemBidding whose
      // mark_item_sold_atomic call never landed still has a winner that must
      // get auction_sales/user_auction_wins rows to check out.
      const { data: pendingItems } = await client
        .from('auction_items')
        .select('id, title, winner_id, winning_bid, starting_price, reserve_price')
        .eq('auction_id', auctionId)
        .in('bidding_status', ['active', 'countdown', 'ended']);

      // Close any item currently being bid on
      const { error: itemError } = await client
        .from('auction_items')
        .update({
          bidding_status: 'ended',
          updated_at: now,
        })
        .eq('auction_id', auctionId)
        .in('bidding_status', ['active', 'countdown']);

      if (itemError) {
        console.error(`Error closing active items for auction ${auctionId}:`, itemError);
        throw new BadRequestException(`Failed to close active auction items: ${itemError.message}`);
      }

      // Settle each pending item: items with a valid winning bid become real
      // sales (auction_sales + user_auction_wins via the atomic RPC) so the
      // winner can still check out; items without a valid bid are 'passed'.
      for (const item of pendingItems || []) {
        const hasWinner = item.winner_id && item.winning_bid >= item.starting_price;
        const reserveMet = !item.reserve_price || (hasWinner && item.winning_bid >= item.reserve_price);

        if (hasWinner && reserveMet) {
          const { data: rpcResult, error: rpcError } = await client.rpc('mark_item_sold_atomic', {
            p_auction_id: auctionId,
            p_item_id: item.id,
            p_seller_id: sellerId,
          });

          if (rpcError || !rpcResult?.success) {
            // Leave the item 'ended' so a retry of endLiveAuction can still
            // settle it — do not clobber the winner by marking it passed.
            console.warn(
              `endLiveAuction: could not settle item ${item.id} — ${rpcError?.message || rpcResult?.error}`,
            );
            continue;
          }

          await this.notifyForfeitedBidders(rpcResult.forfeited, auctionId, item.id, item.title);

          // `outcome` is absent on the pre-228 RPC — anything that isn't an
          // explicit 'passed' with a winner settles as a normal sale.
          if (rpcResult.outcome !== 'passed' && rpcResult.winner_id) {
            await this.auctionGateway.broadcastItemEvent(auctionId, item.id, 'item_sold', {
              item_id: item.id,
              item_title: item.title || 'Auction Item',
              winner: {
                bidder_display_id: await this.getWinnerDisplayId(auctionId, item.id, rpcResult.winner_id),
                amount: rpcResult.winning_bid,
              },
              timestamp: now,
            });

            await this.notifyItemWinner(auctionId, item.id, item.title, rpcResult.winner_id, rpcResult.winning_bid);
          }
        } else {
          await client
            .from('auction_items')
            .update({
              bidding_status: 'passed',
              winner_id: null,
              winning_bid: null,
              current_bid: item.starting_price,
            })
            .eq('id', item.id)
            .eq('bidding_status', 'ended');
        }
      }

      // Mark the auction as ended and remove the stream URL
      const { data, error } = await client
        .from('auctions')
        .update({
          status: 'ended',
          end_time: now,
          stream_url: null,
          current_item_id: null,
          updated_at: now,
        })
        .eq('id', auctionId)
        .select()
        .single();

      if (error) {
        throw new BadRequestException(`Failed to end live auction: ${error.message}`);
      }

      // Notify all clients that the stream and auction have ended
      await this.auctionGateway.broadcastStreamUrlUpdate(auctionId, null);
      await this.auctionGateway.broadcastAuctionStatusChange(auctionId, 'ended', {
        timestamp: now,
        ended_by: 'host',
      });

      return { message: 'Live auction ended successfully', auction: data };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new BadRequestException('Failed to end live auction');
    }
  }

  /**
   * Pause or resume the live broadcast for an auction.
   * Emits a socket event so viewers can show a paused state.
   */
  async setBroadcastStatus(
    auctionId: string,
    sellerId: string,
    status: 'paused' | 'live',
  ): Promise<any> {
    try {
      if (status !== 'paused' && status !== 'live') {
        throw new BadRequestException('Invalid broadcast status');
      }

      const auction = await this.findById(auctionId);

      if (auction.seller_id !== sellerId) {
        throw new ForbiddenException('Only auction owner can pause or resume the broadcast');
      }

      if (auction.status !== 'active') {
        throw new BadRequestException('Broadcast status can only be changed while the auction is active');
      }

      await this.auctionGateway.broadcastBroadcastStatus(auctionId, status);

      return { message: `Broadcast ${status === 'paused' ? 'paused' : 'resumed'} successfully`, broadcast_status: status };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new BadRequestException('Failed to update broadcast status');
    }
  }

  /**
   * Helper method to generate hash code from string
   */
  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  // ==================== AUCTION ITEMS MANAGEMENT ====================

  /**
   * Get auction item by ID
   */
  async getAuctionItem(itemId: string): Promise<AuctionItem | null> {
    const { data, error } = await this.serviceSupabase
      .from('auction_items')
      .select('*')
      .eq('id', itemId)
      .single();

    if (error || !data) {
      return null;
    }

    return data as AuctionItem;
  }

  /**
   * Get current auction item
   */
  async getCurrentAuctionItem(auctionId: string): Promise<AuctionItem | null> {
    const auction = await this.findById(auctionId);
    if (!auction || !(auction as any).current_item_id) {
      return null;
    }

    return this.getAuctionItem((auction as any).current_item_id);
  }

  /**
   * Get next waiting item in auction
   */
  async getNextWaitingItem(auctionId: string): Promise<AuctionItem | null> {
    const { data, error } = await this.serviceSupabase
      .rpc('get_next_waiting_auction_item', { p_auction_id: auctionId });

    if (error || !data) {
      // Fallback to manual query
      const { data: items, error: itemsError } = await this.serviceSupabase
        .from('auction_items')
        .select('*')
        .eq('auction_id', auctionId)
        .eq('bidding_status', 'waiting')
        .order('order_in_auction', { ascending: true })
        .limit(1);

      if (itemsError || !items || items.length === 0) {
        return null;
      }

      return items[0] as AuctionItem;
    }

    if (!data) {
      return null;
    }

    return this.getAuctionItem(data);
  }

  /**
   * Get all auction items for an auction
   */
  async getAuctionItems(auctionId: string): Promise<AuctionItem[]> {
    const { data, error } = await this.serviceSupabase
      .from('auction_items')
      .select('*')
      .eq('auction_id', auctionId)
      .order('order_in_auction', { ascending: true });

    if (error) {
      throw new BadRequestException(`Failed to retrieve auction items: ${error.message}`);
    }

    return data as AuctionItem[];
  }

  /**
   * Create a new auction item
   */
  async createAuctionItem(
    auctionId: string,
    userId: string,
    createAuctionItemDto: CreateAuctionItemDto,
    userToken?: string,
    images?: Express.Multer.File[],
    videos?: Express.Multer.File[],
  ): Promise<AuctionItem> {
    // Use serviceSupabase for all operations - user tokens can't be used for Supabase Storage
    const client = this.serviceSupabase;

    // Verify auction exists and user owns it
    const auction = await this.findById(auctionId);

    if (!auction) {
      throw new BadRequestException('Auction not found');
    }

    if (auction.seller_id !== userId) {
      throw new ForbiddenException('Only the auction seller can add items');
    }

    // Verify auction is active or scheduled
    if (auction.status !== 'active' && auction.status !== 'scheduled') {
      throw new BadRequestException('Can only add items to active or scheduled auctions');
    }

    // Get max order_in_auction to assign next order
    const { data: existingItems, error: itemsError } = await this.serviceSupabase
      .from('auction_items')
      .select('order_in_auction')
      .eq('auction_id', auctionId)
      .order('order_in_auction', { ascending: false })
      .limit(1);

    const nextOrder = existingItems && existingItems.length > 0
      ? (existingItems[0].order_in_auction || 0) + 1
      : 1;

    // Upload images to Supabase Storage if provided
    const imageUrls: string[] = [];
    if (images && images.length > 0) {
      console.log(`📤 Uploading ${images.length} images for auction item...`);

      for (const image of images) {
        const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.${image.originalname.split('.').pop()}`;

        const { data: uploadData, error: uploadError } = await client.storage
          .from('media')
          .upload(fileName, image.buffer, {
            contentType: image.mimetype,
            cacheControl: '3600',
          });

        if (uploadError) {
          console.error('❌ Image upload failed:', uploadError);
          throw new BadRequestException(`Failed to upload image: ${uploadError.message}`);
        }

        // Get public URL
        const { data: publicUrlData } = client.storage
          .from('media')
          .getPublicUrl(fileName);

        imageUrls.push(publicUrlData.publicUrl);
        console.log(`✅ Image uploaded: ${publicUrlData.publicUrl}`);
      }
    }

    // Upload video to Supabase Storage if provided
    console.log('🎥 Video upload check - videos array:', videos);
    console.log('🎥 Video upload check - videos.length:', videos?.length);
    console.log('🎥 Video upload check - videos[0]:', videos?.[0]);
    
    let videoUrl: string | undefined;
    if (videos && videos.length > 0) {
      const video = videos[0]; // Take first video
      console.log(`🎥 Uploading video for auction item...`);
      console.log(`🎥 Video details:`, {
        originalname: video.originalname,
        mimetype: video.mimetype,
        size: video.size
      });
      videoUrl = await this.uploadVideo(video, userId, client);
      console.log(`🎥 Video uploaded successfully: ${videoUrl}`);
    } else {
      console.log(`🎥 No videos provided for auction item`);
    }

    // Get auction defaults for item if not provided
    const bidIncrement = createAuctionItemDto.bid_increment || auction.bid_increment || 1.0;
    const biddingDuration = createAuctionItemDto.bidding_duration || 120; // Default 2 minutes

    // Create auction item
    const itemData = {
      auction_id: auctionId,
      title: createAuctionItemDto.title,
      description: createAuctionItemDto.description || null,
      lot_number: createAuctionItemDto.lot_number || null,
      starting_price: createAuctionItemDto.starting_price,
      reserve_price: createAuctionItemDto.reserve_price || null,
      current_bid: createAuctionItemDto.starting_price,
      bid_increment: bidIncrement,
      bidding_status: 'waiting' as const,
      order_in_auction: nextOrder,
      bidding_duration: biddingDuration,
      images: imageUrls.length > 0 ? imageUrls : (createAuctionItemDto.images || []),
      video_url: videoUrl,
    };

    const { data: newItem, error: insertError } = await this.serviceSupabase
      .from('auction_items')
      .insert(itemData)
      .select()
      .single();

    if (insertError || !newItem) {
      console.error('❌ Failed to create auction item:', insertError);
      throw new BadRequestException('Failed to create auction item');
    }

    console.log(`✅ Auction item created: ${newItem.id} (order: ${nextOrder})`);

    // Broadcast new item added event (optional notification for viewers)
    await this.auctionGateway.broadcastItemEvent(auctionId, null, 'item_added', {
      item_id: newItem.id,
      item_title: newItem.title,
      item_number: nextOrder,
      starting_price: newItem.starting_price,
      timestamp: new Date().toISOString(),
    });

    return newItem as AuctionItem;
  }

  /**
   * Start countdown for auction item (3-2-1 countdown)
   */
  async startItemCountdown(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    if (item.bidding_status !== 'waiting') {
      throw new BadRequestException('Item is not in waiting status');
    }

    // Update item status to countdown, but only if it is still waiting.
    const { data: updatedItem, error } = await this.serviceSupabase
      .from('auction_items')
      .update({
        bidding_status: 'countdown',
        countdown_started_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .eq('bidding_status', 'waiting')
      .select()
      .maybeSingle();

    if (!updatedItem) {
      throw new BadRequestException('Item is not in waiting status or has already been started');
    }

    if (error) {
      throw new BadRequestException('Failed to start countdown');
    }

    // Broadcast countdown start
    await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'start_countdown', {
      item_id: itemId,
      item_title: item.title,
      countdown_duration: 3,
      timestamp: new Date().toISOString(),
    });

    // Schedule automatic bidding start after 3 seconds
    setTimeout(() => {
      this.openItemBidding(auctionId, itemId, sellerId).catch(err => {
        console.error('Error opening bidding after countdown:', err);
      });
    }, 3000);
  }

  /**
   * Open bidding for auction item
   */
  async openItemBidding(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    // Update item status to active only if it is in countdown or waiting.
    // This makes the countdown -> open transition idempotent and prevents
    // overwriting a sold/passed/ended item.
    const { data: openedItem, error } = await this.serviceSupabase
      .from('auction_items')
      .update({
        bidding_status: 'active',
        bidding_started_at: new Date().toISOString(),
        current_bid: item.starting_price, // Reset to starting price
      })
      .eq('id', itemId)
      .in('bidding_status', ['countdown', 'waiting'])
      .select()
      .maybeSingle();

    if (!openedItem) {
      throw new BadRequestException('Item is not ready to open or has already been processed');
    }

    // Broadcast bidding open — include media/order fields so clients that
    // replace their current item with this payload keep the banner image
    await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'bidding_open', {
      item_id: itemId,
      item_title: item.title,
      starting_price: item.starting_price,
      minimum_bid: item.starting_price + item.bid_increment,
      bid_increment: item.bid_increment,
      duration: item.bidding_duration,
      images: item.images,
      video_url: item.video_url,
      order_in_auction: item.order_in_auction,
      timestamp: new Date().toISOString(),
    });

    // Removed automatic bidding end - host now controls when to end bidding
    // Timer completion will be handled by frontend to show cancel button
    // Host can end bidding via gavel (markItemSold) or cancel (endItemBidding) buttons
  }

  /**
   * End bidding for auction item (manual or automatic).
   * Returns the settled outcome so the host can decide sold-vs-pass on the
   * database's truth rather than client-side auction-wide counters.
   */
  async endItemBidding(auctionId: string, itemId: string, sellerId: string): Promise<{
    item_id: string;
    bidding_status: string;
    has_valid_bid: boolean;
    winner_id: string | null;
    winning_bid: number | null;
  }> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    const outcomeFor = (it: any) => {
      const hasWinner = !!it.winner_id && it.winning_bid >= it.starting_price;
      const reserveMet = !it.reserve_price || (hasWinner && it.winning_bid >= it.reserve_price);
      const hasValidBid = hasWinner && reserveMet;
      return {
        item_id: it.id,
        bidding_status: it.bidding_status,
        has_valid_bid: hasValidBid,
        winner_id: hasValidBid ? it.winner_id : null,
        winning_bid: hasValidBid ? it.winning_bid : null,
      };
    };

    if (item.bidding_status !== 'active') {
      return outcomeFor(item); // Already ended — report current state
    }

    // Atomically close the item to 'ended' while it is still 'active'.
    // The bid trigger has already maintained item.winner_id / winning_bid on every valid bid.
    const { data: closedItem, error: closeError } = await this.serviceSupabase
      .from('auction_items')
      .update({
        bidding_status: 'ended',
        bidding_ended_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .eq('bidding_status', 'active')
      .select()
      .maybeSingle();

    if (closeError) {
      throw new BadRequestException('Failed to end bidding');
    }

    if (!closedItem) {
      // Another host already ended it between the read and the update
      const fresh = await this.getAuctionItem(itemId);
      return outcomeFor(fresh || item);
    }

    // Determine if the winning bid is valid: must have a winner, meet starting price, and meet reserve
    const hasWinner = closedItem.winner_id && closedItem.winning_bid >= closedItem.starting_price;
    const reserveMet = !closedItem.reserve_price || (hasWinner && closedItem.winning_bid >= closedItem.reserve_price);
    const hasValidBid = !!(hasWinner && reserveMet);
    let winner: any = null;
    let finalBid = closedItem.starting_price;

    if (hasValidBid) {
      winner = {
        bidder_display_id: await this.getWinnerDisplayId(auctionId, itemId, closedItem.winner_id),
        amount: closedItem.winning_bid,
      };
      finalBid = closedItem.winning_bid;
    } else {
      // No valid sale — reset item to starting state for 'passed'
      await this.serviceSupabase
        .from('auction_items')
        .update({
          bidding_status: 'passed',
          winner_id: null,
          winning_bid: null,
          current_bid: closedItem.starting_price,
        })
        .eq('id', itemId)
        .eq('bidding_status', 'ended');
    }

    // Broadcast bidding ended — public payload carries the alias only
    await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'bidding_ended', {
      item_id: itemId,
      item_title: item.title,
      winner: winner,
      final_bid: finalBid,
      item_sold: hasValidBid,
      timestamp: new Date().toISOString(),
    });

    // Targeted ping to the winner so their client can show the win modal
    // without the real user id ever reaching the public room
    if (hasValidBid) {
      await this.emitItemWon(auctionId, itemId, item.title, closedItem.winner_id, closedItem.winning_bid);
    }

    return {
      item_id: itemId,
      bidding_status: hasValidBid ? 'ended' : 'passed',
      has_valid_bid: hasValidBid,
      winner_id: hasValidBid ? closedItem.winner_id : null,
      winning_bid: hasValidBid ? closedItem.winning_bid : null,
    };
  }

  /**
   * Mark item as sold (auctioneer strikes gavel)
   */
  async markItemSold(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Atomically mark the item as sold, create sale/win records, and advance to the next item
    const { data: result, error } = await this.serviceSupabase
      .rpc('mark_item_sold_atomic', {
        p_auction_id: auctionId,
        p_item_id: itemId,
        p_seller_id: sellerId,
      });

    if (error) {
      console.error('mark_item_sold_atomic RPC error:', error);
      throw new BadRequestException(`Failed to mark item as sold: ${error.message}`);
    }

    const rpcResult = result as any;
    if (!rpcResult || !rpcResult.success) {
      throw new BadRequestException(`Failed to mark item as sold: ${rpcResult?.error || 'Unknown error'}`);
    }

    const item = await this.getAuctionItem(itemId);
    const winnerId = rpcResult.winner_id;
    const winningBid = rpcResult.winning_bid;

    // Notify any bidders whose holds failed during the settlement cascade
    await this.notifyForfeitedBidders(rpcResult.forfeited, auctionId, itemId, item?.title);

    if (rpcResult.outcome === 'passed') {
      // No bidder could cover the winning amount — the RPC passed the item.
      // Resolve viewers with a no-winner event like a manual pass.
      await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'bidding_ended', {
        item_id: itemId,
        item_title: item?.title || 'Auction Item',
        winner: null,
        item_sold: false,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Broadcast item sold — public payload carries the alias only
      const bidderDisplayId = winnerId
        ? await this.getWinnerDisplayId(auctionId, itemId, winnerId)
        : null;

      await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'item_sold', {
        item_id: itemId,
        item_title: item?.title || 'Auction Item',
        winner: winnerId ? {
          bidder_display_id: bidderDisplayId,
          amount: winningBid,
        } : null,
        timestamp: new Date().toISOString(),
      });

      // Persistent + push + targeted socket notification so the winner can
      // check out even if they missed the live event
      if (winnerId) {
        await this.notifyItemWinner(auctionId, itemId, item?.title, winnerId, winningBid);
      }
    }

    // Broadcast the next item if one was queued
    if (rpcResult.next_item_id) {
      // The RPC returns only the next item's id/title/pricing/images — fetch
      // the row for video_url and the authoritative order_in_auction
      const nextItem = await this.getAuctionItem(rpcResult.next_item_id);
      await this.auctionGateway.broadcastItemEvent(auctionId, rpcResult.next_item_id, 'item_ready', {
        item_id: rpcResult.next_item_id,
        item_title: rpcResult.next_item_title,
        item_number: nextItem?.order_in_auction ?? (item?.order_in_auction || 0) + 1,
        order_in_auction: nextItem?.order_in_auction,
        starting_price: rpcResult.next_item_starting_price,
        bid_increment: rpcResult.next_item_bid_increment,
        minimum_bid: (Number(rpcResult.next_item_starting_price) || 0) + (Number(rpcResult.next_item_bid_increment) || 0),
        images: rpcResult.next_item_images,
        video_url: nextItem?.video_url,
        total_items: undefined, // kept undefined to avoid inflating old clients
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Skip/Pass item (no bids or reserve not met).
   * Passing an item is terminal — the item never comes back into the queue.
   * Use deferItem to send a waiting item to the back instead.
   */
  async skipItem(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    if (auction.status !== 'active') {
      throw new BadRequestException('Auction is not live');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    if (item.bidding_status === 'sold') {
      throw new BadRequestException('Cannot skip an item that is already sold');
    }

    if (item.bidding_status !== 'passed') {
      // Close the item as passed and clear any stale winner state
      const { error } = await this.serviceSupabase
        .from('auction_items')
        .update({
          bidding_status: 'passed',
          winner_id: null,
          winning_bid: null,
          current_bid: item.starting_price,
          bidding_ended_at: new Date().toISOString(),
        })
        .eq('id', itemId)
        .neq('bidding_status', 'sold');

      if (error) {
        throw new BadRequestException('Failed to skip item');
      }

      // If viewers could see this item (countdown/active/ended), resolve it
      // with a no-winner event so they are not left on an open bid UI
      if (['countdown', 'active', 'ended'].includes(item.bidding_status)) {
        await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'bidding_ended', {
          item_id: itemId,
          item_title: item.title,
          winner: null,
          final_bid: item.starting_price,
          item_sold: false,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Load next item (idempotent — safe to call on an already-passed item to
    // recover a stuck current_item_id pointer)
    await this.loadNextItem(auctionId, sellerId);
  }

  /**
   * Defer a waiting item to the back of the queue, then load the next one.
   * Unlike skipItem the item stays 'waiting' so it can come back later.
   */
  async deferItem(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    if (auction.status !== 'active') {
      throw new BadRequestException('Auction is not live');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    if (item.bidding_status !== 'waiting') {
      throw new BadRequestException('Only waiting items can be deferred');
    }

    // Move to the back of the queue so the next waiting item is a different lot
    const { data: lastItem } = await this.serviceSupabase
      .from('auction_items')
      .select('order_in_auction')
      .eq('auction_id', auctionId)
      .order('order_in_auction', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { error } = await this.serviceSupabase
      .from('auction_items')
      .update({ order_in_auction: (lastItem?.order_in_auction ?? 0) + 1 })
      .eq('id', itemId)
      .eq('bidding_status', 'waiting');

    if (error) {
      throw new BadRequestException('Failed to defer item');
    }

    await this.loadNextItem(auctionId, sellerId);
  }

  /**
   * Load a specific waiting item as the current item (host picks from queue).
   */
  async selectItem(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    if (auction.status !== 'active') {
      throw new BadRequestException('Auction is not live');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    if (item.bidding_status !== 'waiting') {
      throw new BadRequestException('Only waiting items can be loaded');
    }

    const { error } = await this.serviceSupabase
      .from('auctions')
      .update({ current_item_id: itemId })
      .eq('id', auctionId);

    if (error) {
      throw new BadRequestException('Failed to select item');
    }

    const { count } = await this.serviceSupabase
      .from('auction_items')
      .select('*', { count: 'exact', head: true })
      .eq('auction_id', auctionId);

    await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'item_ready', {
      item_id: item.id,
      item_title: item.title,
      item_number: item.order_in_auction,
      order_in_auction: item.order_in_auction,
      total_items: count || 0,
      starting_price: item.starting_price,
      bid_increment: item.bid_increment,
      images: item.images,
      video_url: item.video_url,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Winning bidder's public alias for an item-scoped sale (best-effort).
   */
  private async getWinnerDisplayId(auctionId: string, itemId: string, winnerId: string): Promise<string> {
    const { data: winnerBid } = await this.serviceSupabase
      .from('auction_bids')
      .select('bidder_display_id')
      .eq('auction_id', auctionId)
      .eq('item_id', itemId)
      .eq('bidder_id', winnerId)
      .order('amount', { ascending: false })
      .limit(1)
      .maybeSingle();
    return winnerBid?.bidder_display_id || 'Winner';
  }

  /**
   * Real-time "you won this item" ping — targeted to the winner's sockets
   * only so the real user id never reaches the public room.
   */
  private async emitItemWon(
    auctionId: string,
    itemId: string,
    itemTitle: string | undefined,
    winnerId: string,
    amount: number,
  ): Promise<void> {
    try {
      await this.auctionGateway.sendUserNotification(winnerId, {
        type: 'auction_item_won',
        title: '🎉 You Won!',
        message: `You won "${itemTitle || 'an item'}" for ₣${Number(amount).toFixed(2)}`,
        auction_id: auctionId,
        item_id: itemId,
        item_title: itemTitle,
        amount,
      });
    } catch (error) {
      console.error(`Failed to emit item-won event for item ${itemId}:`, error);
    }
  }

  /**
   * Persistent + push + targeted socket winner notification for a settled
   * live-auction item — mirrors the timed-auction winner notification so a
   * winner who missed the socket event still discovers the win and can
   * check out.
   */
  private async notifyItemWinner(
    auctionId: string,
    itemId: string,
    itemTitle: string | undefined,
    winnerId: string,
    amount: number,
  ): Promise<void> {
    try {
      await this.supabase.from('notifications').insert({
        user_id: winnerId,
        type: 'auction_won',
        title: '🎉 Congratulations! You Won!',
        message: `You won "${itemTitle || 'an auction item'}" for ₣${Number(amount).toFixed(2)}. Proceed to checkout to complete your purchase.`,
        data: {
          auction_id: auctionId,
          item_id: itemId,
          item_title: itemTitle,
          winning_bid: amount,
          action: 'checkout',
        },
        created_at: new Date().toISOString(),
      });

      await this.emitItemWon(auctionId, itemId, itemTitle, winnerId, amount);

      await this.pushNotificationService.sendPushNotification(winnerId, {
        title: 'Congratulations! You Won!',
        body: `You won "${itemTitle || 'an auction item'}" for ₣${Number(amount).toFixed(2)}. Proceed to checkout to complete your purchase.`,
        data: { type: 'auction_item_won', auction_id: auctionId, item_id: itemId, action: 'checkout' },
      });

      await this.emailNotificationService.sendUserEmail(winnerId, {
        subject: `You won "${itemTitle || 'an auction item'}"!`,
        category: 'auction',
        reminder: { type: 'auction_won', entityType: 'auction_item', entityId: itemId },
        buildHtml: ({ name }) => auctionWonEmail({
          name,
          title: itemTitle || 'an auction item',
          amount,
          // Live-item wins carry a 48h checkout window (migration 228)
          expiresAt: new Date(Date.now() + 48 * 3600_000),
          appUrl: this.configService.get('FRONTEND_URL') || 'https://fretiko.com',
        }),
      });
    } catch (error) {
      console.error(`Failed to notify winner for item ${itemId}:`, error);
    }
  }

  /**
   * Notify bidders whose win could not settle because their wallet hold
   * failed during the settlement/promotion cascade.
   */
  private async notifyForfeitedBidders(
    forfeited: Array<{ bidder_id: string; amount: number }> | undefined,
    auctionId: string,
    itemId: string | null,
    itemTitle: string | undefined,
  ): Promise<void> {
    for (const entry of forfeited || []) {
      if (!entry?.bidder_id) continue;
      try {
        await this.supabase.from('notifications').insert({
          user_id: entry.bidder_id,
          type: 'auction_win_forfeited',
          title: 'Auction Win Forfeited',
          message: `Your winning bid of ₣${Number(entry.amount).toFixed(2)} on "${itemTitle || 'an auction item'}" could not be completed — insufficient wallet balance. The item went to the next bidder.`,
          data: {
            auction_id: auctionId,
            item_id: itemId,
            item_title: itemTitle,
            amount: entry.amount,
          },
          created_at: new Date().toISOString(),
        });

        await this.pushNotificationService.sendPushNotification(entry.bidder_id, {
          title: 'Auction Win Forfeited',
          body: `Your winning bid of ₣${Number(entry.amount).toFixed(2)} on "${itemTitle || 'an auction item'}" could not be completed — insufficient wallet balance.`,
          data: { type: 'auction_win_forfeited', auction_id: auctionId, item_id: itemId },
        });

        await this.emailNotificationService.sendUserEmail(entry.bidder_id, {
          subject: `Auction win forfeited — "${itemTitle || 'an auction item'}"`,
          category: 'auction',
          buildHtml: ({ name }) => auctionWinForfeitedEmail({
            name,
            title: itemTitle || 'an auction item',
            amount: entry.amount,
            appUrl: this.configService.get('FRONTEND_URL') || 'https://fretiko.com',
          }),
        });
      } catch (error) {
        console.error(`Failed to notify forfeited bidder ${entry.bidder_id}:`, error);
      }
    }
  }

  /**
   * Load next item in auction
   */
  async loadNextItem(auctionId: string, sellerId: string): Promise<void> {
    const nextItem = await this.getNextWaitingItem(auctionId);

    if (!nextItem) {
      // No more items - auction remains active for live streaming
      console.log(`Auction ${auctionId}: All items sold, auction remains active for live streaming`);
      return;
    }

    // Advance current_item_id only if the auction is still pointing at the item
    // we expect to replace. This makes concurrent skip/Advance safe.
    const auction = await this.findById(auctionId);
    const previousCurrentItemId = auction?.current_item_id || null;

    let updateQuery = this.serviceSupabase
      .from('auctions')
      .update({
        current_item_id: nextItem.id,
      })
      .eq('id', auctionId);

    if (previousCurrentItemId) {
      updateQuery = updateQuery.eq('current_item_id', previousCurrentItemId);
    } else {
      updateQuery = updateQuery.is('current_item_id', null);
    }

    const { data: updatedAuction, error } = await updateQuery
      .select()
      .maybeSingle();

    if (error || !updatedAuction) {
      // Another call already advanced the current item; do not broadcast again.
      console.log(`Auction ${auctionId}: current_item_id already advanced, skipping broadcast`);
      return;
    }

    // Get total items count
    const { count } = await this.serviceSupabase
      .from('auction_items')
      .select('*', { count: 'exact', head: true })
      .eq('auction_id', auctionId);

    // Broadcast next item ready
    await this.auctionGateway.broadcastItemEvent(auctionId, null, 'item_ready', {
      item_id: nextItem.id,
      item_title: nextItem.title,
      item_number: nextItem.order_in_auction,
      order_in_auction: nextItem.order_in_auction,
      total_items: count || 0,
      starting_price: nextItem.starting_price,
      bid_increment: nextItem.bid_increment,
      images: nextItem.images,
      video_url: nextItem.video_url,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get user's auction wins
   */
  async getUserAuctionWins(
    userId: string,
    status?: 'pending_checkout' | 'checked_out' | 'expired',
    userToken?: string,
  ): Promise<any[]> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.serviceSupabase;

    let query = client
      .from('user_auction_wins')
      .select(`
        *,
        auction:auctions (
          id,
          title,
          images,
          thumbnail_url,
          status,
          auction_type
        ),
        item:auction_items (
          id,
          title,
          images,
          lot_number,
          order_in_auction
        )
      `)
      .eq('user_id', userId)
      .order('won_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      throw new BadRequestException(`Failed to fetch auction wins: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Send a reaction to an auction
   * Allows viewers to provide feedback to auctioneers
   */
  async sendReaction(userId: string, auctionId: string, reactionType: 'heart' | 'thumbs_up' | 'applause' | 'fire', userToken?: string): Promise<void> {
    try {
      const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.serviceSupabase;

      // Verify auction exists and is active
      const auction = await this.findById(auctionId);
      if (!auction || auction.status !== 'active') {
        throw new BadRequestException('Auction not found or not active');
      }

      // Save reaction to database
      const { error } = await client
        .from('auction_reactions')
        .insert({
          auction_id: auctionId,
          user_id: userId,
          reaction_type: reactionType,
        });

      if (error) {
        // Handle unique constraint violation (user already sent this reaction type)
        // For auctions, we allow multiple reactions, so this shouldn't happen with our schema
        // But we'll handle it gracefully
        if (error.code === '23505') {
          // User already sent this reaction - that's okay, we allow multiple
          // Just log and continue
          console.log(`User ${userId} already sent ${reactionType} reaction to auction ${auctionId}`);
        } else {
          throw new BadRequestException(`Failed to save reaction: ${error.message}`);
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      console.error('Error sending auction reaction:', error);
      throw new BadRequestException('Failed to send reaction');
    }
  }

  /**
   * Mark auction win as checked out (after order is created)
   */
  async markWinCheckedOut(winId: string, orderId: string, userId: string, userToken?: string): Promise<void> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.serviceSupabase;

    // Verify win belongs to user
    const { data: win, error: fetchError } = await client
      .from('user_auction_wins')
      .select('user_id')
      .eq('id', winId)
      .single();

    if (fetchError || !win) {
      throw new NotFoundException('Auction win not found');
    }

    if (win.user_id !== userId) {
      throw new ForbiddenException('You do not have permission to update this win');
    }

    // Update win status
    const { error } = await client
      .from('user_auction_wins')
      .update({
        status: 'checked_out',
        order_id: orderId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', winId);

    if (error) {
      throw new BadRequestException(`Failed to mark win as checked out: ${error.message}`);
    }
  }
}