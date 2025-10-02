import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import {
  CreateLiveStreamDto,
  UpdateStreamStatusDto,
  PostCommentDto,
  SendReactionDto,
  SendGiftDto,
  LiveProductPurchaseDto,
  LiveServiceBookingDto,
  JoinStreamDto,
  LeaveStreamDto,
  LiveStreamResponse,
  LiveStreamStatsResponse,
  CommentResponse,
  GiftTypeResponse,
  TransactionResponse,
  StreamStatus,
  StreamType,
  TransactionStatus,
  TransactionType,
} from './dto/live-sales.dto';

/**
 * Live Sales Service
 * 
 * Handles all live streaming business logic including:
 * - Stream lifecycle management
 * - Real-time interactions (comments, reactions, gifts)
 * - Live commerce (product sales, service bookings)
 * - Analytics and viewer tracking
 */
@Injectable()
export class LiveSalesService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  // =====================
  // STREAM MANAGEMENT
  // =====================

  /**
   * Get live streams from users the current user is connected to (plugged)
   * Returns streams from connected vendors sorted by recency
   */
  async getPluggedVendorsStreams(userId: string, limit = 10): Promise<LiveStreamResponse[]> {
    try {
      // First get the connected vendor IDs
      const { data: connections, error: connectionsError } = await this.supabase
        .from('user_connections')
        .select('addressee_id')
        .eq('requester_id', userId)
        .eq('status', 'accepted');

      if (connectionsError) throw connectionsError;

      if (!connections || connections.length === 0) {
        return []; // No connections, return empty array
      }

      const connectedVendorIds = connections.map(c => c.addressee_id);

      // Then get live streams from connected vendors
      const { data, error } = await this.supabase
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
          created_at,
          started_at,
          vendor:user_profiles!vendor_id (
            id,
            username,
            avatar_url,
            is_verified
          )
        `)
        .eq('status', 'live')
        .in('vendor_id', connectedVendorIds)
        .order('started_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      return data || [];
    } catch (error) {
      console.error('Error fetching plugged vendors streams:', error);
      throw new BadRequestException('Failed to fetch connected vendors streams');
    }
  }

  /**
   * Get all active live streams for discovery feed
   * Returns streams sorted by viewer count and recency, excluding plugged vendors if requested
   */
  async getActiveStreams(limit = 20, offset = 0, excludePluggedVendors = false, userId?: string): Promise<LiveStreamResponse[]> {
    try {
      let query = this.supabase
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
          created_at,
          started_at,
          vendor:user_profiles!vendor_id (
            id,
            username,
            avatar_url,
            is_verified
          )
        `)
        .eq('status', StreamStatus.LIVE);

      // Exclude plugged vendors if requested
      if (excludePluggedVendors && userId) {
        const { data: connections } = await this.supabase
          .from('user_connections')
          .select('addressee_id')
          .eq('requester_id', userId)
          .eq('status', 'accepted');

        if (connections && connections.length > 0) {
          const connectedVendorIds = connections.map(c => c.addressee_id);
          query = query.not('vendor_id', 'in', `(${connectedVendorIds.join(',')})`);
        }
      }

      const { data, error } = await query
        .order('viewer_count', { ascending: false })
        .order('started_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      return data || [];
    } catch (error) {
      console.error('Error fetching active streams:', error);
      throw new BadRequestException('Failed to fetch live streams');
    }
  }

  /**
   * Get a specific live stream with full details
   */
  async getStreamById(streamId: string, userId?: string): Promise<LiveStreamResponse> {
    try {
      // Get stream details
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
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
          thumbnail_url,
          stream_url,
          started_at,
          ended_at,
          created_at,
          vendor:user_profiles!vendor_id (
            id,
            username,
            avatar_url,
            is_verified
          )
        `)
        .eq('id', streamId)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Live stream not found');
      }

      // Get stream products if it's a product stream
      let products = [];
      if (stream.stream_type === StreamType.PRODUCTS) {
        const { data: productData, error: productError } = await this.supabase
          .from('live_stream_products')
          .select(`
            id,
            product_id,
            live_price,
            live_stock,
            original_stock,
            sold_count,
            display_order,
            is_featured,
            product:products!product_id (
              id,
              name,
              primary_image_url,
              category:product_categories!category_id (
                name
              )
            )
          `)
          .eq('stream_id', streamId)
          .order('display_order');

        if (!productError) {
          products = productData || [];
        }
      }

      // Track viewer join if userId provided
      if (userId && stream.status === StreamStatus.LIVE) {
        await this.joinStream(streamId, userId);
      }

      return {
        ...stream,
        products,
      };
    } catch (error) {
      console.error('Error fetching stream:', error);
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Failed to fetch stream details');
    }
  }

  /**
   * Create a new live stream
   */
  async createStream(vendorId: string, createStreamDto: CreateLiveStreamDto, userToken?: string): Promise<LiveStreamResponse> {
    try {
      console.log('🚀 Creating live stream:', {
        vendorId,
        title: createStreamDto.title,
        stream_type: createStreamDto.stream_type,
        products_count: createStreamDto.products?.length || 0
      });

      // Use user-authenticated client if token provided to respect RLS
      const supabaseClient = userToken
        ? createUserSupabaseClient(this.configService, userToken)
        : this.supabase;

      // Create the stream
      const { data: stream, error: streamError } = await supabaseClient
        .from('live_streams')
        .insert({
          vendor_id: vendorId,
          title: createStreamDto.title,
          description: createStreamDto.description,
          stream_type: createStreamDto.stream_type,
          thumbnail_url: createStreamDto.thumbnail_url,
          status: StreamStatus.SETUP,
        })
        .select()
        .single();

      if (streamError) {
        console.error('❌ Stream creation failed:', streamError);
        throw streamError;
      }

      console.log('✅ Stream created successfully:', stream.id);

      // Add products if provided
      if (createStreamDto.products && createStreamDto.products.length > 0) {
        console.log('📦 Adding products to stream:', createStreamDto.products);

        const productsToInsert = createStreamDto.products.map((product, index) => ({
          stream_id: stream.id,
          product_id: product.product_id,
          live_price: product.live_price,
          live_stock: product.live_stock,
          original_stock: product.live_stock,
          display_order: product.display_order || index,
          is_featured: product.is_featured || false,
        }));

        console.log('📦 Products to insert:', productsToInsert);

        const { error: productError } = await supabaseClient
          .from('live_stream_products')
          .insert(productsToInsert);

        if (productError) {
          console.error('❌ Error adding products to stream:', productError);
          // Don't throw here, just log the error
        } else {
          console.log('✅ Products added successfully');
        }
      }

      return await this.getStreamById(stream.id);
    } catch (error) {
      console.error('Error creating stream:', error);
      throw new BadRequestException('Failed to create live stream');
    }
  }

  /**
   * Update stream status (setup -> live -> ended)
   */
  async updateStreamStatus(
    streamId: string,
    vendorId: string,
    updateStatusDto: UpdateStreamStatusDto,
  ): Promise<LiveStreamResponse> {
    try {
      // Verify ownership
      const { data: stream, error: verifyError } = await this.supabase
        .from('live_streams')
        .select('vendor_id, status')
        .eq('id', streamId)
        .single();

      if (verifyError || !stream) {
        throw new NotFoundException('Live stream not found');
      }

      if (stream.vendor_id !== vendorId) {
        throw new ForbiddenException('You can only manage your own streams');
      }

      // Update status
      const updateData: any = {
        status: updateStatusDto.status,
        updated_at: new Date().toISOString(),
      };

      if (updateStatusDto.status === StreamStatus.LIVE) {
        updateData.started_at = new Date().toISOString();
        updateData.stream_url = updateStatusDto.stream_url;
      } else if (updateStatusDto.status === StreamStatus.ENDED) {
        updateData.ended_at = new Date().toISOString();
      }

      const { error: updateError } = await this.supabase
        .from('live_streams')
        .update(updateData)
        .eq('id', streamId);

      if (updateError) throw updateError;

      return await this.getStreamById(streamId);
    } catch (error) {
      console.error('Error updating stream status:', error);
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new BadRequestException('Failed to update stream status');
    }
  }

  /**
   * End a live stream
   */
  async endStream(streamId: string, vendorId: string): Promise<void> {
    await this.updateStreamStatus(streamId, vendorId, { status: StreamStatus.ENDED });
  }

  // =====================
  // VIEWER MANAGEMENT
  // =====================

  /**
   * Join a live stream as a viewer
   */
  async joinStream(streamId: string, userId: string): Promise<void> {
    try {
      // Check if stream exists and is live
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('status')
        .eq('id', streamId)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Live stream not found');
      }

      if (stream.status !== StreamStatus.LIVE) {
        throw new BadRequestException('Stream is not currently live');
      }

      // Insert or update viewer record
      const { error: viewerError } = await this.supabase
        .from('live_stream_viewers')
        .upsert({
          stream_id: streamId,
          user_id: userId,
          joined_at: new Date().toISOString(),
          left_at: null,
        }, {
          onConflict: 'stream_id,user_id',
        });

      if (viewerError) {
        console.error('Error joining stream:', viewerError);
      }

      // Log analytics
      await this.logAnalytics(streamId, 'viewer_join', 1, { user_id: userId });
    } catch (error) {
      console.error('Error joining stream:', error);
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
    }
  }

  /**
   * Leave a live stream
   */
  async leaveStream(streamId: string, userId: string): Promise<void> {
    try {
      // Update viewer record with leave time
      const { error: updateError } = await this.supabase
        .from('live_stream_viewers')
        .update({
          left_at: new Date().toISOString(),
        })
        .eq('stream_id', streamId)
        .eq('user_id', userId)
        .is('left_at', null);

      if (updateError) {
        console.error('Error leaving stream:', updateError);
      }

      // Log analytics
      await this.logAnalytics(streamId, 'viewer_leave', 1, { user_id: userId });
    } catch (error) {
      console.error('Error leaving stream:', error);
    }
  }

  // =====================
  // REAL-TIME FEATURES
  // =====================

  /**
   * Post a comment to a live stream
   */
  async postComment(userId: string, postCommentDto: PostCommentDto, userToken?: string): Promise<CommentResponse> {
    try {
      // Use user-authenticated client for RLS compliance
      const supabaseClient = userToken
        ? createUserSupabaseClient(this.configService, userToken)
        : this.supabase;

      const { data: comment, error } = await supabaseClient
        .from('live_stream_comments')
        .insert({
          stream_id: postCommentDto.stream_id,
          user_id: userId,
          message: postCommentDto.message,
        })
        .select(`
          id,
          message,
          is_pinned,
          created_at,
          user:user_profiles!user_id (
            id,
            username,
            avatar_url
          )
        `)
        .single();

      if (error) throw error;

      // Log analytics
      await this.logAnalytics(postCommentDto.stream_id, 'comment', 1, {
        user_id: userId,
        message_length: postCommentDto.message.length,
      });

      return comment;
    } catch (error) {
      console.error('Error posting comment:', error);
      throw new BadRequestException('Failed to post comment');
    }
  }

  /**
   * Get comments for a live stream
   */
  async getStreamComments(streamId: string, limit = 50, offset = 0): Promise<CommentResponse[]> {
    try {
      const { data, error } = await this.supabase
        .from('live_stream_comments')
        .select(`
          id,
          message,
          is_pinned,
          created_at,
          user:user_profiles!user_id (
            id,
            username,
            avatar_url
          )
        `)
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching comments:', error);
      throw new BadRequestException('Failed to fetch comments');
    }
  }

  /**
   * Send a reaction to a live stream
   */
  async sendReaction(userId: string, sendReactionDto: SendReactionDto, userToken?: string): Promise<void> {
    try {
      // Use user-authenticated client for RLS compliance
      const supabaseClient = userToken
        ? createUserSupabaseClient(this.configService, userToken)
        : this.supabase;

      const { error } = await supabaseClient
        .from('live_stream_reactions')
        .upsert({
          stream_id: sendReactionDto.stream_id,
          user_id: userId,
          reaction_type: sendReactionDto.reaction_type,
        }, {
          onConflict: 'stream_id,user_id,reaction_type',
        });

      if (error) throw error;

      // Log analytics
      await this.logAnalytics(sendReactionDto.stream_id, 'reaction', 1, {
        user_id: userId,
        reaction_type: sendReactionDto.reaction_type,
      });
    } catch (error) {
      console.error('Error sending reaction:', error);
      throw new BadRequestException('Failed to send reaction');
    }
  }

  // =====================
  // HELPER METHODS
  // =====================

  /**
   * Log analytics events
   */
  private async logAnalytics(
    streamId: string,
    metricType: string,
    metricValue: number = 1,
    metadata: any = {},
  ): Promise<void> {
    try {
      await this.supabase
        .from('live_stream_analytics')
        .insert({
          stream_id: streamId,
          metric_type: metricType,
          metric_value: metricValue,
          metadata,
        });
    } catch (error) {
      // Don't throw errors for analytics failures
      console.error('Analytics logging failed:', error);
    }
  }

  /**
   * Send a gift to a stream vendor with wallet integration
   */
  async sendGift(userId: string, sendGiftDto: SendGiftDto): Promise<TransactionResponse> {
    try {
      console.log('🎁 Processing gift:', {
        sender: userId,
        streamId: sendGiftDto.stream_id,
        giftType: sendGiftDto.gift_type,
        quantity: sendGiftDto.quantity
      });

      // 1. Get stream details and verify it's live
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('vendor_id, status, title')
        .eq('id', sendGiftDto.stream_id)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Live stream not found');
      }

      if (stream.status !== 'live') {
        throw new BadRequestException('Cannot send gifts to inactive streams');
      }

      if (stream.vendor_id === userId) {
        throw new BadRequestException('Cannot send gifts to your own stream');
      }

      // 2. Get gift type details
      const { data: giftType, error: giftError } = await this.supabase
        .from('gift_types')
        .select('id, name, base_value, is_active')
        .eq('name', sendGiftDto.gift_type)
        .eq('is_active', true)
        .single();

      if (giftError || !giftType) {
        throw new NotFoundException('Gift type not found or inactive');
      }

      // 3. Calculate total cost
      const totalCost = giftType.base_value * sendGiftDto.quantity;
      console.log('💰 Gift cost calculation:', {
        baseValue: giftType.base_value,
        quantity: sendGiftDto.quantity,
        totalCost
      });

      // 4. Get sender's wallet
      const { data: senderWallet, error: walletError } = await this.supabase
        .from('wallets')
        .select('id, available_balance')
        .eq('user_id', userId)
        .single();

      if (walletError || !senderWallet) {
        throw new NotFoundException('Sender wallet not found');
      }

      // 5. Check sufficient balance
      if (senderWallet.available_balance < totalCost) {
        throw new BadRequestException('Insufficient wallet balance for gift');
      }

      // 6. Start transaction - deduct from sender
      const { error: deductError } = await this.supabase.rpc(
        'process_wallet_transaction',
        {
          p_user_id: userId,
          p_transaction_type: 'gift_send',
          p_amount: -totalCost, // Negative for deduction
          p_description: `Gift: ${sendGiftDto.quantity}x ${giftType.name} to stream "${stream.title}"`,
          p_reference_id: sendGiftDto.stream_id,
          p_reference_type: 'live_stream_gift'
        }
      );

      if (deductError) {
        console.error('❌ Gift wallet deduction failed:', deductError);
        throw new BadRequestException('Failed to process gift payment');
      }

      // 7. Credit vendor's wallet (platform takes no commission on gifts)
      const { error: creditError } = await this.supabase.rpc(
        'process_wallet_transaction',
        {
          p_user_id: stream.vendor_id,
          p_transaction_type: 'gift_receive',
          p_amount: totalCost, // Positive for credit
          p_description: `Gift received: ${sendGiftDto.quantity}x ${giftType.name} from viewer`,
          p_reference_id: sendGiftDto.stream_id,
          p_reference_type: 'live_stream_gift'
        }
      );

      if (creditError) {
        console.error('❌ Gift vendor credit failed:', creditError);
        // TODO: Implement rollback mechanism for failed credit
        throw new BadRequestException('Failed to credit vendor for gift');
      }

      // 8. Record gift in live stream gifts table
      const { data: giftTransaction, error: giftRecordError } = await this.supabase
        .from('live_stream_gifts')
        .insert({
          stream_id: sendGiftDto.stream_id,
          sender_id: userId,
          gift_type_id: giftType.id,
          quantity: sendGiftDto.quantity,
          unit_value: giftType.base_value,
          total_amount: totalCost,
          message: sendGiftDto.message || null,
        })
        .select()
        .single();

      if (giftRecordError || !giftTransaction) {
        console.error('❌ Gift record failed:', giftRecordError);
        // Note: Payment already processed, just log the error
        throw new BadRequestException('Failed to record gift transaction');
      }

      // 9. Log analytics
      await this.logAnalytics(sendGiftDto.stream_id, 'gift_sent', totalCost, {
        sender_id: userId,
        gift_type: sendGiftDto.gift_type,
        quantity: sendGiftDto.quantity,
        value: totalCost,
      });

      console.log('✅ Gift sent successfully:', {
        sender: userId,
        vendor: stream.vendor_id,
        amount: totalCost,
        gift: `${sendGiftDto.quantity}x ${giftType.name}`
      });

      // Return transaction response
      return {
        id: giftTransaction.id,
        stream_id: sendGiftDto.stream_id,
        transaction_type: TransactionType.GIFT,
        total_amount: totalCost,
        status: TransactionStatus.COMPLETED,
        created_at: new Date().toISOString(),
      };

    } catch (error) {
      console.error('Error sending gift:', error);
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to send gift');
    }
  }

  /**
   * Purchase a product during live stream
   */
  async purchaseProduct(userId: string, purchaseDto: LiveProductPurchaseDto): Promise<TransactionResponse> {
    try {
      console.log('🛒 Processing live product purchase:', {
        buyer: userId,
        streamId: purchaseDto.stream_id,
        productId: purchaseDto.product_id,
        quantity: purchaseDto.quantity,
        continueWatching: purchaseDto.continue_watching
      });

      // 1. Get stream details and verify it's live
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('vendor_id, status, title')
        .eq('id', purchaseDto.stream_id)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Live stream not found');
      }

      if (stream.status !== 'live') {
        throw new BadRequestException('Cannot purchase from inactive streams');
      }

      if (stream.vendor_id === userId) {
        throw new BadRequestException('Cannot purchase from your own stream');
      }

      // 2. Get live stream product details
      const { data: liveProduct, error: productError } = await this.supabase
        .from('live_stream_products')
        .select(`
          id,
          product_id,
          live_price,
          live_stock,
          sold_count,
          product:products!product_id (
            id,
            name,
            description,
            vendor_id
          )
        `)
        .eq('stream_id', purchaseDto.stream_id)
        .eq('product_id', purchaseDto.product_id)
        .single();

      if (productError || !liveProduct) {
        throw new NotFoundException('Product not found in this stream');
      }

      // 3. Check stock availability
      if (liveProduct.live_stock < purchaseDto.quantity) {
        throw new BadRequestException(`Insufficient stock. Only ${liveProduct.live_stock} items available`);
      }

      // 4. Calculate pricing
      const unitPrice = liveProduct.live_price;
      const subtotal = unitPrice * purchaseDto.quantity;
      const platformFeeRate = 0.05; // 5% platform fee
      const platformFee = subtotal * platformFeeRate;
      const vendorAmount = subtotal - platformFee;

      // Calculate delivery fee if rider selected
      let deliveryFee = 0;
      if (purchaseDto.rider_id) {
        deliveryFee = 10.00; // Base delivery fee - could be dynamic
      }

      const totalAmount = subtotal + deliveryFee;

      console.log('💰 Purchase calculation:', {
        unitPrice,
        quantity: purchaseDto.quantity,
        subtotal,
        platformFee,
        vendorAmount,
        deliveryFee,
        totalAmount
      });

      // 5. Get buyer's wallet
      const { data: buyerWallet, error: walletError } = await this.supabase
        .from('wallets')
        .select('id, available_balance')
        .eq('user_id', userId)
        .single();

      if (walletError || !buyerWallet) {
        throw new NotFoundException('Buyer wallet not found');
      }

      // 6. Check sufficient balance
      if (buyerWallet.available_balance < totalAmount) {
        throw new BadRequestException('Insufficient wallet balance for purchase');
      }

      // 7. Start transaction processing
      const transactionId = `live_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Deduct from buyer (to escrow for continue_watching, direct for checkout)
      const buyerTransactionType = purchaseDto.continue_watching ? 'purchase_escrow' : 'purchase_direct';
      const { error: deductError } = await this.supabase.rpc(
        'process_wallet_transaction',
        {
          p_user_id: userId,
          p_transaction_type: buyerTransactionType,
          p_amount: -totalAmount,
          p_description: `Live purchase: ${purchaseDto.quantity}x ${liveProduct.product.name} from "${stream.title}"`,
          p_reference_id: transactionId,
          p_reference_type: 'live_stream_purchase'
        }
      );

      if (deductError) {
        console.error('❌ Purchase wallet deduction failed:', deductError);
        throw new BadRequestException('Failed to process payment');
      }

      // 8. Handle different purchase flows
      if (purchaseDto.continue_watching) {
        // Instant purchase - credit vendor immediately (minus platform fee)
        const { error: vendorCreditError } = await this.supabase.rpc(
          'process_wallet_transaction',
          {
            p_user_id: stream.vendor_id,
            p_transaction_type: 'sale_instant',
            p_amount: vendorAmount,
            p_description: `Live sale: ${purchaseDto.quantity}x ${liveProduct.product.name} (instant)`,
            p_reference_id: transactionId,
            p_reference_type: 'live_stream_sale'
          }
        );

        if (vendorCreditError) {
          console.error('❌ Vendor credit failed:', vendorCreditError);
          // TODO: Implement rollback mechanism
        }

        // Credit platform fee
        if (platformFee > 0) {
          const { error: platformFeeError } = await this.supabase.rpc(
            'process_wallet_transaction',
            {
              p_user_id: 'platform', // Special platform user ID
              p_transaction_type: 'platform_fee',
              p_amount: platformFee,
              p_description: `Platform fee: ${purchaseDto.quantity}x ${liveProduct.product.name}`,
              p_reference_id: transactionId,
              p_reference_type: 'live_stream_fee'
            }
          );

          if (platformFeeError) {
            console.error('❌ Platform fee credit failed:', platformFeeError);
          }
        }
      }
      // For checkout flow, money stays in escrow until order completion

      // 9. Update live stream product stock
      const { error: stockUpdateError } = await this.supabase
        .from('live_stream_products')
        .update({
          live_stock: liveProduct.live_stock - purchaseDto.quantity,
          sold_count: liveProduct.sold_count + purchaseDto.quantity,
        })
        .eq('id', liveProduct.id);

      if (stockUpdateError) {
        console.error('❌ Stock update failed:', stockUpdateError);
        // Continue anyway - stock sync can be corrected later
      }

      // 10. Create transaction record
      const transactionData = {
        id: transactionId,
        stream_id: purchaseDto.stream_id,
        buyer_id: userId,
        transaction_type: TransactionType.PRODUCT,
        product_id: purchaseDto.product_id,
        quantity: purchaseDto.quantity,
        unit_price: unitPrice,
        subtotal: subtotal,
        platform_fee: platformFee,
        delivery_fee: deliveryFee,
        total_amount: totalAmount,
        status: purchaseDto.continue_watching ? TransactionStatus.COMPLETED : TransactionStatus.PENDING,
        rider_id: purchaseDto.rider_id || null,
        delivery_address: purchaseDto.delivery_address || null,
      };

      const { error: transactionError } = await this.supabase
        .from('live_stream_transactions')
        .insert(transactionData);

      if (transactionError) {
        console.error('❌ Transaction record failed:', transactionError);
        // Continue anyway - transaction already processed
      }

      // 11. Log analytics
      await this.logAnalytics(purchaseDto.stream_id, 'product_purchase', totalAmount, {
        buyer_id: userId,
        product_id: purchaseDto.product_id,
        quantity: purchaseDto.quantity,
        unit_price: unitPrice,
        total_amount: totalAmount,
        purchase_type: purchaseDto.continue_watching ? 'instant' : 'checkout',
      });

      console.log('✅ Live product purchase completed:', {
        transactionId,
        buyer: userId,
        vendor: stream.vendor_id,
        product: liveProduct.product.name,
        quantity: purchaseDto.quantity,
        amount: totalAmount,
        type: purchaseDto.continue_watching ? 'instant' : 'checkout'
      });

      // Return transaction details
      return {
        id: transactionId,
        stream_id: purchaseDto.stream_id,
        transaction_type: TransactionType.PRODUCT,
        total_amount: totalAmount,
        status: purchaseDto.continue_watching ? TransactionStatus.COMPLETED : TransactionStatus.PENDING,
        product: {
          id: liveProduct.product_id,
          name: liveProduct.product.name,
          quantity: purchaseDto.quantity,
          unit_price: unitPrice,
        },
        created_at: new Date().toISOString(),
      };

    } catch (error) {
      console.error('Error processing live product purchase:', error);
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to process product purchase');
    }
  }

  /**
   * Book a service during live stream
   */
  async bookService(userId: string, bookingDto: LiveServiceBookingDto): Promise<TransactionResponse> {
    try {
      console.log('📅 Processing live service booking:', {
        customer: userId,
        streamId: bookingDto.stream_id,
        serviceDate: bookingDto.service_date,
        serviceTime: bookingDto.service_time,
        continueWatching: bookingDto.continue_watching
      });

      // 1. Get stream details and verify it's live
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('vendor_id, status, title')
        .eq('id', bookingDto.stream_id)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Live stream not found');
      }

      if (stream.status !== 'live') {
        throw new BadRequestException('Cannot book services from inactive streams');
      }

      if (stream.vendor_id === userId) {
        throw new BadRequestException('Cannot book services from your own stream');
      }

      // 2. Get live stream service details
      const { data: liveService, error: serviceError } = await this.supabase
        .from('live_stream_services')
        .select(`
          id,
          service_id,
          live_price,
          available_slots,
          booking_window_days,
          max_advance_days,
          service:services!service_id (
            id,
            name,
            description,
            duration_minutes,
            location_type,
            vendor_id
          )
        `)
        .eq('stream_id', bookingDto.stream_id)
        .single();

      if (serviceError || !liveService) {
        throw new NotFoundException('Service not found in this stream');
      }

      // 3. Validate booking date and time
      const requestedDateTime = new Date(`${bookingDto.service_date}T${bookingDto.service_time}`);
      const now = new Date();
      const daysDifference = Math.ceil((requestedDateTime.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      // Check if booking is within allowed window
      if (daysDifference < liveService.booking_window_days) {
        throw new BadRequestException(`Bookings must be made at least ${liveService.booking_window_days} days in advance`);
      }

      if (daysDifference > liveService.max_advance_days) {
        throw new BadRequestException(`Bookings cannot be made more than ${liveService.max_advance_days} days in advance`);
      }

      // Check if requested slot is available
      const requestedSlot = liveService.available_slots?.find(slot =>
        slot.date === bookingDto.service_date &&
        slot.time === bookingDto.service_time
      );

      if (!requestedSlot || !requestedSlot.available) {
        throw new BadRequestException('Requested time slot is not available');
      }

      // 4. Calculate pricing
      const servicePrice = liveService.live_price;
      const platformFeeRate = 0.05; // 5% platform fee
      const platformFee = servicePrice * platformFeeRate;
      const vendorAmount = servicePrice - platformFee;

      console.log('💰 Service booking calculation:', {
        servicePrice,
        platformFee,
        vendorAmount,
        totalAmount: servicePrice
      });

      // 5. Get customer's wallet
      const { data: customerWallet, error: walletError } = await this.supabase
        .from('wallets')
        .select('id, available_balance')
        .eq('user_id', userId)
        .single();

      if (walletError || !customerWallet) {
        throw new NotFoundException('Customer wallet not found');
      }

      // 6. Check sufficient balance
      if (customerWallet.available_balance < servicePrice) {
        throw new BadRequestException('Insufficient wallet balance for service booking');
      }

      // 7. Start transaction processing
      const transactionId = `live_svc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Deduct from customer (to escrow - services are always escrowed until completion)
      const { error: deductError } = await this.supabase.rpc(
        'process_wallet_transaction',
        {
          p_user_id: userId,
          p_transaction_type: 'booking_escrow',
          p_amount: -servicePrice,
          p_description: `Service booking: ${liveService.service.name} on ${bookingDto.service_date} ${bookingDto.service_time}`,
          p_reference_id: transactionId,
          p_reference_type: 'live_stream_booking'
        }
      );

      if (deductError) {
        console.error('❌ Service booking wallet deduction failed:', deductError);
        throw new BadRequestException('Failed to process booking payment');
      }

      // 8. Create service booking record
      const bookingData = {
        id: transactionId,
        stream_id: bookingDto.stream_id,
        customer_id: userId,
        service_id: liveService.service_id,
        vendor_id: stream.vendor_id,
        booking_date: bookingDto.service_date,
        booking_time: bookingDto.service_time,
        service_price: servicePrice,
        platform_fee: platformFee,
        total_amount: servicePrice,
        status: 'confirmed',
        special_notes: bookingDto.service_notes || null,
        created_at: new Date().toISOString(),
      };

      const { error: bookingError } = await this.supabase
        .from('service_bookings')
        .insert(bookingData);

      if (bookingError) {
        console.error('❌ Service booking record failed:', bookingError);
        // TODO: Implement rollback mechanism
        throw new BadRequestException('Failed to create booking record');
      }

      // 9. Update available slots to mark as booked
      const updatedSlots = liveService.available_slots?.map(slot => {
        if (slot.date === bookingDto.service_date && slot.time === bookingDto.service_time) {
          return { ...slot, available: false };
        }
        return slot;
      });

      const { error: slotsUpdateError } = await this.supabase
        .from('live_stream_services')
        .update({ available_slots: updatedSlots })
        .eq('id', liveService.id);

      if (slotsUpdateError) {
        console.error('❌ Slots update failed:', slotsUpdateError);
        // Continue anyway - can be corrected manually
      }

      // 10. Create transaction record
      const transactionData = {
        id: transactionId,
        stream_id: bookingDto.stream_id,
        buyer_id: userId,
        transaction_type: TransactionType.SERVICE,
        service_id: liveService.service_id,
        booking_date: bookingDto.service_date,
        booking_time: bookingDto.service_time,
        service_price: servicePrice,
        platform_fee: platformFee,
        total_amount: servicePrice,
        status: TransactionStatus.ESCROW, // Money held in escrow until service completion
        special_notes: bookingDto.service_notes || null,
      };

      const { error: transactionError } = await this.supabase
        .from('live_stream_transactions')
        .insert(transactionData);

      if (transactionError) {
        console.error('❌ Transaction record failed:', transactionError);
        // Continue anyway - transaction already processed
      }

      // 11. Log analytics
      await this.logAnalytics(bookingDto.stream_id, 'service_booking', servicePrice, {
        customer_id: userId,
        service_id: liveService.service_id,
        booking_date: bookingDto.service_date,
        booking_time: bookingDto.service_time,
        service_price: servicePrice,
        booking_type: bookingDto.continue_watching ? 'instant' : 'checkout',
      });

      console.log('✅ Live service booking completed:', {
        transactionId,
        customer: userId,
        vendor: stream.vendor_id,
        service: liveService.service.name,
        date: bookingDto.service_date,
        time: bookingDto.service_time,
        amount: servicePrice
      });

      // Return transaction details
      return {
        id: transactionId,
        stream_id: bookingDto.stream_id,
        transaction_type: TransactionType.SERVICE,
        total_amount: servicePrice,
        status: TransactionStatus.ESCROW,
        service: {
          date: bookingDto.service_date,
          time: bookingDto.service_time,
          notes: bookingDto.service_notes,
        },
        created_at: new Date().toISOString(),
      };

    } catch (error) {
      console.error('Error processing live service booking:', error);
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to process service booking');
    }
  }

  /**
   * Get gift types available for sending
   */
  async getGiftTypes(): Promise<GiftTypeResponse[]> {
    try {
      const { data, error } = await this.supabase
        .from('gift_types')
        .select('*')
        .eq('is_active', true)
        .order('base_value');

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching gift types:', error);
      throw new BadRequestException('Failed to fetch gift types');
    }
  }
}