import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { CreateAuctionDto, PlaceBidDto, AuctionFilterDto, UpdateProxyBidDto, WatchlistDto } from './dto';
import { Auction, AuctionWithDetails, AuctionBid, AuctionCategory, AuctionCategoryWithStats, PublicBidHistoryItem } from './entities';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class AuctionsService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private walletService: WalletService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
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

    // Place the bid
    const bidData = {
      auction_id: placeBidDto.auction_id,
      bidder_id: userId,
      amount: placeBidDto.amount,
      bid_type: placeBidDto.bid_type || 'manual',
      max_bid_amount: placeBidDto.max_bid_amount,
      is_proxy_bid: placeBidDto.bid_type === 'proxy',
    };

    const { data, error } = await client
      .from('auction_bids')
      .insert(bidData)
      .select()
      .single();

    if (error) {
      throw new BadRequestException(`Failed to place bid: ${error.message}`);
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
    // Find user's proxy bid for this auction
    const { data: existingBid, error: findError } = await this.supabase
      .from('auction_bids')
      .select('*')
      .eq('auction_id', auctionId)
      .eq('user_id', userId)
      .eq('bid_type', 'proxy')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (findError && findError.code !== 'PGRST116') throw findError;

    if (existingBid) {
      // Update existing proxy bid
      const { data, error } = await this.supabase
        .from('auction_bids')
        .update({ max_bid_amount: maxBidAmount, updated_at: new Date().toISOString() })
        .eq('id', existingBid.id)
        .select()
        .single();

      if (error) throw error;
      return { message: 'Proxy bid updated successfully', bid: data };
    } else {
      throw new Error('No proxy bid found for this auction. Place a proxy bid first.');
    }
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