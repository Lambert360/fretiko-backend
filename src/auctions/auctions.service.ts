import { Injectable, NotFoundException, BadRequestException, ForbiddenException, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { CreateAuctionDto, PlaceBidDto, AuctionFilterDto, UpdateProxyBidDto, WatchlistDto } from './dto';
import { Auction, AuctionWithDetails, AuctionBid, AuctionCategory, AuctionCategoryWithStats, PublicBidHistoryItem } from './entities';
import { WalletService } from '../wallet/wallet.service';
import { AuctionGateway } from './auction.gateway';

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

    // Increment view count
    await this.supabase
      .from('auctions')
      .update({ view_count: auction.view_count + 1 })
      .eq('id', id);

    return auction;
  }

  /**
   * Create a new auction
   */
  async createAuction(userId: string, createAuctionDto: CreateAuctionDto, userToken?: string, images?: Express.Multer.File[]): Promise<Auction> {
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
      video_url: createAuctionDto.video_url,
      thumbnail_url: createAuctionDto.thumbnail_url || (imageUrls.length > 0 ? imageUrls[0] : null),
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

    // Check user's wallet balance
    const userWallet = await this.walletService.getWallet(userId);
    if (userWallet.availableBalance < placeBidDto.amount) {
      throw new BadRequestException('Insufficient wallet balance to place bid');
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
        .select('current_bid, total_bids, unique_bidders')
        .eq('id', placeBidDto.auction_id)
        .single();

      if (!statsError && auctionStats) {
        await this.auctionGateway.broadcastBidUpdate(placeBidDto.auction_id, {
          amount: data.amount,
          bidder_display_id: data.bidder_display_id,
          current_bid: auctionStats.current_bid,
          total_bids: auctionStats.total_bids,
          unique_bidders: auctionStats.unique_bidders,
          is_winning: true,
        });
      }
    } catch (error) {
      console.error(`[Auction ${placeBidDto.auction_id}] Error broadcasting bid update:`, error);
      // Don't throw - WebSocket broadcast failure shouldn't fail the bid
    }

    // Process proxy bids only if this is a manual bid (not a proxy counter-bid)
    // Proxy counter-bids are identified by checking if we're already processing this auction
    if (placeBidDto.bid_type !== 'proxy' && !this.processingProxyBids.has(placeBidDto.auction_id)) {
      // Process proxy bids asynchronously (don't block the response)
      this.processProxyBids(placeBidDto.auction_id, data.amount, data.bidder_id, data.id).catch(err => {
        console.error(`[Auction ${placeBidDto.auction_id}] Error processing proxy bids:`, err);
        // Don't throw - proxy bid processing failure shouldn't fail the original bid
      });
    }

    return data;
  }

  /**
   * Process proxy bids after a manual bid is placed
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

      // Find the highest active ORIGINAL proxy bid where max_bid_amount >= minimum counter bid
      // We only look at original proxy bids (proxy_bid_parent_id IS NULL), not system-generated counter-bids
      // Exclude the bidder who just placed this bid
      // Only get the highest one (we'll process one at a time to avoid race conditions)
      const { data: proxyBids, error: findError } = await this.serviceSupabase
        .from('auction_bids')
        .select('id, bidder_id, max_bid_amount, bidder_display_id')
        .eq('auction_id', auctionId)
        .eq('is_proxy_bid', true)
        .eq('is_valid', true)
        .is('proxy_bid_parent_id', null) // Only original proxy bids (not system-generated counter-bids)
        .neq('bidder_id', newBidderId) // Exclude the current bidder
        .gte('max_bid_amount', minimumCounterBid) // Only those who can outbid
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

      // Check proxy bidder's wallet balance before placing counter-bid
      const proxyBidderWallet = await this.walletService.getWallet(proxyBid.bidder_id);
      if (proxyBidderWallet.availableBalance < counterBidAmount) {
        console.log(`[Auction ${auctionId}] Proxy bidder ${proxyBid.bidder_id} has insufficient balance for counter-bid`);
        return; // Skip this proxy bidder (they can't afford the counter-bid)
      }

      // Fetch the latest auction state to ensure we have the correct current_bid
      const currentAuction = await this.findById(auctionId);
      const currentMinBid = currentAuction.current_bid + currentAuction.bid_increment;

      // Ensure counter-bid still meets minimum (race condition protection)
      if (counterBidAmount < currentMinBid) {
        // Recalculate based on current state
        const recalculatedCounterBid = Math.min(currentMinBid, proxyBid.max_bid_amount);
        if (recalculatedCounterBid <= currentAuction.current_bid) {
          return; // Proxy bidder's max is no longer sufficient
        }

        // Place counter-bid using the service client (bypasses RLS)
        await this.placeBidInternal(
          proxyBid.bidder_id,
          auctionId,
          recalculatedCounterBid,
          proxyBid.max_bid_amount,
          proxyBid.bidder_display_id,
          proxyBid.id, // parent proxy bid id
        );
      } else {
        // Place counter-bid using the service client (bypasses RLS)
        await this.placeBidInternal(
          proxyBid.bidder_id,
          auctionId,
          counterBidAmount,
          proxyBid.max_bid_amount,
          proxyBid.bidder_display_id,
          proxyBid.id, // parent proxy bid id
        );
      }

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
        .select('current_bid, total_bids, unique_bidders')
        .eq('id', auctionId)
        .single();

      if (!statsError && auctionStats) {
        await this.auctionGateway.broadcastBidUpdate(auctionId, {
          amount: amount,
          bidder_display_id: bidderDisplayId,
          current_bid: auctionStats.current_bid,
          total_bids: auctionStats.total_bids,
          unique_bidders: auctionStats.unique_bidders,
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
  async toggleWatchlist(userId: string, watchlistDto: WatchlistDto): Promise<{ watched: boolean }> {
    const { data: existing } = await this.supabase
      .from('auction_watchlist')
      .select('id')
      .eq('user_id', userId)
      .eq('auction_id', watchlistDto.auction_id)
      .single();

    if (existing) {
      // Remove from watchlist
      await this.supabase
        .from('auction_watchlist')
        .delete()
        .eq('id', existing.id);

      return { watched: false };
    } else {
      // Add to watchlist
      await this.supabase
        .from('auction_watchlist')
        .insert({
          user_id: userId,
          auction_id: watchlistDto.auction_id,
          notification_enabled: watchlistDto.notification_enabled ?? true,
        });

      return { watched: true };
    }
  }

  /**
   * Get user's watchlist
   */
  async getUserWatchlist(userId: string, limit = 50): Promise<AuctionWithDetails[]> {
    const { data, error } = await this.supabase
      .from('auction_watchlist')
      .select(`
        auction_id,
        auction_summary (*)
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Database error: ${error.message}`);
    }

    return (data || []).map(item => item.auction_summary).filter(Boolean);
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
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return data || [];
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

    // Check for bids
    const { count } = await this.supabase
      .from('auction_bids')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', auctionId);

    if (count && count > 0) {
      throw new Error('Cannot cancel auction with existing bids. Contact support.');
    }

    // Mark as cancelled
    const { error } = await this.supabase
      .from('auctions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', auctionId);

    if (error) throw error;

    return { message: 'Auction cancelled successfully' };
  }

  async completeAuctionSale(auctionId: string, sellerId: string): Promise<{ success: boolean; transactionId?: string }> {
    // Get auction details
    const auction = await this.findById(auctionId);

    if (auction.status !== 'sold') {
      throw new BadRequestException('Auction is not in sold status');
    }

    if (auction.seller_id !== sellerId) {
      throw new ForbiddenException('Only the seller can complete the sale');
    }

    if (!auction.winner_id || !auction.winning_bid) {
      throw new BadRequestException('No winner found for this auction');
    }

    try {
      // Create auction sale record
      const { data: saleData, error: saleError } = await this.supabase
        .from('auction_sales')
        .insert({
          auction_id: auctionId,
          seller_id: sellerId,
          buyer_id: auction.winner_id,
          final_bid_amount: auction.winning_bid,
          commission_amount: auction.winning_bid * (auction.commission_rate / 100),
          total_amount: auction.winning_bid,
          payment_status: 'pending',
        })
        .select()
        .single();

      if (saleError) {
        throw new Error(`Failed to create sale record: ${saleError.message}`);
      }

      // Process payment through wallet system
      // 1. Transfer from buyer to escrow
      // 2. Calculate and deduct commission
      // 3. Transfer remaining to seller

      const commissionAmount = auction.winning_bid * (auction.commission_rate / 100);
      const sellerAmount = auction.winning_bid - commissionAmount;

      // TODO: Create wallet transaction for auction purchase
      // This would integrate with the existing wallet transaction system

      // Update auction as sale completed
      await this.supabase
        .from('auctions')
        .update({ sale_completed: true })
        .eq('id', auctionId);

      return { success: true, transactionId: saleData.id };

    } catch (error) {
      console.error('Error completing auction sale:', error);
      throw new BadRequestException('Failed to complete auction sale');
    }
  }

  /**
   * Process winning bid payment (called after auction ends)
   */
  async processWinningBidPayment(auctionId: string): Promise<{ success: boolean; message: string }> {
    const auction = await this.findById(auctionId);

    if (!auction.winner_id || !auction.winning_bid) {
      return { success: false, message: 'No winner to process payment for' };
    }

    try {
      // Check if buyer has sufficient balance
      const buyerWallet = await this.walletService.getWallet(auction.winner_id);

      if (buyerWallet.availableBalance < auction.winning_bid) {
        // Mark auction as payment failed
        await this.supabase
          .from('auction_sales')
          .update({ payment_status: 'failed' })
          .eq('auction_id', auctionId);

        return { success: false, message: 'Buyer has insufficient funds' };
      }

      // Create escrow hold for the winning bid amount
      // TODO: Integrate with wallet service to create escrow transaction

      // Update payment status
      await this.supabase
        .from('auction_sales')
        .update({ payment_status: 'paid' })
        .eq('auction_id', auctionId);

      return { success: true, message: 'Payment processed successfully' };

    } catch (error) {
      console.error('Error processing winning bid payment:', error);
      return { success: false, message: 'Payment processing failed' };
    }
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
    const { data: watchedAuctions } = await this.supabase
      .from('auction_watchlist')
      .select('auction_id')
      .eq('user_id', userId)
      .in('auction_id', auctionIds);

    const watchedIds = new Set((watchedAuctions || []).map(w => w.auction_id));

    // Check which auctions user has bid on
    const { data: userBids } = await this.supabase
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
}