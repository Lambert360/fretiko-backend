import { Injectable, NotFoundException, BadRequestException, ForbiddenException, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { CreateAuctionDto, PlaceBidDto, AuctionFilterDto, UpdateProxyBidDto, WatchlistDto, CreateAuctionItemDto } from './dto';
import { Auction, AuctionWithDetails, AuctionBid, AuctionCategory, AuctionCategoryWithStats, PublicBidHistoryItem, AuctionItem, AuctionItemWithDetails } from './entities';
import { WalletService } from '../wallet/wallet.service';
import { AuctionGateway } from './auction.gateway';
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
    let query = this.supabase
      .from('auction_summary')
      .select('*');

    // Apply filters
    if (filters.search) {
      query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    }

    if (filters.category_id) {
      query = query.eq('category_id', filters.category_id);
    }

    if (filters.category_slug) {
      query = query.eq('category_slug', filters.category_slug);
    }

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    if (filters.auction_type) {
      query = query.eq('auction_type', filters.auction_type);
    }

    if (filters.min_price) {
      query = query.gte('current_bid', filters.min_price);
    }

    if (filters.max_price) {
      query = query.lte('current_bid', filters.max_price);
    }

    if (filters.time_filter) {
      const now = new Date();
      switch (filters.time_filter) {
        case 'ending_soon':
          // Ending within next 2 hours
          const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
          query = query.lte('end_time', twoHoursFromNow.toISOString()).eq('status', 'active');
          break;
        case 'just_started':
          // Started within last 2 hours
          const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
          query = query.gte('start_time', twoHoursAgo.toISOString()).eq('status', 'active');
          break;
        case 'upcoming':
          query = query.eq('time_status', 'upcoming');
          break;
      }
    }

    if (filters.no_reserve) {
      query = query.is('reserve_price', null);
    }

    if (filters.seller_id) {
      query = query.eq('seller_id', filters.seller_id);
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

    // Get total count for pagination
    const { count } = await this.supabase
      .from('auction_summary')
      .select('*', { count: 'exact', head: true });

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
   * Get single auction by ID with full details
   */
  async findById(id: string, userId?: string): Promise<AuctionWithDetails> {
    const { data, error } = await this.supabase
      .from('auction_summary')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException('Auction not found');
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
  async createAuction(userId: string, createAuctionDto: CreateAuctionDto, userToken?: string, images?: Express.Multer.File[], video?: Express.Multer.File): Promise<Auction> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Verify user is a seller
    const { data: userProfile } = await client
      .from('user_profiles')
      .select('is_seller')
      .eq('id', userId)
      .single();

    if (!userProfile?.is_seller) {
      throw new ForbiddenException('Only sellers can create auctions');
    }

    // Verify category exists
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

    // Upload images to Supabase Storage if provided
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

    // Upload video to Supabase Storage if provided
    let videoUrl: string | undefined = createAuctionDto.video_url;
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

    // Generate thumbnail from video if no images provided
    let thumbnailUrl: string | null | undefined = createAuctionDto.thumbnail_url;
    if (imageUrls.length > 0) {
      // If images provided, use first image as thumbnail
      thumbnailUrl = imageUrls[0];
    } else if (video && !createAuctionDto.thumbnail_url) {
      // If no images but video provided, generate thumbnail from video
      console.log('📸 No images provided, generating thumbnail from video...');
      try {
        const generatedThumbnail = await this.generateVideoThumbnail(video, userId, client);
        if (generatedThumbnail) {
          thumbnailUrl = generatedThumbnail;
          console.log('✅ Video thumbnail generated successfully:', generatedThumbnail);
        } else {
          console.warn('⚠️ Failed to generate video thumbnail, using null');
          thumbnailUrl = null;
        }
      } catch (error) {
        console.error('⚠️ Error generating video thumbnail:', error);
        thumbnailUrl = null;
      }
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

    // For live auctions, create initial auction item from auction data
    if (data.auction_type === 'live') {
      const initialItemData = {
        auction_id: data.id,
        title: data.title,
        description: data.description,
        lot_number: data.lot_number,
        starting_price: data.starting_price,
        reserve_price: data.reserve_price,
        current_bid: 0,
        bid_increment: data.bid_increment || 1.0,
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
          .eq('id', data.id);
        console.log('✅ Initial auction item created for live auction');
      }
    }

    // Broadcast auction creation event for scheduled auctions (so discovery screen can update)
    if (data.status === 'scheduled') {
      await this.auctionGateway.broadcastAuctionStatusChange(data.id, 'scheduled', {
        message: 'New auction created',
        seller_id: data.seller_id,
        auction_type: data.auction_type,
      });
    }

    return data;
  }

  /**
   * Place a bid on an auction
   */
  async placeBid(userId: string, placeBidDto: PlaceBidDto, userToken?: string): Promise<AuctionBid> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get auction details
    const auction = await this.findById(placeBidDto.auction_id);

    // Validate auction status
    if (auction.status !== 'active') {
      throw new BadRequestException('Auction is not active');
    }

    // Check if user is the seller (can't bid on own auction)
    if (auction.seller_id === userId) {
      throw new BadRequestException('You cannot bid on your own auction');
    }

    // Validate bid amount
    const minimumBid = auction.current_bid + auction.bid_increment;
    if (placeBidDto.amount < minimumBid) {
      throw new BadRequestException(`Minimum bid is ${minimumBid} Freti`);
    }

    // ✅ BUG FIX: Removed redundant balance check - validation happens atomically at payment time
    // This prevents race conditions where balance could change between check and payment processing

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
      // Fetch all bidder_ids and count unique ones
      const { data: allBids } = await client
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

    // Place the bid
    const bidData = {
      auction_id: placeBidDto.auction_id,
      bidder_id: userId,
      amount: placeBidDto.amount,
      bid_type: placeBidDto.bid_type || 'manual',
      max_bid_amount: placeBidDto.max_bid_amount,
      is_proxy_bid: placeBidDto.bid_type === 'proxy',
      bidder_display_id: bidderDisplayId,
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

    // Process proxy bids for ANY bid type (both manual and proxy bids should trigger proxy processing)
    // This allows proxy bidders to counter-bid when other proxy bids are placed
    // Only skip if we're already processing proxy bids for this auction (prevents recursion loops)
    if (!this.processingProxyBids.has(placeBidDto.auction_id)) {
      // Process proxy bids asynchronously (don't block the response)
      this.processProxyBids(placeBidDto.auction_id, data.amount, data.bidder_id, data.id).catch(err => {
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
    isRecursive: boolean = false, // Track if this is a recursive call
  ): Promise<void> {
    // Prevent concurrent processing from different initial calls (but allow recursion)
    if (!isRecursive && this.processingProxyBids.has(auctionId)) {
      return; // Another process is already handling proxy bids for this auction
    }

    if (!isRecursive) {
      this.processingProxyBids.add(auctionId);
    }

    try {
      // Get auction details for bid_increment and current state
      const auction = await this.findById(auctionId);
      if (!auction || auction.status !== 'active') {
        return; // Auction is no longer active
      }

      const bidIncrement = auction.bid_increment;
      const minimumCounterBid = newBidAmount + bidIncrement;

      // Get current winning bidder to exclude them (they're already winning, no need to counter-bid)
      const { data: currentWinningBid } = await this.serviceSupabase
        .from('auction_bids')
        .select('bidder_id, amount')
        .eq('auction_id', auctionId)
        .eq('is_winning', true)
        .eq('is_valid', true)
        .maybeSingle();

      const currentWinningBidderId = currentWinningBid?.bidder_id;

      // Find the highest active ORIGINAL proxy bid where max_bid_amount >= minimum counter bid
      // We only look at original proxy bids (proxy_bid_parent_id IS NULL), not system-generated counter-bids
      // Exclude:
      //   - The bidder who just placed this bid
      //   - The current winning bidder (they're already winning, no need to counter-bid)
      // Only get the highest one (we'll process one at a time to avoid race conditions)
      let proxyBidsQuery = this.serviceSupabase
        .from('auction_bids')
        .select('id, bidder_id, max_bid_amount, bidder_display_id')
        .eq('auction_id', auctionId)
        .eq('is_proxy_bid', true)
        .eq('is_valid', true)
        .is('proxy_bid_parent_id', null) // Only original proxy bids (not system-generated counter-bids)
        .neq('bidder_id', newBidderId) // Exclude the current bidder
        .gte('max_bid_amount', minimumCounterBid); // Only those who can outbid

      // Exclude current winning bidder if they exist
      if (currentWinningBidderId) {
        proxyBidsQuery = proxyBidsQuery.neq('bidder_id', currentWinningBidderId);
      }

      const { data: proxyBids, error: findError } = await proxyBidsQuery
        .order('max_bid_amount', { ascending: false })
        .limit(1); // Only process the highest proxy bidder

      if (findError || !proxyBids || proxyBids.length === 0) {
        return; // No proxy bids to process
      }

      const proxyBid = proxyBids[0];

      // Calculate counter-bid: minimum to beat new bid, but don't exceed proxy max
      const counterBidAmount = Math.min(minimumCounterBid, proxyBid.max_bid_amount);

      // Double-check: only proceed if counter-bid is actually higher
      if (counterBidAmount <= newBidAmount) {
        return;
      }

      // ✅ BUG FIX: Removed redundant balance check - validation happens atomically at payment time
      // This prevents race conditions where balance could change between check and payment processing
      // Note: If proxy bidder has insufficient balance at payment time, the payment will fail and be handled appropriately

      // Fetch the latest auction state to ensure we have the correct current_bid
      // (This accounts for any bids that may have been placed since we started processing)
      const currentAuction = await this.findById(auctionId);
      const currentMinBid = currentAuction.current_bid + currentAuction.bid_increment;

      // Calculate the final counter-bid amount based on current auction state
      // Use the higher of: calculated counterBidAmount OR current minimum bid
      // But never exceed the proxy bidder's max_bid_amount
      const finalCounterBid = Math.min(
        Math.max(counterBidAmount, currentMinBid),
        proxyBid.max_bid_amount
      );

      // Validate: counter-bid must be higher than current winning bid
      if (finalCounterBid <= currentAuction.current_bid) {
        return; // Proxy bidder's max is no longer sufficient to beat current bid
      }

      // Validate: counter-bid must be at least the minimum required
      if (finalCounterBid < currentMinBid) {
        return; // Counter-bid doesn't meet minimum requirement
        }

        // Place counter-bid using the service client (bypasses RLS)
        await this.placeBidInternal(
          proxyBid.bidder_id,
          auctionId,
        finalCounterBid,
          proxyBid.max_bid_amount,
          proxyBid.bidder_display_id,
          proxyBid.id, // parent proxy bid id
        );

      // Recursively process proxy bids for the new counter-bid
      // (in case there are other proxy bidders who can outbid this counter-bid)
      // Get the new current bid amount
      const updatedAuction = await this.findById(auctionId);
      if (updatedAuction.current_bid > newBidAmount) {
        // Find the counter-bid we just placed
        const { data: counterBid } = await this.serviceSupabase
          .from('auction_bids')
          .select('id, amount, bidder_id')
          .eq('auction_id', auctionId)
          .eq('bidder_id', proxyBid.bidder_id)
          .eq('proxy_bid_parent_id', proxyBid.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (counterBid) {
          // Recursively process proxy bids (pass isRecursive=true to allow recursion)
          await this.processProxyBids(
            auctionId,
            counterBid.amount,
            counterBid.bidder_id,
            counterBid.id,
            true, // Mark as recursive call
          );
        }
      }
    } catch (error) {
      console.error(`[Auction ${auctionId}] Error in processProxyBids:`, error);
      // Don't throw - proxy bid processing failure shouldn't fail the original bid
    } finally {
      // Only remove from set if this was the initial (non-recursive) call
      if (!isRecursive) {
        this.processingProxyBids.delete(auctionId);
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
    amount: number,
    maxBidAmount: number,
    bidderDisplayId: string,
    proxyBidParentId: string,
  ): Promise<AuctionBid> {
    const bidData = {
      auction_id: auctionId,
      bidder_id: bidderId,
      amount: amount,
      bid_type: 'proxy' as const,
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

    // Broadcast WebSocket event for proxy counter-bid
    // Query auction stats directly from auctions table using serviceSupabase
    // (same client = same connection = consistent reads, bypasses RLS, ensures fresh data)
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
      });
      }
    } catch (error) {
      console.error(`[Auction ${auctionId}] Error broadcasting proxy bid update:`, error);
      // Don't throw - WebSocket broadcast failure shouldn't fail the bid
    }

    return data;
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
    // Find user's active proxy bid for this auction (highest max_bid_amount if multiple)
    const { data: existingBids, error: findError } = await this.supabase
      .from('auction_bids')
      .select('*')
      .eq('auction_id', auctionId)
      .eq('bidder_id', userId) // Fixed: was 'user_id', should be 'bidder_id'
      .eq('is_proxy_bid', true)
      .eq('is_valid', true)
      .order('max_bid_amount', { ascending: false })
      .limit(1);

    if (findError) throw findError;

    if (!existingBids || existingBids.length === 0) {
      throw new BadRequestException('No active proxy bid found for this auction. Place a proxy bid first.');
    }

    const existingBid = existingBids[0];

    // Validate the new max_bid_amount is higher than current bid
    const auction = await this.findById(auctionId);
    if (maxBidAmount < auction.current_bid + auction.bid_increment) {
      throw new BadRequestException(`Maximum bid amount must be at least ${auction.current_bid + auction.bid_increment} Freti (current bid + increment)`);
    }

    // Update the proxy bid's max_bid_amount
    // Update all proxy bids from this user for this auction to keep them in sync
    const { data, error } = await this.supabase
      .from('auction_bids')
      .update({ max_bid_amount: maxBidAmount })
      .eq('auction_id', auctionId)
      .eq('bidder_id', userId) // Fixed: was 'user_id', should be 'bidder_id'
      .eq('is_proxy_bid', true)
      .eq('is_valid', true)
      .select()
      .order('created_at', { ascending: false });

    if (error) throw error;

    return { message: 'Proxy bid updated successfully', bid: data[0] };
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

    const uniqueBidders = [...new Set((bids || []).map(b => b.bidder_id))];

    // Send notifications to all bidders
    if (uniqueBidders.length > 0) {
      const notifications = uniqueBidders.map(bidderId => ({
        user_id: bidderId,
        type: 'auction_extended',
        title: '⏰ Auction Extended',
        message: `Auction "${auction.title}" has been extended by ${extensionMinutes} minutes. Reason: ${reason}`,
        data: {
          auction_id: auctionId,
          extension_minutes: extensionMinutes,
          new_end_time: newEndTime.toISOString(),
          reason,
        },
      }));

      await this.supabase.from('notifications').insert(notifications);
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
        .select('seller_id, auction_type')
        .eq('id', auctionId)
        .single();

      if (error || !auction) {
        throw new NotFoundException('Auction not found');
      }

      if (auction.auction_type !== 'live') {
        throw new BadRequestException('This auction is not a live auction');
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

      // Update auction with stream_url (using Agora channel name as identifier)
      const streamUrl = `agora://auction_${auctionId}`;
      const { data, error } = await this.serviceSupabase
        .from('auctions')
        .update({
          stream_url: streamUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', auctionId)
        .select()
        .single();

      if (error) {
        throw new BadRequestException(`Failed to start broadcast: ${error.message}`);
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

    if (error || !data) {
      return [];
    }

    return data as AuctionItem[];
  }

  /**
   * Create a new auction item during live auction
   * Allows hosts to add items on-the-fly
   */
  async createAuctionItem(
    auctionId: string,
    userId: string,
    createAuctionItemDto: CreateAuctionItemDto,
    userToken?: string,
    images?: Express.Multer.File[],
  ): Promise<AuctionItem> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.serviceSupabase;

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

    // Update item status to countdown
    const { error } = await this.serviceSupabase
      .from('auction_items')
      .update({
        bidding_status: 'countdown',
        countdown_started_at: new Date().toISOString(),
      })
      .eq('id', itemId);

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

    // Update item status to active
    const { error } = await this.serviceSupabase
      .from('auction_items')
      .update({
        bidding_status: 'active',
        bidding_started_at: new Date().toISOString(),
        current_bid: item.starting_price, // Reset to starting price
      })
      .eq('id', itemId);

    if (error) {
      throw new BadRequestException('Failed to open bidding');
    }

    // Broadcast bidding open
    await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'bidding_open', {
      item_id: itemId,
      item_title: item.title,
      starting_price: item.starting_price,
      minimum_bid: item.starting_price + item.bid_increment,
      bid_increment: item.bid_increment,
      duration: item.bidding_duration,
      timestamp: new Date().toISOString(),
    });

    // Schedule bidding end after duration
    setTimeout(() => {
      this.endItemBidding(auctionId, itemId, sellerId).catch(err => {
        console.error('Error ending bidding:', err);
      });
    }, item.bidding_duration * 1000);
  }

  /**
   * End bidding for auction item (manual or automatic)
   */
  async endItemBidding(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    if (item.bidding_status !== 'active') {
      return; // Already ended
    }

    // Get highest bidder for this item
    const { data: highestBid, error: bidError } = await this.serviceSupabase
      .from('auction_bids')
      .select('bidder_id, amount, bidder_display_id')
      .eq('auction_id', auctionId)
      .order('amount', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const hasValidBid = highestBid && highestBid.amount >= item.starting_price;
    const winner = hasValidBid ? {
      bidder_id: highestBid.bidder_id,
      amount: highestBid.amount,
      bidder_display_id: highestBid.bidder_display_id,
    } : null;

    // Update item status
    const updateData: any = {
      bidding_status: winner ? 'ended' : 'passed',
      bidding_ended_at: new Date().toISOString(),
    };

    if (winner) {
      updateData.winner_id = winner.bidder_id;
      updateData.winning_bid = winner.amount;
      updateData.current_bid = winner.amount;
    }

    const { error } = await this.serviceSupabase
      .from('auction_items')
      .update(updateData)
      .eq('id', itemId);

    if (error) {
      throw new BadRequestException('Failed to end bidding');
    }

    // Broadcast bidding ended
    await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'bidding_ended', {
      item_id: itemId,
      item_title: item.title,
      winner: winner,
      final_bid: winner?.amount || item.starting_price,
      item_sold: !!winner,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Mark item as sold (auctioneer strikes gavel)
   */
  async markItemSold(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    if (item.bidding_status !== 'ended') {
      throw new BadRequestException('Item bidding must be ended before marking as sold');
    }

    // Update item status to sold
    const { error } = await this.serviceSupabase
      .from('auction_items')
      .update({
        bidding_status: 'sold',
      })
      .eq('id', itemId);

    if (error) {
      throw new BadRequestException('Failed to mark item as sold');
    }

    // Save win to database if there's a winner
    if (item.winner_id && item.winning_bid) {
      try {
        await this.saveAuctionWin(
          item.winner_id,
          auctionId,
          item.winning_bid,
          itemId,
        );
      } catch (error) {
        console.error('Failed to save auction win:', error);
        // Don't throw - win saving failure shouldn't block the sale
      }
    }

    // Broadcast item sold
    await this.auctionGateway.broadcastItemEvent(auctionId, itemId, 'item_sold', {
      item_id: itemId,
      item_title: item.title,
      winner: item.winner_id ? {
        bidder_id: item.winner_id,
        amount: item.winning_bid,
      } : null,
      timestamp: new Date().toISOString(),
    });

    // Load next item
    await this.loadNextItem(auctionId, sellerId);
  }

  /**
   * Skip/Pass item (no bids or reserve not met)
   */
  async skipItem(auctionId: string, itemId: string, sellerId: string): Promise<void> {
    // Verify auction ownership
    const auction = await this.findById(auctionId);
    if (!auction || auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the auction seller can control items');
    }

    const item = await this.getAuctionItem(itemId);
    if (!item || item.auction_id !== auctionId) {
      throw new NotFoundException('Auction item not found');
    }

    // Update item status to passed
    const { error } = await this.serviceSupabase
      .from('auction_items')
      .update({
        bidding_status: 'passed',
        bidding_ended_at: new Date().toISOString(),
      })
      .eq('id', itemId);

    if (error) {
      throw new BadRequestException('Failed to skip item');
    }

    // Load next item
    await this.loadNextItem(auctionId, sellerId);
  }

  /**
   * Load next item in auction
   */
  async loadNextItem(auctionId: string, sellerId: string): Promise<void> {
    const nextItem = await this.getNextWaitingItem(auctionId);

    if (nextItem) {
      // Update auction to set current item
      const { error } = await this.serviceSupabase
        .from('auctions')
        .update({
          current_item_id: nextItem.id,
        })
        .eq('id', auctionId);

      if (error) {
        throw new BadRequestException('Failed to load next item');
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
        total_items: count || 0,
        starting_price: nextItem.starting_price,
        bid_increment: nextItem.bid_increment,
        images: nextItem.images,
        timestamp: new Date().toISOString(),
      });
    } else {
      // No more items - end auction
      await this.endAuction(auctionId);
    }
  }

  /**
   * End entire auction
   */
  private async endAuction(auctionId: string): Promise<void> {
    const { error } = await this.serviceSupabase
      .from('auctions')
      .update({
        status: 'ended',
        end_time: new Date().toISOString(),
      })
      .eq('id', auctionId);

    if (error) {
      console.error('Error ending auction:', error);
    }

    // Broadcast auction ended
    await this.auctionGateway.broadcastAuctionStatusChange(auctionId, 'ended', {
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Save auction win to database (for both live and timed auctions)
   */
  async saveAuctionWin(
    userId: string,
    auctionId: string,
    winningBid: number,
    itemId?: string,
  ): Promise<any> {
    try {
      // Check if win already exists (prevent duplicates)
      const existingWin = await this.serviceSupabase
        .from('user_auction_wins')
        .select('id')
        .eq('user_id', userId)
        .eq('auction_id', auctionId)
        .eq('item_id', itemId || null)
        .in('status', ['pending_checkout', 'checked_out'])
        .maybeSingle();

      if (existingWin?.data) {
        // Win already exists, return it
        return existingWin.data;
      }

      // Create new win record
      const { data, error } = await this.serviceSupabase
        .from('user_auction_wins')
        .insert({
          user_id: userId,
          auction_id: auctionId,
          item_id: itemId || null,
          winning_bid: winningBid,
          status: 'pending_checkout',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
        })
        .select()
        .single();

      if (error) {
        console.error('Error saving auction win:', error);
        throw new BadRequestException(`Failed to save auction win: ${error.message}`);
      }

      return data;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      console.error('Unexpected error saving auction win:', error);
      throw new BadRequestException('Failed to save auction win');
    }
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