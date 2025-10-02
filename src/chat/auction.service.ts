import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import {
  CreateAuctionDto,
  PlaceBidDto,
  AuctionResponseDto,
  AuctionStatus,
} from './dto/chat.dto';

@Injectable()
export class AuctionService {
  private supabase;
  private readonly logger = new Logger(AuctionService.name);

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async createAuction(userId: string, createAuctionDto: CreateAuctionDto, userToken?: string): Promise<AuctionResponseDto> {
    this.logger.log(`Creating auction for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user is participant in conversation
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', createAuctionDto.conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new NotFoundException('Conversation not found or access denied');
      }

      // Validate auction end time
      const endsAt = new Date(createAuctionDto.endsAt);
      const now = new Date();
      if (endsAt <= now) {
        throw new BadRequestException('Auction end time must be in the future');
      }

      // Create message for the auction
      const { data: message, error: messageError } = await client
        .from('chat_messages')
        .insert({
          conversation_id: createAuctionDto.conversationId,
          sender_id: userId,
          message_type: 'auction',
          content: `🔨 Auction: ${createAuctionDto.itemName} - Starting at $${createAuctionDto.startingPrice}`,
        })
        .select('id')
        .single();

      if (messageError) {
        this.logger.error('Failed to create auction message:', messageError);
        throw new Error(`Database error: ${messageError.message}`);
      }

      // Create auction record
      const { data: auction, error: auctionError } = await client
        .from('chat_auctions')
        .insert({
          message_id: message.id,
          seller_id: userId,
          conversation_id: createAuctionDto.conversationId,
          item_name: createAuctionDto.itemName,
          description: createAuctionDto.description,
          starting_price: createAuctionDto.startingPrice,
          current_price: createAuctionDto.startingPrice,
          buy_now_price: createAuctionDto.buyNowPrice,
          status: AuctionStatus.ACTIVE,
          image_urls: JSON.stringify(createAuctionDto.imageUrls),
          category: createAuctionDto.category,
          condition: createAuctionDto.condition,
          location: createAuctionDto.location,
          ends_at: createAuctionDto.endsAt,
          metadata: createAuctionDto.metadata || {},
        })
        .select(`
          id,
          message_id,
          seller_id,
          conversation_id,
          item_name,
          description,
          starting_price,
          current_price,
          buy_now_price,
          status,
          image_urls,
          category,
          condition,
          location,
          ends_at,
          created_at,
          updated_at,
          winner_id,
          total_bids,
          metadata,
          user_profiles!inner (
            id,
            username,
            avatar_url
          )
        `)
        .single();

      if (auctionError) {
        this.logger.error('Failed to create auction:', auctionError);
        // Cleanup message
        await client.from('chat_messages').delete().eq('id', message.id);
        throw new Error(`Database error: ${auctionError.message}`);
      }

      // Schedule auction end job (would use a job queue in production)
      this.scheduleAuctionEnd(auction.id, endsAt);

      this.logger.log(`Auction created successfully: ${auction.id}`);
      return this.mapAuctionResponse(auction, 0);
    } catch (error) {
      this.logger.error('Error creating auction:', error);
      throw error;
    }
  }

  async getAuction(userId: string, auctionId: string, userToken?: string): Promise<AuctionResponseDto> {
    this.logger.log(`Fetching auction: ${auctionId} for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: auction, error } = await client
        .from('chat_auctions')
        .select(`
          id,
          message_id,
          seller_id,
          conversation_id,
          item_name,
          description,
          starting_price,
          current_price,
          buy_now_price,
          status,
          image_urls,
          category,
          condition,
          location,
          ends_at,
          created_at,
          updated_at,
          winner_id,
          total_bids,
          metadata,
          user_profiles!inner (
            id,
            username,
            avatar_url
          ),
          chat_conversations!inner (
            chat_participants!inner (
              user_id
            )
          )
        `)
        .eq('id', auctionId)
        .single();

      if (error || !auction) {
        throw new NotFoundException('Auction not found');
      }

      // Check if user has access to the conversation
      const hasAccess = auction.chat_conversations.chat_participants
        .some(p => p.user_id === userId);

      if (!hasAccess) {
        throw new NotFoundException('Access denied');
      }

      // Get highest bid
      const { data: highestBid } = await client
        .from('auction_bids')
        .select(`
          id,
          bidder_id,
          bid_amount,
          placed_at,
          user_profiles!inner (
            id,
            username
          )
        `)
        .eq('auction_id', auctionId)
        .eq('is_winning', true)
        .single();

      // Get user's bid count
      const { count: userBidCount } = await client
        .from('auction_bids')
        .select('id', { count: 'exact' })
        .eq('auction_id', auctionId)
        .eq('bidder_id', userId);

      const auctionResponse = this.mapAuctionResponse(auction, userBidCount || 0);
      if (highestBid) {
        auctionResponse.highestBid = {
          id: highestBid.id,
          bidderId: highestBid.bidder_id,
          bidAmount: highestBid.bid_amount,
          placedAt: highestBid.placed_at,
          bidder: {
            id: highestBid.user_profiles.id,
            username: highestBid.user_profiles.username,
          },
        };
      }

      return auctionResponse;
    } catch (error) {
      this.logger.error('Error fetching auction:', error);
      throw error;
    }
  }

  async placeBid(userId: string, placeBidDto: PlaceBidDto, userToken?: string): Promise<AuctionResponseDto> {
    this.logger.log(`User ${userId} placing bid on auction: ${placeBidDto.auctionId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get auction details and verify access
      const { data: auction, error: auctionError } = await client
        .from('chat_auctions')
        .select(`
          id,
          seller_id,
          conversation_id,
          current_price,
          buy_now_price,
          status,
          ends_at,
          chat_conversations!inner (
            chat_participants!inner (
              user_id
            )
          )
        `)
        .eq('id', placeBidDto.auctionId)
        .single();

      if (auctionError || !auction) {
        throw new NotFoundException('Auction not found');
      }

      // Check access
      const hasAccess = auction.chat_conversations.chat_participants
        .some(p => p.user_id === userId);

      if (!hasAccess) {
        throw new BadRequestException('Access denied');
      }

      // Validate auction status
      if (auction.status !== AuctionStatus.ACTIVE) {
        throw new BadRequestException('Auction is not active');
      }

      // Check if auction has ended
      const now = new Date();
      const endsAt = new Date(auction.ends_at);
      if (now >= endsAt) {
        throw new BadRequestException('Auction has ended');
      }

      // Prevent seller from bidding on own auction
      if (auction.seller_id === userId) {
        throw new BadRequestException('Cannot bid on your own auction');
      }

      // Validate bid amount
      const minBidAmount = auction.current_price + 1; // Minimum increment of $1
      if (placeBidDto.bidAmount < minBidAmount) {
        throw new BadRequestException(`Bid must be at least $${minBidAmount}`);
      }

      // Check buy now price
      if (auction.buy_now_price && placeBidDto.bidAmount >= auction.buy_now_price) {
        return this.processBuyNow(userId, placeBidDto.auctionId, userToken);
      }

      // Mark previous winning bids as not winning
      await client
        .from('auction_bids')
        .update({ is_winning: false })
        .eq('auction_id', placeBidDto.auctionId)
        .eq('is_winning', true);

      // Place the bid
      const { data: bid, error: bidError } = await client
        .from('auction_bids')
        .insert({
          auction_id: placeBidDto.auctionId,
          bidder_id: userId,
          bid_amount: placeBidDto.bidAmount,
          is_auto_bid: placeBidDto.isAutoBid || false,
          max_auto_bid: placeBidDto.maxAutoBid,
          is_winning: true,
        })
        .select('id')
        .single();

      if (bidError) {
        this.logger.error('Failed to place bid:', bidError);
        throw new Error(`Database error: ${bidError.message}`);
      }

      // Update auction current price and bid count
      const { data: updatedAuction, error: updateError } = await client
        .from('chat_auctions')
        .update({
          current_price: placeBidDto.bidAmount,
          total_bids: auction.total_bids + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', placeBidDto.auctionId)
        .select(`
          id,
          message_id,
          seller_id,
          conversation_id,
          item_name,
          description,
          starting_price,
          current_price,
          buy_now_price,
          status,
          image_urls,
          category,
          condition,
          location,
          ends_at,
          created_at,
          updated_at,
          winner_id,
          total_bids,
          metadata,
          user_profiles!inner (
            id,
            username,
            avatar_url
          )
        `)
        .single();

      if (updateError) {
        this.logger.error('Failed to update auction:', updateError);
        throw new Error(`Database error: ${updateError.message}`);
      }

      // Send notification to auction participants
      await this.notifyAuctionUpdate(placeBidDto.auctionId, 'new_bid', {
        bidderName: userId,
        bidAmount: placeBidDto.bidAmount,
      });

      // Handle auto-bidding logic
      if (placeBidDto.isAutoBid && placeBidDto.maxAutoBid) {
        this.handleAutoBidding(placeBidDto.auctionId, userId, placeBidDto.maxAutoBid);
      }

      this.logger.log(`Bid placed successfully: ${bid.id}`);
      return this.mapAuctionResponse(updatedAuction, 1);
    } catch (error) {
      this.logger.error('Error placing bid:', error);
      throw error;
    }
  }

  async getAuctionBids(userId: string, auctionId: string, userToken?: string): Promise<any[]> {
    this.logger.log(`Fetching bids for auction: ${auctionId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user has access to the auction
      const auction = await this.getAuction(userId, auctionId, userToken);

      const { data: bids, error } = await client
        .from('auction_bids')
        .select(`
          id,
          bidder_id,
          bid_amount,
          is_auto_bid,
          placed_at,
          is_winning,
          user_profiles!inner (
            id,
            username,
            avatar_url
          )
        `)
        .eq('auction_id', auctionId)
        .order('bid_amount', { ascending: false });

      if (error) {
        throw new Error(`Database error: ${error.message}`);
      }

      return bids?.map(bid => ({
        id: bid.id,
        bidderId: bid.bidder_id,
        bidAmount: bid.bid_amount,
        isAutoBid: bid.is_auto_bid,
        placedAt: bid.placed_at,
        isWinning: bid.is_winning,
        bidder: {
          id: bid.user_profiles.id,
          username: auction.seller.id === userId ? bid.user_profiles.username : this.anonymizeBidder(bid.user_profiles.username),
          avatarUrl: bid.user_profiles.avatar_url,
        },
      })) || [];
    } catch (error) {
      this.logger.error('Error fetching auction bids:', error);
      throw error;
    }
  }

  async getConversationAuctions(userId: string, conversationId: string, userToken?: string): Promise<AuctionResponseDto[]> {
    this.logger.log(`Fetching auctions for conversation: ${conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user has access to conversation
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new NotFoundException('Conversation not found or access denied');
      }

      const { data: auctions, error } = await client
        .from('chat_auctions')
        .select(`
          id,
          message_id,
          seller_id,
          conversation_id,
          item_name,
          description,
          starting_price,
          current_price,
          buy_now_price,
          status,
          image_urls,
          category,
          condition,
          location,
          ends_at,
          created_at,
          updated_at,
          winner_id,
          total_bids,
          metadata,
          user_profiles!inner (
            id,
            username,
            avatar_url
          )
        `)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Database error: ${error.message}`);
      }

      // Get user bid counts for each auction
      const auctionIds = auctions.map(a => a.id);
      const { data: userBids } = await client
        .from('auction_bids')
        .select('auction_id')
        .in('auction_id', auctionIds)
        .eq('bidder_id', userId);

      const bidCounts = userBids?.reduce((acc, bid) => {
        acc[bid.auction_id] = (acc[bid.auction_id] || 0) + 1;
        return acc;
      }, {}) || {};

      return auctions.map(auction => this.mapAuctionResponse(auction, bidCounts[auction.id] || 0));
    } catch (error) {
      this.logger.error('Error fetching conversation auctions:', error);
      throw error;
    }
  }

  async endAuction(auctionId: string): Promise<void> {
    this.logger.log(`Ending auction: ${auctionId}`);

    try {
      // Get auction details
      const { data: auction, error: auctionError } = await this.supabase
        .from('chat_auctions')
        .select(`
          id,
          seller_id,
          current_price,
          status,
          conversation_id,
          item_name
        `)
        .eq('id', auctionId)
        .single();

      if (auctionError || !auction || auction.status !== AuctionStatus.ACTIVE) {
        this.logger.warn(`Auction ${auctionId} not found or not active`);
        return;
      }

      // Get winning bid
      const { data: winningBid } = await this.supabase
        .from('auction_bids')
        .select('bidder_id')
        .eq('auction_id', auctionId)
        .eq('is_winning', true)
        .single();

      // Update auction status
      const { error: updateError } = await this.supabase
        .from('chat_auctions')
        .update({
          status: AuctionStatus.ENDED,
          winner_id: winningBid?.bidder_id || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', auctionId);

      if (updateError) {
        this.logger.error('Failed to update auction status:', updateError);
        return;
      }

      // Send notifications
      await this.notifyAuctionUpdate(auctionId, 'auction_ended', {
        winnerId: winningBid?.bidder_id,
        finalPrice: auction.current_price,
      });

      // Create system message in conversation
      await this.supabase
        .from('chat_messages')
        .insert({
          conversation_id: auction.conversation_id,
          sender_id: auction.seller_id,
          message_type: 'system',
          content: winningBid 
            ? `🎉 Auction ended! "${auction.item_name}" sold for $${auction.current_price}`
            : `⏰ Auction ended! "${auction.item_name}" - No bids received`,
        });

      this.logger.log(`Auction ${auctionId} ended successfully`);
    } catch (error) {
      this.logger.error('Error ending auction:', error);
    }
  }

  async cancelAuction(userId: string, auctionId: string, userToken?: string): Promise<void> {
    this.logger.log(`Cancelling auction: ${auctionId} by user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user owns the auction
      const { data: auction } = await client
        .from('chat_auctions')
        .select('seller_id, status, total_bids, conversation_id, item_name')
        .eq('id', auctionId)
        .single();

      if (!auction) {
        throw new NotFoundException('Auction not found');
      }

      if (auction.seller_id !== userId) {
        throw new BadRequestException('Access denied - you can only cancel your own auctions');
      }

      if (auction.status !== AuctionStatus.ACTIVE) {
        throw new BadRequestException('Auction is not active');
      }

      // Don't allow cancellation if there are bids
      if (auction.total_bids > 0) {
        throw new BadRequestException('Cannot cancel auction with existing bids');
      }

      // Update auction status
      const { error: updateError } = await client
        .from('chat_auctions')
        .update({
          status: AuctionStatus.CANCELLED,
          updated_at: new Date().toISOString(),
        })
        .eq('id', auctionId);

      if (updateError) {
        throw new Error(`Failed to cancel auction: ${updateError.message}`);
      }

      // Create system message
      await client
        .from('chat_messages')
        .insert({
          conversation_id: auction.conversation_id,
          sender_id: userId,
          message_type: 'system',
          content: `❌ Auction cancelled: "${auction.item_name}"`,
        });

      this.logger.log(`Auction ${auctionId} cancelled successfully`);
    } catch (error) {
      this.logger.error('Error cancelling auction:', error);
      throw error;
    }
  }

  // Private helper methods
  private async processBuyNow(userId: string, auctionId: string, userToken?: string): Promise<AuctionResponseDto> {
    this.logger.log(`Processing buy now for auction: ${auctionId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: auction } = await client
        .from('chat_auctions')
        .select('buy_now_price, conversation_id, item_name, seller_id')
        .eq('id', auctionId)
        .single();

      if (!auction?.buy_now_price) {
        throw new BadRequestException('Buy now price not set');
      }

      // Create winning bid at buy now price
      await client
        .from('auction_bids')
        .update({ is_winning: false })
        .eq('auction_id', auctionId);

      await client
        .from('auction_bids')
        .insert({
          auction_id: auctionId,
          bidder_id: userId,
          bid_amount: auction.buy_now_price,
          is_winning: true,
        });

      // End auction immediately
      await client
        .from('chat_auctions')
        .update({
          status: AuctionStatus.ENDED,
          current_price: auction.buy_now_price,
          winner_id: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', auctionId);

      // Create system message
      await client
        .from('chat_messages')
        .insert({
          conversation_id: auction.conversation_id,
          sender_id: auction.seller_id,
          message_type: 'system',
          content: `🎉 "${auction.item_name}" sold via Buy Now for $${auction.buy_now_price}!`,
        });

      return this.getAuction(userId, auctionId, userToken);
    } catch (error) {
      this.logger.error('Error processing buy now:', error);
      throw error;
    }
  }

  private scheduleAuctionEnd(auctionId: string, endsAt: Date): void {
    // In production, this would use a job queue like Bull or Agenda
    // For now, use simple setTimeout (not recommended for production)
    const delay = endsAt.getTime() - Date.now();
    
    if (delay > 0) {
      setTimeout(() => {
        this.endAuction(auctionId);
      }, delay);
      
      this.logger.log(`Scheduled auction ${auctionId} to end at ${endsAt.toISOString()}`);
    }
  }

  private async handleAutoBidding(auctionId: string, userId: string, maxBid: number): Promise<void> {
    // Auto-bidding logic would be implemented here
    // This is a complex feature that involves competing auto-bids
    this.logger.log(`Auto-bidding setup for user ${userId} on auction ${auctionId} with max bid $${maxBid}`);
  }

  private async notifyAuctionUpdate(auctionId: string, eventType: string, data: any): Promise<void> {
    // This would send real-time notifications to auction participants
    this.logger.log(`Notifying auction ${auctionId} participants of ${eventType}:`, data);
  }

  private anonymizeBidder(username: string): string {
    // Anonymize bidder names for privacy (except for seller view)
    if (username.length <= 3) return username;
    return username.charAt(0) + '*'.repeat(username.length - 2) + username.charAt(username.length - 1);
  }

  private mapAuctionResponse(auction: any, userBidCount: number = 0): AuctionResponseDto {
    return {
      id: auction.id,
      messageId: auction.message_id,
      sellerId: auction.seller_id,
      conversationId: auction.conversation_id,
      itemName: auction.item_name,
      description: auction.description,
      startingPrice: auction.starting_price,
      currentPrice: auction.current_price,
      buyNowPrice: auction.buy_now_price,
      status: auction.status,
      imageUrls: typeof auction.image_urls === 'string' 
        ? JSON.parse(auction.image_urls) 
        : auction.image_urls || [],
      category: auction.category,
      condition: auction.condition,
      location: auction.location,
      endsAt: auction.ends_at,
      createdAt: auction.created_at,
      updatedAt: auction.updated_at,
      winnerId: auction.winner_id,
      totalBids: auction.total_bids,
      seller: {
        id: auction.user_profiles.id,
        username: auction.user_profiles.username,
        avatarUrl: auction.user_profiles.avatar_url,
      },
      userBidCount,
      metadata: auction.metadata,
    };
  }
}