import { Injectable, BadRequestException, NotFoundException, ForbiddenException, HttpException, HttpStatus, Inject, forwardRef, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { EscrowService } from '../escrow/escrow.service';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletTransactionType } from '../wallet/constants/transaction-types';
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
 * - Escrow-protected payments for live purchases
 */
@Injectable()
export class LiveSalesService {
  private readonly logger = new Logger(LiveSalesService.name);
  private supabase;
  private readonly PLATFORM_COMMISSION_RATE: number;
  
  // Performance metrics
  private performanceMetrics = {
    purchaseCount: 0,
    purchaseTotal: 0,
    purchaseErrors: 0,
    averagePurchaseTime: 0,
    stockReservations: 0,
    stockReservationExpirations: 0,
  };

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
    private notificationHelper: NotificationHelperService,
    private walletService: WalletService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    this.PLATFORM_COMMISSION_RATE = parseFloat(
      this.configService.get<string>('PLATFORM_COMMISSION_RATE', '0.1')
    );
    this.logger.log('LiveSalesService initialized');
  }

  /**
   * Log structured event with context
   */
  private logEvent(
    level: 'log' | 'warn' | 'error' | 'debug',
    event: string,
    context: Record<string, any>,
    error?: Error,
  ): void {
    const logData = {
      timestamp: new Date().toISOString(),
      service: 'LiveSalesService',
      event,
      context,
      ...(error && {
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      }),
    };

    switch (level) {
      case 'log':
        this.logger.log(JSON.stringify(logData));
        break;
      case 'warn':
        this.logger.warn(JSON.stringify(logData));
        break;
      case 'error':
        this.logger.error(JSON.stringify(logData));
        break;
      case 'debug':
        this.logger.debug(JSON.stringify(logData));
        break;
    }
  }

  /**
   * Log performance metric
   */
  private logPerformance(operation: string, duration: number, metadata?: Record<string, any>): void {
    this.logger.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'LiveSalesService',
      type: 'performance',
      operation,
      duration,
      metadata,
    }));
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics() {
    return {
      ...this.performanceMetrics,
      timestamp: new Date().toISOString(),
    };
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
      this.logEvent('error', 'fetch_plugged_vendors_failed', {}, error instanceof Error ? error : new Error(String(error)));
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
      this.logEvent('error', 'fetch_active_streams_failed', {}, error instanceof Error ? error : new Error(String(error)));
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
      this.logEvent('error', 'fetch_stream_failed', {
        streamId,
        userId,
      }, error instanceof Error ? error : new Error(String(error)));
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Failed to fetch stream details');
    }
  }

  /**
   * Create a new live stream
   */
  async createStream(vendorId: string, createStreamDto: CreateLiveStreamDto, userToken?: string): Promise<LiveStreamResponse> {
    try {
      this.logEvent('log', 'creating_live_stream', {
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
        this.logEvent('error', 'stream_creation_failed', {
          vendorId,
        }, streamError instanceof Error ? streamError : new Error(String(streamError)));
        throw streamError;
      }

      this.logEvent('log', 'stream_created_successfully', {
        streamId: stream.id,
        vendorId,
      });

      // Add products if provided
      if (createStreamDto.products && createStreamDto.products.length > 0) {
        this.logEvent('log', 'adding_products_to_stream', {
        streamId: stream.id,
        vendorId,
        productCount: createStreamDto.products?.length || 0,
      });

        const productsToInsert = createStreamDto.products.map((product, index) => ({
          stream_id: stream.id,
          product_id: product.product_id,
          live_price: product.live_price,
          live_stock: product.live_stock,
          original_stock: product.live_stock,
          display_order: product.display_order || index,
          is_featured: product.is_featured || false,
        }));

        this.logEvent('debug', 'products_to_insert', {
          streamId: stream.id,
          vendorId,
          productsToInsert,
        });

        const { error: productError } = await supabaseClient
          .from('live_stream_products')
          .insert(productsToInsert);

        if (productError) {
          this.logEvent('error', 'error_adding_products_to_stream', {
            streamId: stream.id,
            vendorId,
            error: productError.message,
          });
          // Don't throw here, just log the error
        } else {
          this.logEvent('log', 'products_added_successfully', {
            streamId: stream.id,
            vendorId,
            productCount: productsToInsert.length,
          });
        }
      }

      return await this.getStreamById(stream.id);
    } catch (error) {
      this.logEvent('error', 'stream_creation_exception', {
        vendorId,
      }, error instanceof Error ? error : new Error(String(error)));
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
      this.logEvent('error', 'stream_status_update_exception', {
        streamId,
        vendorId,
      }, error instanceof Error ? error : new Error(String(error)));
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
        this.logEvent('error', 'stream_join_viewer_record_failed', {
          streamId,
          userId,
          error: viewerError.message,
        });
      }

      // Log analytics
      await this.logAnalytics(streamId, 'viewer_join', 1, { user_id: userId });
    } catch (error) {
      this.logEvent('error', 'stream_join_exception', {
        streamId,
        userId,
      }, error instanceof Error ? error : new Error(String(error)));
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
        this.logEvent('error', 'stream_leave_viewer_update_failed', {
          streamId,
          userId,
          error: updateError.message,
        });
      }

      // Log analytics
      await this.logAnalytics(streamId, 'viewer_leave', 1, { user_id: userId });
    } catch (error) {
      this.logEvent('error', 'stream_leave_exception', {
        streamId,
        userId,
      }, error instanceof Error ? error : new Error(String(error)));
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
      this.logEvent('error', 'post_comment_exception', {
        streamId: postCommentDto.stream_id,
        userId,
      }, error instanceof Error ? error : new Error(String(error)));
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
      this.logEvent('error', 'fetch_comments_exception', {
        streamId,
      }, error instanceof Error ? error : new Error(String(error)));
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
      this.logEvent('error', 'send_reaction_exception', {
        streamId: sendReactionDto.stream_id,
        userId,
      }, error instanceof Error ? error : new Error(String(error)));
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
      this.logEvent('warn', 'analytics_logging_failed', {
        streamId,
        metricType,
        metricValue,
        metadata,
      }, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Send a gift to a stream vendor with wallet integration
   */
  async sendGift(userId: string, sendGiftDto: SendGiftDto): Promise<TransactionResponse> {
    // Input validation
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new BadRequestException('Invalid user ID');
    }

    if (!sendGiftDto.stream_id || typeof sendGiftDto.stream_id !== 'string') {
      throw new BadRequestException('Invalid stream ID');
    }

    if (!sendGiftDto.gift_type || typeof sendGiftDto.gift_type !== 'string') {
      throw new BadRequestException('Invalid gift type');
    }

    if (!sendGiftDto.quantity || typeof sendGiftDto.quantity !== 'number' ||
        sendGiftDto.quantity < 1 || sendGiftDto.quantity > 10) {
      throw new BadRequestException('Gift quantity must be between 1 and 10');
    }

    try {
      const giftId = `gift_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      this.logEvent('log', 'gift_processing_started', {
        giftId,
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
      this.logEvent('log', 'gift_cost_calculation', {
        giftId,
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

      // 6. Start transaction - deduct from sender (using fee_deduction for direct transfer)
      const deductResult = await this.walletService.processWalletTransaction(
        userId,
        WalletTransactionType.FEE_DEDUCTION, // ✅ FIX: Use valid transaction type (gifts are direct transfers, not escrow)
        totalCost, // Helper handles negative internally for debits
        `Gift: ${sendGiftDto.quantity}x ${giftType.name} to stream "${stream.title}"`,
        sendGiftDto.stream_id,
        'live_stream_gift',
      );

      if (!deductResult.success) {
        this.logEvent('error', 'gift_wallet_deduction_failed', {
          giftId,
          senderId: userId,
          amount: totalCost,
          error: deductResult.error,
        });
        throw new BadRequestException(`Failed to process gift payment: ${deductResult.error}`);
      }

      // 7. Credit vendor's wallet (platform takes no commission on gifts)
      // Note: fee_deduction doesn't support negative amounts, so we use reward_credit for the vendor
      const creditResult = await this.walletService.processWalletTransaction(
        stream.vendor_id,
        WalletTransactionType.REWARD_CREDIT, // ✅ FIX: Use valid transaction type for direct credit
        totalCost,
        `Gift received: ${sendGiftDto.quantity}x ${giftType.name} from viewer`,
        sendGiftDto.stream_id,
        'live_stream_gift',
      );

      if (!creditResult.success) {
        this.logEvent('error', 'gift_vendor_credit_failed', {
          giftId,
          vendorId: stream.vendor_id,
          amount: totalCost,
          error: creditResult.error,
        });

        // CRITICAL: Rollback buyer's payment since vendor credit failed
        try {
          const refundResult = await this.walletService.processWalletTransaction(
            userId,
            WalletTransactionType.ADMIN_ADJUSTMENT, // Refund back to available balance
            totalCost,
            `Gift refund: Vendor credit failed for ${giftType.name} gift`,
            sendGiftDto.stream_id,
            'gift_refund',
          );

          if (!refundResult.success) {
            this.logEvent('error', 'gift_refund_failed_critical', {
              giftId,
              senderId: userId,
              vendorId: stream.vendor_id,
              amount: totalCost,
              creditError: creditResult.error,
              refundError: refundResult.error,
            });
            throw new HttpException(
              `Gift payment processed but vendor credit failed. Refund also failed. Manual intervention required. Amount: ${totalCost}`,
              HttpStatus.INTERNAL_SERVER_ERROR
            );
          }

          this.logEvent('warn', 'gift_rolled_back_successfully', {
            giftId,
            senderId: userId,
            vendorId: stream.vendor_id,
            amount: totalCost,
            reason: 'Vendor credit failure',
          });

        } catch (rollbackError) {
          this.logEvent('error', 'gift_rollback_exception', {
            giftId,
            senderId: userId,
            vendorId: stream.vendor_id,
            amount: totalCost,
          }, rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
          throw new HttpException(
            `Gift payment processed but vendor credit failed. Rollback exception occurred. Manual intervention required.`,
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }

        throw new BadRequestException(`Failed to credit vendor for gift. Your payment has been refunded.`);
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
        this.logEvent('error', 'gift_record_failed', {
          giftId,
          senderId: userId,
          vendorId: stream.vendor_id,
          amount: totalCost,
          error: giftRecordError?.message || 'Gift transaction not returned',
        });
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

      this.logEvent('log', 'gift_sent_successfully', {
        giftId,
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
      this.logEvent('error', 'send_gift_exception', {
        streamId: sendGiftDto.stream_id,
        userId,
        giftType: sendGiftDto.gift_type,
        quantity: sendGiftDto.quantity,
      }, error instanceof Error ? error : new Error(String(error)));
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
    const startTime = Date.now();
    const purchaseId = `purchase_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Input validation
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new BadRequestException('Invalid user ID');
    }

    if (!purchaseDto.stream_id || typeof purchaseDto.stream_id !== 'string') {
      throw new BadRequestException('Invalid stream ID');
    }

    if (!purchaseDto.product_id || typeof purchaseDto.product_id !== 'string') {
      throw new BadRequestException('Invalid product ID');
    }

    if (!purchaseDto.quantity || typeof purchaseDto.quantity !== 'number' ||
        purchaseDto.quantity < 1 || purchaseDto.quantity > 99) {
      throw new BadRequestException('Quantity must be between 1 and 99');
    }

    if (purchaseDto.delivery_address && typeof purchaseDto.delivery_address !== 'string') {
      throw new BadRequestException('Invalid delivery address format');
    }

    if (purchaseDto.rider_id && typeof purchaseDto.rider_id !== 'string') {
      throw new BadRequestException('Invalid rider ID format');
    }

    if (purchaseDto.continue_watching !== undefined &&
        typeof purchaseDto.continue_watching !== 'boolean') {
      throw new BadRequestException('Continue watching must be a boolean');
    }

    this.logEvent('log', 'purchase_initiated', {
      purchaseId,
      userId,
      streamId: purchaseDto.stream_id,
      productId: purchaseDto.product_id,
      quantity: purchaseDto.quantity,
    });

    try {
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

      // 3. Check for duplicate purchase (idempotency) - BEFORE stock deduction
      // Prevent duplicate purchases within last 30 seconds for same product and quantity
      // Increased window to account for slow networks and retries
      const duplicateCheckWindowMs = this.configService.get<number>('LIVE_SALES_DUPLICATE_WINDOW_MS') || 30000; // Default 30 seconds
      const duplicateCheckWindow = new Date(Date.now() - duplicateCheckWindowMs).toISOString();

      // Check for recent orders with same product and quantity
      const { data: recentOrders, error: duplicateError } = await this.supabase
        .from('orders')
        .select('id, order_number, status, created_at, metadata')
        .eq('buyer_id', userId)
        .eq('vendor_id', stream.vendor_id)
        .eq('source', 'live_stream')
        .in('status', ['pending', 'paid', 'processing']) // Check active orders
        .gte('created_at', duplicateCheckWindow) // Within configured window
        .order('created_at', { ascending: false });

      if (duplicateError) {
        this.logEvent('warn', 'duplicate_check_failed', {
          purchaseId,
          userId,
          streamId: purchaseDto.stream_id,
          productId: purchaseDto.product_id,
          error: duplicateError.message,
        });
        // Continue anyway - duplicate check is defensive
      }

      // Check each recent order for matching product and quantity
      if (recentOrders && recentOrders.length > 0) {
        for (const recentOrder of recentOrders) {
          // Check order items for matching product and quantity
          const { data: matchingOrderItem } = await this.supabase
            .from('order_items')
            .select('product_id, quantity')
            .eq('order_id', recentOrder.id)
            .eq('product_id', purchaseDto.product_id)
            .eq('quantity', purchaseDto.quantity)
            .maybeSingle();

          if (matchingOrderItem) {
            const timeSinceOrder = Date.now() - new Date(recentOrder.created_at).getTime();
            this.logEvent('log', 'duplicate_purchase_detected', {
              purchaseId,
              userId,
              streamId: purchaseDto.stream_id,
              productId: purchaseDto.product_id,
              quantity: purchaseDto.quantity,
              recentOrderId: recentOrder.id,
              recentOrderNumber: recentOrder.order_number,
              timeSinceOrder,
            });

            // Return existing order details (idempotent response)
            // No stock was deducted, so no restoration needed
            return {
              id: recentOrder.metadata?.transaction_id || `dup_${recentOrder.id}`,
              stream_id: purchaseDto.stream_id,
              transaction_type: TransactionType.PRODUCT,
              total_amount: recentOrder.metadata?.subtotal || recentOrder.total_amount,
              status: TransactionStatus.PENDING, // All purchases go through escrow
              product: {
                id: purchaseDto.product_id,
                name: liveProduct.product.name,
                quantity: matchingOrderItem.quantity,
                unit_price: liveProduct.live_price,
              },
              created_at: recentOrder.created_at,
            };
          }
        }
      }

      // 3.1. Check for active reservation (optional - if user has reservation, confirm it)
      // This validates that reservation matches purchase and is still valid
      if (purchaseDto.reservation_id) {
        const { data: reservation, error: reservationError } = await this.supabase
          .from('live_stream_stock_reservations')
          .select('id, user_id, quantity, status, expires_at, product_id')
          .eq('id', purchaseDto.reservation_id)
          .eq('user_id', userId)
          .eq('product_id', purchaseDto.product_id)
          .eq('status', 'active')
          .single();

        if (reservationError || !reservation) {
          this.logEvent('warn', 'invalid_reservation', {
            purchaseId,
            userId,
            reservationId: purchaseDto.reservation_id,
            error: reservationError?.message || 'Reservation not found',
          });
          // Continue without reservation - reservation is optional
        } else if (new Date(reservation.expires_at) < new Date()) {
          this.logEvent('warn', 'expired_reservation', {
            purchaseId,
            userId,
            reservationId: purchaseDto.reservation_id,
            expiresAt: reservation.expires_at,
          });
          // Reservation expired - continue without it
        } else if (reservation.quantity !== purchaseDto.quantity) {
          this.logEvent('warn', 'reservation_quantity_mismatch', {
            purchaseId,
            userId,
            reservationId: purchaseDto.reservation_id,
            reservationQuantity: reservation.quantity,
            purchaseQuantity: purchaseDto.quantity,
          });
          // Quantity mismatch - continue without reservation
        }
        // If reservation is valid, it will be confirmed after successful purchase
      }

      // 4. Atomically update stock (check + update in single operation)
      // This prevents race conditions where multiple users purchase simultaneously
      const stockUpdateResult = await this.supabase.rpc('update_live_stream_stock_atomic', {
        p_live_product_id: liveProduct.id,
        p_quantity: purchaseDto.quantity,
      });

      if (stockUpdateResult.error || !stockUpdateResult.data?.success) {
        const errorMessage = stockUpdateResult.data?.error || stockUpdateResult.error?.message || 'Failed to update stock';
        const errorCode = stockUpdateResult.data?.error_code || 'STOCK_UPDATE_FAILED';
        
        this.logEvent('error', 'stock_update_failed', {
          purchaseId,
          userId,
          productId: liveProduct.id,
          requestedQuantity: purchaseDto.quantity,
          error: errorMessage,
          errorCode,
          availableStock: stockUpdateResult.data?.available_stock,
        });

        if (errorCode === 'INSUFFICIENT_STOCK') {
          throw new BadRequestException(
            stockUpdateResult.data?.error || `Insufficient stock. Only ${stockUpdateResult.data?.available_stock || 0} items available`
          );
        } else if (errorCode === 'PRODUCT_NOT_FOUND') {
          throw new NotFoundException('Live stream product not found');
        } else {
          throw new BadRequestException(`Stock update failed: ${errorMessage}`);
        }
      }

      // Stock successfully updated atomically
      const updatedStockData = stockUpdateResult.data;
      this.logEvent('log', 'stock_updated', {
        purchaseId,
        productId: liveProduct.id,
        oldStock: updatedStockData.old_stock,
        newStock: updatedStockData.new_stock,
        quantityDeducted: updatedStockData.quantity_deducted,
      });

      // Update local liveProduct object with new stock values for consistency
      liveProduct.live_stock = updatedStockData.new_stock;
      liveProduct.sold_count = updatedStockData.new_sold_count;

      // Track that stock was deducted (for error handling)
      let stockDeducted = true;

      // 5. Calculate pricing
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

      this.logEvent('log', 'purchase_calculation', {
        purchaseId,
        userId,
        unitPrice,
        quantity: purchaseDto.quantity,
        subtotal,
        platformFee,
        vendorAmount,
        deliveryFee,
        totalAmount,
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
      const orderNumber = `LIVE-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;

      // 8. Create order record for live stream purchase
      // Validate required data before attempting order creation
      if (!userId || !stream.vendor_id || !totalAmount) {
        this.logEvent('error', 'invalid_purchase_order_data', {
          purchaseId,
          userId,
          vendorId: stream.vendor_id,
          totalAmount,
        });
        throw new BadRequestException('Invalid order data: missing required fields');
      }

      let order;
      try {
        const { data: orderData, error: orderError } = await this.supabase
          .from('orders')
          .insert({
            order_number: orderNumber,
            buyer_id: userId,
            vendor_id: stream.vendor_id,
            total_amount: totalAmount,
            delivery_fee: deliveryFee,
            platform_fee: platformFee,
            status: 'pending',
            escrow_enabled: true,
            source: 'live_stream',
            delivery_type: purchaseDto.rider_id ? 'delivery' : 'pickup',
            rider_id: purchaseDto.rider_id || null,
            delivery_address: purchaseDto.delivery_address || null,
            metadata: {
              stream_id: purchaseDto.stream_id,
              stream_title: stream.title,
              transaction_id: transactionId,
              subtotal: subtotal,
              unit_price: unitPrice,
              continue_watching: purchaseDto.continue_watching || false
            }
          })
          .select()
          .single();

        if (orderError) {
          this.logEvent('error', 'order_creation_failed', {
            purchaseId,
            userId,
            vendorId: stream.vendor_id,
            totalAmount,
            orderNumber,
            errorCode: orderError.code,
            errorMessage: orderError.message,
            errorDetails: orderError.details,
            errorHint: orderError.hint,
          });

          // Provide specific error messages based on error code
          if (orderError.code === '23505') { // Unique constraint violation
            throw new BadRequestException('Order number already exists. Please try again.');
          } else if (orderError.code === '23503') { // Foreign key violation
            throw new BadRequestException('Invalid reference data. Please verify product and vendor information.');
          } else if (orderError.code === '23514') { // Check constraint violation
            throw new BadRequestException('Order data violates constraints. Please check amounts and status.');
          } else {
            throw new BadRequestException(`Failed to create order: ${orderError.message || 'Unknown error'}`);
          }
        }

        if (!orderData) {
          throw new BadRequestException('Order creation returned no data');
        }

        order = orderData;
      } catch (error) {
        // If order creation fails, we need to rollback stock update
        // Only restore stock if it was actually deducted
        if (stockDeducted) {
          try {
            // Restore stock atomically using the restoration function
            const stockRestoreResult = await this.supabase.rpc('restore_live_stream_stock_atomic', {
              p_live_product_id: liveProduct.id,
              p_quantity: purchaseDto.quantity,
            });

          if (stockRestoreResult.error || !stockRestoreResult.data?.success) {
            const restoreError = stockRestoreResult.data?.error || stockRestoreResult.error?.message || 'Unknown error';
            this.logEvent('error', 'stock_restore_failed', {
              purchaseId,
              userId,
              liveProductId: liveProduct.id,
              quantityToRestore: purchaseDto.quantity,
              error: restoreError,
            }, new Error(restoreError));
            
            // Log for manual intervention
            this.logEvent('error', 'manual_intervention_required', {
              purchaseId,
              userId,
              liveProductId: liveProduct.id,
              quantityToRestore: purchaseDto.quantity,
              originalStock: updatedStockData.old_stock,
              currentStock: updatedStockData.new_stock,
              reason: 'Stock restoration failed after order creation failure',
            });
          } else {
            this.logEvent('log', 'stock_restored', {
              purchaseId,
              liveProductId: liveProduct.id,
              quantityRestored: purchaseDto.quantity,
              oldStock: stockRestoreResult.data.old_stock,
              newStock: stockRestoreResult.data.new_stock,
            });
          }
        } catch (restoreError) {
          this.logEvent('error', 'stock_restore_exception', {
            purchaseId,
            userId,
            liveProductId: liveProduct.id,
            quantityToRestore: purchaseDto.quantity,
          }, restoreError instanceof Error ? restoreError : new Error(String(restoreError)));
        }
        // If stock wasn't deducted, no need to restore
        }

        // Cancel reservation if purchase failed
        if (purchaseDto.reservation_id) {
          try {
            await this.cancelReservation(purchaseDto.reservation_id);
          } catch (cancelError) {
            // Log but don't throw - reservation cancellation failure is non-critical
            this.logEvent('warn', 'reservation_cancel_failed_on_order_failure', {
              purchaseId,
              reservationId: purchaseDto.reservation_id,
            });
          }
        }

        // Re-throw the original error
        if (error instanceof BadRequestException) {
          throw error;
        }
        throw new BadRequestException(`Failed to create order: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      this.logEvent('log', 'order_created', {
        orderId: order.id,
        orderNumber: order.order_number,
        userId,
        vendorId: stream.vendor_id,
      });

      // 9. Create order item
      const { error: orderItemError } = await this.supabase
        .from('order_items')
        .insert({
          order_id: order.id,
          product_id: purchaseDto.product_id,
          product_name: liveProduct.product.name,
          unit_price: unitPrice,
          quantity: purchaseDto.quantity,
          total_price: subtotal,
          product_metadata: {
            description: liveProduct.product.description,
            live_price: unitPrice
          }
        });

      if (orderItemError) {
        this.logEvent('error', 'order_item_creation_failed', {
          purchaseId,
          orderId: order.id,
          error: orderItemError.message,
        });
        
        // Rollback: Delete order, restore stock, and cancel reservation
        try {
          await this.supabase.from('orders').delete().eq('id', order.id);

          // Restore stock
          const stockRestoreResult = await this.supabase.rpc('restore_live_stream_stock_atomic', {
            p_live_product_id: liveProduct.id,
            p_quantity: purchaseDto.quantity,
          });

          if (stockRestoreResult.error || !stockRestoreResult.data?.success) {
            this.logEvent('error', 'order_item_failure_stock_restore_failed', {
              purchaseId,
              orderId: order.id,
              liveProductId: liveProduct.id,
              quantity: purchaseDto.quantity,
            });
          }

          // Cancel reservation if it exists
          if (purchaseDto.reservation_id) {
            try {
              await this.cancelReservation(purchaseDto.reservation_id);
              this.logEvent('log', 'reservation_cancelled_on_order_failure', {
                purchaseId,
                reservationId: purchaseDto.reservation_id,
                orderId: order.id,
              });
            } catch (reservationError) {
              this.logEvent('warn', 'reservation_cancel_failed_on_order_failure', {
                purchaseId,
                reservationId: purchaseDto.reservation_id,
                orderId: order.id,
              }, reservationError instanceof Error ? reservationError : new Error(String(reservationError)));
              // Don't throw - reservation cleanup failure is non-critical
            }
          }
        } catch (rollbackError) {
          this.logEvent('error', 'order_item_failure_rollback_exception', {
            purchaseId,
            orderId: order.id,
          }, rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
        }
        
        throw new BadRequestException('Failed to create order item. Please try again.');
      }

      // 10. Deduct from buyer wallet (move to escrow)
      const deductResult = await this.walletService.processWalletTransaction(
        userId,
        WalletTransactionType.PURCHASE_HOLD, // ✅ FIX: Use valid transaction type (moves money to escrow)
        totalAmount,
        `Live purchase: ${purchaseDto.quantity}x ${liveProduct.product.name} from "${stream.title}"`,
        order.id,
        'order',
      );

      if (!deductResult.success) {
        this.logEvent('error', 'purchase_wallet_deduction_failed', {
          purchaseId,
          orderId: order.id,
          userId,
          amount: totalAmount,
          error: deductResult.error,
        });
        throw new BadRequestException(`Failed to process payment: ${deductResult.error}`);
      }

      // 11. Create escrow for buyer protection
      try {
        // Calculate rider commission (10% of rider earnings)
        const riderCommission = purchaseDto.rider_id && deliveryFee > 0
          ? deliveryFee * this.PLATFORM_COMMISSION_RATE
          : 0;

        const escrowBreakdown = {
          totalAmount: totalAmount,
          vendorAmount: vendorAmount,
          riderAmount: deliveryFee - riderCommission, // Rider gets delivery fee minus platform commission
          platformAmount: platformFee + riderCommission, // Platform gets vendor commission + rider commission
        };

        await this.escrowService.createEscrow(order.id, escrowBreakdown);
        this.logEvent('log', 'escrow_created', {
          purchaseId,
          orderId: order.id,
          orderNumber: order.order_number,
          amount: totalAmount,
        });

        // Update order status to paid
        await this.supabase
          .from('orders')
          .update({ status: 'paid' })
          .eq('id', order.id);

      } catch (escrowError) {
        this.logEvent('error', 'escrow_creation_failed', {
          purchaseId,
          orderId: order.id,
          userId,
          amount: totalAmount,
        }, escrowError instanceof Error ? escrowError : new Error(String(escrowError)));
        
        // Rollback transaction: refund money from escrow back to available balance and restore stock
        const rollbackReason = `Escrow creation failed: ${escrowError instanceof Error ? escrowError.message : 'Unknown error'}`;
        const rollbackResult = await this.rollbackPurchaseTransaction(
          userId,
          order.id,
          totalAmount,
          rollbackReason,
          liveProduct.id, // Pass liveProductId for stock restoration
          purchaseDto.quantity, // Pass quantity for stock restoration
        );

        if (!rollbackResult.success) {
          // Rollback itself failed - this is a critical state requiring manual intervention
          this.logEvent('error', 'rollback_failed_after_escrow_failure', {
            purchaseId,
            orderId: order.id,
            userId,
            rollbackError: rollbackResult.error,
          });
          throw new HttpException(
            `Payment processed but escrow creation failed. Rollback also failed: ${rollbackResult.error}. Manual intervention required. Order ID: ${order.id}`,
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }

        // Rollback successful - throw error to inform user
        throw new BadRequestException(
          'Payment was processed but escrow creation failed. Payment has been refunded to your wallet. Please try again.'
        );
      }

      // 12. Notify vendor of new order
      try {
        await this.notificationHelper.notifyVendorNewOrder(stream.vendor_id, {
          id: order.id,
          orderNumber: order.order_number,
          totalAmount: totalAmount,
          itemCount: 1,
          buyerName: 'Live Stream Customer', // Could fetch buyer profile if needed
        });

        // Notify vendor payment is in escrow
        await this.notificationHelper.notifyVendorOrderPaid(stream.vendor_id, {
          orderId: order.id,
          orderNumber: order.order_number,
          vendorAmount: vendorAmount,
          escrowId: order.id, // Using order ID as escrow reference
        });

        this.logEvent('debug', 'vendor_notified', {
          vendorId: stream.vendor_id,
          orderId: order.id,
        });
      } catch (notifyError) {
        this.logEvent('warn', 'vendor_notification_failed', {
          vendorId: stream.vendor_id,
          orderId: order.id,
        }, notifyError instanceof Error ? notifyError : new Error(String(notifyError)));
      }

      // 13. Stock already updated atomically earlier (step 3)
      // No need to update again here - this prevents race conditions

      // 14. Create transaction record (for live stream analytics)
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
        status: TransactionStatus.PENDING, // All purchases go through escrow now
        rider_id: purchaseDto.rider_id || null,
        delivery_address: purchaseDto.delivery_address || null,
        order_id: order.id, // Link to order record
      };

      const { error: transactionError } = await this.supabase
        .from('live_stream_transactions')
        .insert(transactionData);

      if (transactionError) {
        this.logEvent('error', 'transaction_record_failed', {
          purchaseId,
          orderId: order.id,
          transactionType: TransactionType.PRODUCT,
          amount: totalAmount,
          error: transactionError.message,
        });
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

      const duration = Date.now() - startTime;
      this.performanceMetrics.purchaseCount++;
      this.performanceMetrics.purchaseTotal += totalAmount;
      this.performanceMetrics.averagePurchaseTime = 
        (this.performanceMetrics.averagePurchaseTime * (this.performanceMetrics.purchaseCount - 1) + duration) / 
        this.performanceMetrics.purchaseCount;

      this.logPerformance('purchase_product', duration, {
        purchaseId,
        transactionId,
        userId,
        vendorId: stream.vendor_id,
        productId: liveProduct.product_id,
        quantity: purchaseDto.quantity,
        amount: totalAmount,
      });

      this.logEvent('log', 'purchase_completed', {
        purchaseId,
        transactionId,
        userId,
        vendorId: stream.vendor_id,
        productId: liveProduct.product_id,
        productName: liveProduct.product.name,
        quantity: purchaseDto.quantity,
        amount: totalAmount,
        orderId: order.id,
        orderNumber: order.order_number,
        duration,
      });

      // Return transaction details
      // Note: All purchases go through escrow now, so status is always PENDING
      // The continue_watching flag is for UX only (allows user to continue watching stream)
      return {
        id: transactionId,
        stream_id: purchaseDto.stream_id,
        transaction_type: TransactionType.PRODUCT,
        total_amount: totalAmount,
        status: TransactionStatus.PENDING, // All purchases go through escrow
        product: {
          id: liveProduct.product_id,
          name: liveProduct.product.name,
          quantity: purchaseDto.quantity,
          unit_price: unitPrice,
        },
        created_at: new Date().toISOString(),
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      this.performanceMetrics.purchaseErrors++;
      
      this.logEvent('error', 'purchase_failed', {
        purchaseId,
        userId,
        streamId: purchaseDto.stream_id,
        productId: purchaseDto.product_id,
        quantity: purchaseDto.quantity,
        duration,
      }, error instanceof Error ? error : new Error(String(error)));

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to process product purchase');
    }
  }

  /**
   * Rollback purchase transaction when escrow creation fails
   * Refunds money from escrow back to available balance, restores stock, and cancels order
   * 
   * @param userId - User ID who made the purchase
   * @param orderId - Order ID to rollback
   * @param amount - Amount to refund
   * @param reason - Reason for rollback
   * @param liveProductId - Optional: Live product ID to restore stock
   * @param quantity - Optional: Quantity to restore
   * @returns Promise<{ success: boolean; error?: string }>
   */
  private async rollbackPurchaseTransaction(
    userId: string,
    orderId: string,
    amount: number,
    reason: string,
    liveProductId?: string,
    quantity?: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.logEvent('warn', 'rollback_initiated', {
        userId,
        orderId,
        amount,
        reason,
        liveProductId,
        quantity,
      });

      // 1. Refund money from escrow back to available balance
      const refundResult = await this.walletService.processWalletTransaction(
        userId,
        WalletTransactionType.ESCROW_REFUND, // Moves money from escrow → available
        amount,
        `Rollback: ${reason}`,
        orderId,
        'order',
      );

      if (!refundResult.success) {
        this.logEvent('error', 'rollback_refund_failed', {
          userId,
          orderId,
          amount,
          reason,
          error: refundResult.error,
        });
        return {
          success: false,
          error: `Failed to refund payment: ${refundResult.error}. Manual intervention required.`,
        };
      }

      this.logEvent('log', 'rollback_refund_success', {
        userId,
        orderId,
        amount,
        refundTransactionId: refundResult.transactionId,
      });

      // 2. Restore stock if liveProductId and quantity provided
      if (liveProductId && quantity) {
        try {
          const stockRestoreResult = await this.supabase.rpc('restore_live_stream_stock_atomic', {
            p_live_product_id: liveProductId,
            p_quantity: quantity,
          });

          if (stockRestoreResult.error || !stockRestoreResult.data?.success) {
            const restoreError = stockRestoreResult.data?.error || stockRestoreResult.error?.message || 'Unknown error';
            this.logEvent('error', 'rollback_stock_restore_failed', {
              userId,
              orderId,
              liveProductId,
              quantity,
              error: restoreError,
            });
            // Continue anyway - refund was successful, stock restoration is secondary
          } else {
            this.logEvent('log', 'rollback_stock_restored', {
              userId,
              orderId,
              liveProductId,
              quantity,
              oldStock: stockRestoreResult.data.old_stock,
              newStock: stockRestoreResult.data.new_stock,
            });
          }
        } catch (stockError) {
          this.logEvent('error', 'rollback_stock_restore_exception', {
            userId,
            orderId,
            liveProductId,
            quantity,
          }, stockError instanceof Error ? stockError : new Error(String(stockError)));
          // Continue anyway - refund was successful
        }
      }

      // 3. Update order status to cancelled
      const { error: orderUpdateError } = await this.supabase
        .from('orders')
        .update({
          status: 'cancelled',
          metadata: {
            cancellation_reason: reason,
            cancelled_at: new Date().toISOString(),
            rollback_performed: true,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      if (orderUpdateError) {
        this.logEvent('warn', 'rollback_order_update_failed', {
          userId,
          orderId,
          error: orderUpdateError.message,
        });
        // Continue anyway - refund was successful
      } else {
        this.logEvent('log', 'rollback_order_cancelled', {
          userId,
          orderId,
        });
      }

      // 4. Log rollback event for audit
      this.logEvent('log', 'rollback_completed', {
        userId,
        orderId,
        amount,
        reason,
        refundTransactionId: refundResult.transactionId,
        stockRestored: !!(liveProductId && quantity),
      });

      return { success: true };
    } catch (error) {
      this.logEvent('error', 'rollback_exception', {
        userId,
        orderId,
        amount,
        reason,
      }, error instanceof Error ? error : new Error(String(error)));
      return {
        success: false,
        error: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}. Manual intervention required.`,
      };
    }
  }

  /**
   * Book a service during live stream
   */
  async bookService(userId: string, bookingDto: LiveServiceBookingDto): Promise<TransactionResponse> {
    const startTime = Date.now();
    const bookingId = `booking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Input validation
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new BadRequestException('Invalid user ID');
    }

    if (!bookingDto.stream_id || typeof bookingDto.stream_id !== 'string') {
      throw new BadRequestException('Invalid stream ID');
    }

    if (!bookingDto.service_date || typeof bookingDto.service_date !== 'string') {
      throw new BadRequestException('Invalid service date');
    }

    if (!bookingDto.service_time || typeof bookingDto.service_time !== 'string') {
      throw new BadRequestException('Invalid service time');
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(bookingDto.service_date)) {
      throw new BadRequestException('Service date must be in YYYY-MM-DD format');
    }

    // Validate time format (HH:MM)
    const timeRegex = /^\d{2}:\d{2}$/;
    if (!timeRegex.test(bookingDto.service_time)) {
      throw new BadRequestException('Service time must be in HH:MM format');
    }

    // Validate date is not in the past
    const requestedDateTime = new Date(`${bookingDto.service_date}T${bookingDto.service_time}`);
    const now = new Date();
    if (requestedDateTime <= now) {
      throw new BadRequestException('Service booking must be scheduled for a future date and time');
    }

    if (bookingDto.service_notes && typeof bookingDto.service_notes !== 'string') {
      throw new BadRequestException('Service notes must be a string');
    }

    if (bookingDto.continue_watching !== undefined &&
        typeof bookingDto.continue_watching !== 'boolean') {
      throw new BadRequestException('Continue watching must be a boolean');
    }

    this.logEvent('log', 'service_booking_initiated', {
      bookingId,
      userId,
      streamId: bookingDto.stream_id,
      serviceDate: bookingDto.service_date,
      serviceTime: bookingDto.service_time,
      continueWatching: bookingDto.continue_watching,
    });

    try {
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

      // 2. Check for duplicate service booking (idempotency) - BEFORE service details fetch
      // Prevent duplicate bookings within last 30 seconds for same service/date/time
      const duplicateCheckWindowMs = this.configService.get<number>('LIVE_SALES_DUPLICATE_WINDOW_MS') || 30000;
      const duplicateCheckWindow = new Date(Date.now() - duplicateCheckWindowMs).toISOString();
      const { data: recentBooking, error: duplicateError } = await this.supabase
        .from('orders')
        .select('id, order_number, status, created_at, metadata')
        .eq('buyer_id', userId)
        .eq('vendor_id', stream.vendor_id)
        .eq('source', 'service_booking')
        .in('status', ['pending', 'paid', 'processing'])
        .gte('created_at', duplicateCheckWindow)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (duplicateError) {
        this.logEvent('warn', 'service_duplicate_check_failed', {
          bookingId,
          userId,
          streamId: bookingDto.stream_id,
          error: duplicateError.message,
        });
        // Continue anyway - duplicate check is defensive
      }

      if (recentBooking) {
        // Check if this is a duplicate for the same service/date/time
        const { data: recentOrderItem } = await this.supabase
          .from('order_items')
          .select('product_metadata')
          .eq('order_id', recentBooking.id)
          .maybeSingle();

        if (recentOrderItem?.product_metadata?.booking_date === bookingDto.service_date &&
            recentOrderItem.product_metadata.booking_time === bookingDto.service_time) {
          const timeSinceBooking = Date.now() - new Date(recentBooking.created_at).getTime();
          this.logEvent('log', 'duplicate_service_booking_detected', {
            bookingId,
            userId,
            streamId: bookingDto.stream_id,
            serviceDate: bookingDto.service_date,
            serviceTime: bookingDto.service_time,
            recentOrderId: recentBooking.id,
            timeSinceBooking,
          });

          // Return existing booking details (idempotent response)
          return {
            id: recentBooking.metadata?.transaction_id || `dup_${recentBooking.id}`,
            stream_id: bookingDto.stream_id,
            transaction_type: TransactionType.SERVICE,
            total_amount: recentBooking.total_amount,
            status: TransactionStatus.PENDING,
            service: {
              date: bookingDto.service_date,
              time: bookingDto.service_time,
              notes: recentOrderItem.product_metadata.special_notes,
            },
            created_at: recentBooking.created_at,
          };
        }
      }

      // 3. Get live stream service details
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

      // Note: Slot availability will be checked atomically during booking
      // to prevent race conditions

      // 4. Calculate pricing
      const servicePrice = liveService.live_price;
      const platformFeeRate = 0.05; // 5% platform fee
      const platformFee = servicePrice * platformFeeRate;
      const vendorAmount = servicePrice - platformFee;

      this.logEvent('log', 'service_booking_calculation', {
        bookingId,
        userId,
        servicePrice,
        platformFee,
        vendorAmount,
        totalAmount: servicePrice,
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
      const orderNumber = `SVC-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;

      this.logEvent('debug', 'service_booking_calculation', {
        userId,
        streamId: bookingDto.stream_id,
        servicePrice,
        platformFee,
        vendorAmount,
      });

      // 8. Create order record for service booking
      // Validate required data before attempting order creation
      if (!userId || !stream.vendor_id || !servicePrice) {
        this.logEvent('error', 'invalid_booking_data', {
          bookingId,
          userId,
          vendorId: stream.vendor_id,
          servicePrice,
        });
        throw new BadRequestException('Invalid booking data: missing required fields');
      }

      let order;
      try {
        const { data: orderData, error: orderError } = await this.supabase
          .from('orders')
          .insert({
            order_number: orderNumber,
            buyer_id: userId,
            vendor_id: stream.vendor_id,
            total_amount: servicePrice,
            delivery_fee: 0, // Services don't have delivery
            platform_fee: platformFee,
            status: 'pending',
            escrow_enabled: true,
            source: 'service_booking',
            metadata: {
              stream_id: bookingDto.stream_id,
              service_id: liveService.service_id,
              service_name: liveService.service.name,
              booking_date: bookingDto.service_date,
              booking_time: bookingDto.service_time,
              duration_minutes: liveService.service.duration_minutes,
              location_type: liveService.service.location_type,
              transaction_id: transactionId,
              special_notes: bookingDto.service_notes,
            }
          })
          .select()
          .single();

        if (orderError) {
          this.logEvent('error', 'service_booking_order_creation_failed', {
            bookingId,
            userId,
            vendorId: stream.vendor_id,
            servicePrice,
            orderNumber,
            errorCode: orderError.code,
            errorMessage: orderError.message,
            errorDetails: orderError.details,
            errorHint: orderError.hint,
          });

          // Provide specific error messages based on error code
          if (orderError.code === '23505') { // Unique constraint violation
            throw new BadRequestException('Order number already exists. Please try again.');
          } else if (orderError.code === '23503') { // Foreign key violation
            throw new BadRequestException('Invalid reference data. Please verify service and vendor information.');
          } else if (orderError.code === '23514') { // Check constraint violation
            throw new BadRequestException('Order data violates constraints. Please check amounts and status.');
          } else {
            throw new BadRequestException(`Failed to create booking order: ${orderError.message || 'Unknown error'}`);
          }
        }

        if (!orderData) {
          throw new BadRequestException('Order creation returned no data');
        }

        order = orderData;
      } catch (error) {
        // If order creation fails, we should release the service slot back
        // Note: Service slots are updated later, so no rollback needed here
        // But we should log the failure for monitoring
        this.logEvent('error', 'service_booking_order_creation_failed', {
          bookingId,
          userId,
          streamId: bookingDto.stream_id,
          serviceId: liveService.service_id,
          bookingDate: bookingDto.service_date,
          bookingTime: bookingDto.service_time,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        // Re-throw the original error
        if (error instanceof BadRequestException) {
          throw error;
        }
        throw new BadRequestException(`Failed to create booking order: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      this.logEvent('log', 'service_order_created', {
        orderId: order.id,
        orderNumber: order.order_number,
        userId,
        vendorId: stream.vendor_id,
      });

      // 9. Create order item for service
      const { error: orderItemError } = await this.supabase
        .from('order_items')
        .insert({
          order_id: order.id,
          product_id: null, // Services don't have product IDs
          product_name: liveService.service.name,
          unit_price: servicePrice,
          quantity: 1,
          total_price: servicePrice,
          product_metadata: {
            service_id: liveService.service_id,
            booking_date: bookingDto.service_date,
            booking_time: bookingDto.service_time,
            duration_minutes: liveService.service.duration_minutes,
            location_type: liveService.service.location_type,
            description: liveService.service.description,
            special_notes: bookingDto.service_notes,
          }
        });

      if (orderItemError) {
        this.logEvent('error', 'service_order_item_creation_failed', {
          bookingId,
          orderId: order.id,
          error: orderItemError.message,
        });
      }

      // 10. Deduct from customer wallet (move to escrow)
      const deductResult = await this.walletService.processWalletTransaction(
        userId,
        WalletTransactionType.PURCHASE_HOLD, // ✅ FIX: Use valid transaction type (moves money to escrow)
        servicePrice,
        `Service booking: ${liveService.service.name} on ${bookingDto.service_date} ${bookingDto.service_time}`,
        order.id,
        'order',
      );

      if (!deductResult.success) {
        this.logEvent('error', 'service_booking_wallet_deduction_failed', {
          bookingId,
          orderId: order.id,
          userId,
          amount: servicePrice,
          error: deductResult.error,
        });
        throw new BadRequestException(`Failed to process booking payment: ${deductResult.error}`);
      }

      this.logEvent('log', 'customer_wallet_deducted_service', {
        bookingId,
        userId,
        amount: servicePrice,
      });

      // 11. Create escrow for buyer protection
      try {
        const escrowBreakdown = {
          totalAmount: servicePrice,
          vendorAmount: vendorAmount,
          riderAmount: 0, // Services don't have delivery
          platformAmount: platformFee,
        };

        await this.escrowService.createEscrow(order.id, escrowBreakdown);
        this.logEvent('log', 'service_escrow_created', {
          orderId: order.id,
          orderNumber: order.order_number,
          amount: servicePrice,
        });

        // Update order status to paid
        await this.supabase
          .from('orders')
          .update({ status: 'paid' })
          .eq('id', order.id);

      } catch (escrowError) {
        this.logEvent('error', 'service_escrow_creation_failed', {
          userId,
          orderId: order.id,
          amount: servicePrice,
        }, escrowError instanceof Error ? escrowError : new Error(String(escrowError)));
        
        // Rollback transaction: refund money from escrow back to available balance
        // Note: Services don't have stock to restore, only wallet refund
        const rollbackReason = `Escrow creation failed: ${escrowError instanceof Error ? escrowError.message : 'Unknown error'}`;
        const rollbackResult = await this.rollbackPurchaseTransaction(
          userId,
          order.id,
          servicePrice,
          rollbackReason,
          // No liveProductId or quantity for services
        );

        if (!rollbackResult.success) {
          // Rollback itself failed - this is a critical state requiring manual intervention
          this.logEvent('error', 'service_rollback_failed_after_escrow_failure', {
            userId,
            orderId: order.id,
            rollbackError: rollbackResult.error,
          });
          throw new HttpException(
            `Payment processed but escrow creation failed. Rollback also failed: ${rollbackResult.error}. Manual intervention required. Order ID: ${order.id}`,
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }

        // Rollback successful - throw error to inform user
        throw new BadRequestException(
          'Payment was processed but escrow creation failed. Payment has been refunded to your wallet. Please try again.'
        );
      }

      // 12. Create service booking record (for service-specific data)
      const bookingData = {
        id: transactionId,
        order_id: order.id, // Link to order
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
        this.logEvent('warn', 'service_booking_record_failed', {
          bookingId,
          userId,
          orderId: order.id,
          serviceId: liveService.service_id,
          error: bookingError.message,
        });
        // Continue - order and escrow already created, booking record is for reference
      }

      // 13. Notify vendor of new booking
      try {
        await this.notificationHelper.notifyVendorNewOrder(stream.vendor_id, {
          id: order.id,
          orderNumber: order.order_number,
          totalAmount: servicePrice,
          itemCount: 1,
          buyerName: 'Service Customer',
        });

        await this.notificationHelper.notifyVendorOrderPaid(stream.vendor_id, {
          orderId: order.id,
          orderNumber: order.order_number,
          vendorAmount: vendorAmount,
          escrowId: order.id,
        });

        this.logEvent('debug', 'vendor_notified_service', {
          vendorId: stream.vendor_id,
          orderId: order.id,
        });
      } catch (notifyError) {
        this.logEvent('warn', 'vendor_notification_failed_service', {
          vendorId: stream.vendor_id,
          orderId: order.id,
        }, notifyError instanceof Error ? notifyError : new Error(String(notifyError)));
      }

      // 9. Re-check stream status before completing booking
      // Ensure stream is still live (could have ended during processing)
      const { data: streamStatusCheck, error: streamStatusError } = await this.supabase
        .from('live_streams')
        .select('status')
        .eq('id', bookingDto.stream_id)
        .single();

      if (streamStatusError || !streamStatusCheck) {
        this.logEvent('warn', 'service_stream_status_check_failed', {
          bookingId,
          streamId: bookingDto.stream_id,
          error: streamStatusError?.message || 'Stream not found',
        });
        // Continue anyway - order already created
      } else if (streamStatusCheck.status !== 'live') {
        this.logEvent('warn', 'service_stream_ended_during_booking', {
          bookingId,
          streamId: bookingDto.stream_id,
          streamStatus: streamStatusCheck.status,
          orderId: order.id,
        });
        // Continue anyway - order already created, but log the issue
      }

      // 10. Atomically book the service slot (prevent race conditions)
      const slotBookingResult = await this.supabase.rpc('book_live_service_slot_atomic', {
        p_service_id: liveService.id,
        p_booking_date: bookingDto.service_date,
        p_booking_time: bookingDto.service_time,
      });

      if (slotBookingResult.error || !slotBookingResult.data?.success) {
        const errorMessage = slotBookingResult.data?.error || slotBookingResult.error?.message || 'Failed to book service slot';
        const errorCode = slotBookingResult.data?.error_code || 'SLOT_BOOKING_FAILED';

        this.logEvent('error', 'service_slot_booking_failed', {
          bookingId,
          userId,
          orderId: order.id,
          serviceId: liveService.service_id,
          bookingDate: bookingDto.service_date,
          bookingTime: bookingDto.service_time,
          error: errorMessage,
          errorCode,
        });

        // This is a critical failure - the order was created but slot booking failed
        // Rollback the entire transaction
        const rollbackReason = `Service slot booking failed: ${errorMessage}`;
        const rollbackResult = await this.rollbackPurchaseTransaction(
          userId,
          order.id,
          servicePrice,
          rollbackReason,
          // No liveProductId or quantity for services
        );

        if (!rollbackResult.success) {
          this.logEvent('error', 'service_slot_booking_rollback_failed', {
            bookingId,
            userId,
            orderId: order.id,
            rollbackError: rollbackResult.error,
          });
          throw new HttpException(
            `Service booking failed and rollback also failed. Manual intervention required. Order ID: ${order.id}`,
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }

        throw new BadRequestException(`Service slot booking failed: ${errorMessage}. Payment has been refunded.`);
      }

      this.logEvent('log', 'service_slot_booked_atomically', {
        bookingId,
        userId,
        orderId: order.id,
        serviceId: liveService.service_id,
        bookingDate: bookingDto.service_date,
        bookingTime: bookingDto.service_time,
        slotIndex: slotBookingResult.data.slot_index,
      });

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
        this.logEvent('warn', 'service_transaction_record_failed', {
          bookingId,
          transactionId,
          orderId: order.id,
          error: transactionError.message,
        });
        // Continue anyway - transaction record is for analytics only, not critical
        // Order and escrow are already created successfully
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

      const duration = Date.now() - startTime;
      this.logPerformance('book_service', duration, {
        bookingId,
        transactionId,
        userId,
        vendorId: stream.vendor_id,
        serviceId: liveService.service_id,
        amount: servicePrice,
      });

      this.logEvent('log', 'service_booking_completed', {
        bookingId,
        transactionId,
        userId,
        vendorId: stream.vendor_id,
        serviceId: liveService.service_id,
        serviceName: liveService.service.name,
        bookingDate: bookingDto.service_date,
        bookingTime: bookingDto.service_time,
        amount: servicePrice,
        orderId: order.id,
        orderNumber: order.order_number,
        duration,
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
      this.logEvent('error', 'service_booking_exception', {
        streamId: bookingDto.stream_id,
        userId,
        serviceDate: bookingDto.service_date,
        serviceTime: bookingDto.service_time,
      }, error instanceof Error ? error : new Error(String(error)));
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
      const { data, error} = await this.supabase
        .from('gift_types')
        .select('*')
        .eq('is_active', true)
        .order('base_value');

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.logEvent('error', 'fetch_gift_types_exception', {}, error instanceof Error ? error : new Error(String(error)));
      throw new BadRequestException('Failed to fetch gift types');
    }
  }

  // =====================
  // AGORA INTEGRATION
  // =====================

  /**
   * Generate Agora RTC token for vendor broadcasting
   * 
   * Note: Requires agora-access-token package
   * npm install agora-access-token
   */
  async generateAgoraToken(streamId: string, vendorId: string, role: 'host' | 'audience'): Promise<{
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

      // Verify stream ownership
      const { data: stream, error } = await this.supabase
        .from('live_streams')
        .select('vendor_id')
        .eq('id', streamId)
        .single();

      if (error || !stream) {
        throw new NotFoundException('Stream not found');
      }

      if (stream.vendor_id !== vendorId && role === 'host') {
        throw new ForbiddenException('Only stream owner can broadcast');
      }

      // Use stream ID as channel name
      const channelName = `fretiko_${streamId}`;
      
      // Generate unique UID (use numeric part of vendor ID hash)
      const uid = Math.abs(this.hashCode(vendorId)) % 1000000;
      
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

      this.logEvent('log', 'agora_token_generated', {
        streamId,
        channel: channelName,
        uid,
        role,
        expiresAt: new Date(privilegeExpiredTs * 1000).toISOString(),
      });

      return {
        token,
        channel: channelName,
        uid,
        appId,
      };
    } catch (error) {
      this.logEvent('error', 'agora_token_generation_exception', {
        streamId,
        vendorId,
        role,
      }, error instanceof Error ? error : new Error(String(error)));
      if (error instanceof NotFoundException || error instanceof ForbiddenException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to generate streaming token');
    }
  }

  /**
   * Get HLS stream URL for viewers
   *
   * Queries Agora's REST API to get the actual HLS URL from their CDN
   * The URL is generated when host starts broadcasting with HLS enabled
   */
  async getHLSStreamUrl(streamId: string): Promise<{ hlsUrl: string; status: string }> {
    try {
      // Verify stream exists and is live
      const { data: stream, error } = await this.supabase
        .from('live_streams')
        .select('status, stream_url')
        .eq('id', streamId)
        .single();

      if (error || !stream) {
        throw new NotFoundException('Stream not found');
      }

      if (stream.status !== 'live') {
        return {
          hlsUrl: '',
          status: 'Stream is not live yet'
        };
      }

      // If stream_url is already set (HLS is available), return it
      if (stream.stream_url) {
        return {
          hlsUrl: stream.stream_url,
          status: 'live'
        };
      }

      // Query Agora REST API for HLS URL
      const appId = this.configService.get<string>('AGORA_APP_ID');
      const appCertificate = this.configService.get<string>('AGORA_APP_CERTIFICATE');
      const channelName = `fretiko_${streamId}`;

      if (!appId || !appCertificate) {
        throw new BadRequestException('Agora credentials not configured');
      }

      // Generate Agora REST API authentication signature
      const timestamp = Math.floor(Date.now() / 1000);
      const expiredTs = timestamp + 3600; // 1 hour validity

      const signature = this.generateAgoraRestSignature(appId, appCertificate, channelName, timestamp, expiredTs);

      // Query Agora REST API for HLS status and URL
      const agoraApiUrl = `https://api.agora.io/dev/v1/channel/${appId}/agora-hls/${channelName}`;

      this.logEvent('log', 'querying_agora_hls_api', {
        streamId,
        channelName,
        apiUrl: agoraApiUrl,
      });

      const response = await fetch(agoraApiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Agora ${appId}:${signature}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logEvent('warn', 'agora_hls_api_error', {
          streamId,
          channelName,
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        });

        // If HLS transcoding hasn't started yet
        if (response.status === 404) {
          return {
            hlsUrl: '',
            status: 'HLS transcoding not started yet'
          };
        }

        return {
          hlsUrl: '',
          status: 'HLS not ready yet'
        };
      }

      const agoraData = await response.json();

      this.logEvent('log', 'agora_hls_api_response', {
        streamId,
        channelName,
        hasHlsUrl: !!agoraData?.data?.hlsUrl,
        responseKeys: Object.keys(agoraData?.data || {}),
      });

      if (agoraData?.data?.hlsUrl) {
        const hlsUrl = agoraData.data.hlsUrl;

        // Update stream with HLS URL for future requests
        const { error: updateError } = await this.supabase
          .from('live_streams')
          .update({ stream_url: hlsUrl })
          .eq('id', streamId);

        if (updateError) {
          this.logEvent('warn', 'stream_url_update_failed', {
            streamId,
            hlsUrl,
            error: updateError.message,
          });
          // Continue anyway - HLS URL is still valid
        } else {
          this.logEvent('log', 'stream_url_updated', {
            streamId,
            hlsUrl,
          });
        }

        return {
          hlsUrl,
          status: 'live'
        };
      }

      return {
        hlsUrl: '',
        status: 'HLS transcoding in progress'
      };

    } catch (error) {
      this.logEvent('error', 'get_hls_url_failed', {
        streamId,
      }, error instanceof Error ? error : new Error(String(error)));
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException('Failed to get stream URL');
    }
  }

  /**
   * Generate Agora REST API authentication signature
   * Uses HMAC-SHA1 for signature generation
   */
  private generateAgoraRestSignature(
    appId: string,
    appCertificate: string,
    channelName: string,
    timestamp: number,
    expiredTs: number
  ): string {
    try {
      const crypto = require('crypto');

      // Create the message to sign
      const message = `${appId}${appCertificate}${channelName}${timestamp}${expiredTs}`;

      // Generate HMAC-SHA1 signature
      const hmac = crypto.createHmac('sha1', appCertificate);
      hmac.update(message);
      const signature = hmac.digest('hex');

      return signature;
    } catch (error) {
      this.logEvent('error', 'agora_signature_generation_failed', {
        appId,
        channelName,
      }, error instanceof Error ? error : new Error(String(error)));
      throw new BadRequestException('Failed to generate Agora API signature');
    }
  }

  /**
   * Hash function for generating numeric UID from string
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

  // =====================
  // STOCK RESERVATION MANAGEMENT
  // =====================

  /**
   * Get live product ID for a given stream and product
   * Helper method for gateway to avoid direct property access
   */
  async getLiveProductId(streamId: string, productId: string): Promise<string | null> {
    try {
      const { data: liveProduct, error } = await this.supabase
        .from('live_stream_products')
        .select('id')
        .eq('stream_id', streamId)
        .eq('product_id', productId)
        .single();

      if (error || !liveProduct) {
        return null;
      }

      return liveProduct.id;
    } catch (error) {
      this.logEvent('error', 'get_live_product_id_failed', {
        streamId,
        productId,
      }, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Reserve stock for a user (temporary hold)
   * Creates a reservation record that expires after 5 minutes
   */
  async reserveStock(
    streamId: string,
    productId: string,
    liveProductId: string,
    userId: string,
    quantity: number,
  ): Promise<{ success: boolean; reservationId?: string; error?: string; availableStock?: number }> {
    try {
      // Check available stock (considering existing reservations)
      const { data: availableStockResult, error: stockError } = await this.supabase.rpc(
        'get_available_live_stock',
        { p_live_product_id: liveProductId }
      );

      if (stockError) {
        this.logEvent('error', 'get_available_stock_failed', {
          streamId,
          productId,
          liveProductId,
          error: stockError.message,
        });
        return { success: false, error: 'Failed to check stock availability' };
      }

      const availableStock = availableStockResult || 0;

      if (availableStock < quantity) {
        return {
          success: false,
          error: `Insufficient stock. Only ${availableStock} items available`,
          availableStock,
        };
      }

      // Create reservation (expires in 5 minutes)
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { data: reservation, error: reservationError } = await this.supabase
        .from('live_stream_stock_reservations')
        .insert({
          stream_id: streamId,
          product_id: productId,
          live_product_id: liveProductId,
          user_id: userId,
          quantity,
          status: 'active',
          expires_at: expiresAt,
        })
        .select('id')
        .single();

      if (reservationError) {
        // Check if it's a unique constraint violation (duplicate active reservation)
        if (reservationError.code === '23505') {
          // User already has an active reservation for this product
          const { data: existingReservation } = await this.supabase
            .from('live_stream_stock_reservations')
            .select('id, quantity, expires_at')
            .eq('stream_id', streamId)
            .eq('product_id', productId)
            .eq('user_id', userId)
            .eq('status', 'active')
            .single();

          if (existingReservation) {
            return {
              success: true,
              reservationId: existingReservation.id,
            };
          }
        }

        this.logEvent('error', 'reservation_creation_failed', {
          streamId,
          productId,
          userId,
          quantity,
          error: reservationError.message,
        });
        return { success: false, error: 'Failed to reserve stock' };
      }

      this.performanceMetrics.stockReservations++;
      this.logEvent('log', 'stock_reserved', {
        reservationId: reservation.id,
        userId,
        streamId,
        productId,
        liveProductId,
        quantity,
        expiresAt,
      });

      return {
        success: true,
        reservationId: reservation.id,
      };
    } catch (error) {
      this.logEvent('error', 'reserve_stock_exception', {
        streamId,
        productId,
        userId,
        quantity,
      }, error instanceof Error ? error : new Error(String(error)));
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Confirm stock reservation (convert to sale)
   * Marks reservation as confirmed - stock is already deducted in purchase flow
   */
  async confirmReservation(reservationId: string): Promise<boolean> {
    try {
      const { error } = await this.supabase
        .from('live_stream_stock_reservations')
        .update({
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', reservationId)
        .eq('status', 'active'); // Only confirm active reservations

      if (error) {
        this.logEvent('error', 'reservation_confirm_failed', {
          reservationId,
          error: error.message,
        });
        return false;
      }

      this.logEvent('log', 'reservation_confirmed', {
        reservationId,
      });
      return true;
    } catch (error) {
      this.logEvent('error', 'reservation_confirmation_exception', {
        reservationId,
      }, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Cancel stock reservation
   * Releases reserved stock back to available pool
   */
  async cancelReservation(reservationId: string): Promise<boolean> {
    try {
      const { error } = await this.supabase
        .from('live_stream_stock_reservations')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', reservationId)
        .in('status', ['active', 'expired']); // Can cancel active or expired reservations

      if (error) {
        this.logEvent('error', 'reservation_cancel_failed', {
          reservationId,
          error: error.message,
        });
        return false;
      }

      this.logEvent('log', 'reservation_cancelled', {
        reservationId,
      });
      return true;
    } catch (error) {
      this.logEvent('error', 'reservation_cancel_exception', {
        reservationId,
      }, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Get current inventory for a product (including reservations)
   */
  async getProductInventory(streamId: string, productId: string): Promise<{
    currentStock: number;
    reservedStock: number;
    availableStock: number;
    soldCount: number;
  }> {
    try {
      // Get live product details
      const { data: liveProduct, error: productError } = await this.supabase
        .from('live_stream_products')
        .select('id, live_stock, sold_count')
        .eq('stream_id', streamId)
        .eq('product_id', productId)
        .single();

      if (productError || !liveProduct) {
        throw new NotFoundException('Product not found in stream');
      }

      // Get active reservations count
      const { data: reservations, error: reservationError } = await this.supabase
        .from('live_stream_stock_reservations')
        .select('quantity')
        .eq('live_product_id', liveProduct.id)
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString()); // Only non-expired

      if (reservationError) {
        this.logEvent('warn', 'get_reservations_failed', {
          streamId,
          productId,
          liveProductId: liveProduct.id,
          error: reservationError.message,
        });
      }

      const reservedStock = reservations?.reduce((sum, r) => sum + r.quantity, 0) || 0;
      const currentStock = liveProduct.live_stock;
      const availableStock = Math.max(0, currentStock - reservedStock);

      return {
        currentStock,
        reservedStock,
        availableStock,
        soldCount: liveProduct.sold_count,
      };
    } catch (error) {
      this.logEvent('error', 'get_product_inventory_failed', {
        streamId,
        productId,
      }, error instanceof Error ? error : new Error(String(error)));
      throw new BadRequestException('Failed to get product inventory');
    }
  }

  /**
   * Cleanup expired stock reservations
   * Runs every minute to cancel expired reservations
   * This releases reserved stock back to available pool
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupExpiredReservations(): Promise<void> {
    try {
      const { data: result, error } = await this.supabase.rpc('cleanup_expired_stock_reservations');

      if (error) {
        this.logEvent('error', 'cleanup_expired_reservations_failed', {
          error: error.message,
        });
        return;
      }

      const expiredCount = result || 0;
      if (expiredCount > 0) {
        this.performanceMetrics.stockReservationExpirations += expiredCount;
        this.logEvent('log', 'reservations_cleaned_up', {
          expiredCount,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      this.logEvent('error', 'cleanup_expired_reservations_cron_error', {}, 
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Cleanup orphaned orders from failed transactions
   * Runs every 5 minutes to find and cancel orders that:
   * - Are in 'pending' status for more than 30 minutes
   * - Have no order items
   * - Are from live_stream or service_booking source
   * - Have no escrow (payment never completed)
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanupOrphanedOrders(): Promise<void> {
    try {
      const orphanThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 minutes ago

      // Find orphaned orders: pending for >30 min, no items, no escrow, from live sales
      // Use RPC function to properly identify orders without escrow records
      const { data: orphanedOrders, error: findError } = await this.supabase
        .rpc('get_orphaned_orders', {
          source_filter: ['live_stream', 'service_booking'],
          orphan_threshold: orphanThreshold
        });

      if (findError) {
        this.logEvent('error', 'cleanup_orphaned_orders_find_failed', {
          error: findError.message,
        });
        return;
      }

      if (!orphanedOrders || orphanedOrders.length === 0) {
        return; // No orphaned orders
      }

      // Check which orders have no items
      const ordersToCancel: string[] = [];
      for (const order of orphanedOrders) {
        const { data: items, error: itemsError } = await this.supabase
          .from('order_items')
          .select('id')
          .eq('order_id', order.id)
          .limit(1);

        if (itemsError) {
          this.logEvent('warn', 'cleanup_check_order_items_failed', {
            orderId: order.id,
            error: itemsError.message,
          });
          continue;
        }

        // If no items, this is an orphaned order
        if (!items || items.length === 0) {
          ordersToCancel.push(order.id);
        }
      }

      if (ordersToCancel.length === 0) {
        return; // No orphaned orders to clean up
      }

      // Cancel orphaned orders
      const { error: cancelError } = await this.supabase
        .from('orders')
        .update({ 
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        })
        .in('id', ordersToCancel);

      if (cancelError) {
        this.logEvent('error', 'cleanup_orphaned_orders_cancel_failed', {
          orderCount: ordersToCancel.length,
          error: cancelError.message,
        });
        return;
      }

      this.logEvent('log', 'orphaned_orders_cleaned_up', {
        orderCount: ordersToCancel.length,
        orderIds: ordersToCancel,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logEvent('error', 'cleanup_orphaned_orders_cron_error', {},
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get vendor's streams with aggregated analytics
   */
  async getVendorStreamsWithAnalytics(vendorId: string): Promise<any[]> {
    try {
      // Get all streams for this vendor
      const { data: streams, error: streamsError } = await this.supabase
        .from('live_streams')
        .select(`
          id,
          title,
          status,
          started_at,
          ended_at,
          viewer_count,
          total_viewers,
          total_sales,
          created_at,
          products:live_stream_products!stream_id(
            id,
            product:products(name),
            live_price,
            live_stock,
            sold_count
          ),
          services:live_stream_services!stream_id(
            id,
            service:services(name),
            live_price
          )
        `)
        .eq('vendor_id', vendorId)
        .order('created_at', { ascending: false });

      if (streamsError) {
        this.logEvent('error', 'get_vendor_streams_analytics_failed', { vendorId }, streamsError);
        throw new BadRequestException('Failed to retrieve vendor streams');
      }

      if (!streams || streams.length === 0) {
        return [];
      }

      // For each stream, aggregate analytics data
      const streamsWithAnalytics = await Promise.all(
        streams.map(async (stream) => {
          // Get analytics metrics for this stream
          const analytics = await this.getStreamAnalyticsData(stream.id);

          // Get recent purchases and bookings for this stream
          const recentActivity = await this.getStreamRecentActivity(stream.id);

          return {
            id: stream.id,
            title: stream.title,
            status: stream.status,
            started_at: stream.started_at,
            ended_at: stream.ended_at,
            viewer_count: stream.viewer_count,
            total_viewers: stream.total_viewers,
            total_sales: stream.total_sales,
            products: stream.products || [],
            services: stream.services || [],
            analytics,
            recent_activity: recentActivity,
            created_at: stream.created_at,
          };
        })
      );

      return streamsWithAnalytics;
    } catch (error) {
      this.logEvent('error', 'get_vendor_streams_with_analytics_error', { vendorId },
        error instanceof Error ? error : new Error(String(error)));
      throw new BadRequestException('Failed to retrieve vendor streams with analytics');
    }
  }

  /**
   * Get detailed analytics for a specific stream
   */
  async getStreamAnalytics(streamId: string, vendorId?: string): Promise<any> {
    try {
      // Verify the stream exists and user has access (if vendorId provided)
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('id, vendor_id, title, status, started_at, ended_at, viewer_count, total_viewers, total_sales')
        .eq('id', streamId)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Stream not found');
      }

      // If vendorId provided, verify ownership
      if (vendorId && stream.vendor_id !== vendorId) {
        throw new ForbiddenException('Access denied: You can only view analytics for your own streams');
      }

      // Get comprehensive analytics data
      const analytics = await this.getStreamAnalyticsData(streamId);
      const recentActivity = await this.getStreamRecentActivity(streamId, 20); // More detailed for single stream
      const performanceMetrics = await this.getStreamPerformanceMetrics(streamId);

      return {
        stream: {
          id: stream.id,
          title: stream.title,
          status: stream.status,
          started_at: stream.started_at,
          ended_at: stream.ended_at,
          viewer_count: stream.viewer_count,
          total_viewers: stream.total_viewers,
          total_sales: stream.total_sales,
        },
        analytics,
        recent_activity: recentActivity,
        performance_metrics: performanceMetrics,
      };
    } catch (error) {
      this.logEvent('error', 'get_stream_analytics_error', { streamId, vendorId },
        error instanceof Error ? error : new Error(String(error)));
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new BadRequestException('Failed to retrieve stream analytics');
    }
  }

  /**
   * Get aggregated analytics data for a stream
   */
  private async getStreamAnalyticsData(streamId: string): Promise<any> {
    try {
      // Aggregate metrics from live_stream_analytics table
      const { data: metrics, error } = await this.supabase
        .from('live_stream_analytics')
        .select('metric_type, metric_value, created_at')
        .eq('stream_id', streamId);

      if (error) {
        this.logEvent('warn', 'get_stream_analytics_data_failed', { streamId }, error);
        return this.getDefaultAnalytics();
      }

      // Aggregate the metrics
      const analytics = {
        total_views: 0,
        total_comments: 0,
        total_reactions: 0,
        total_gifts: 0,
        total_gift_value: 0,
        total_purchases: 0,
        total_purchase_value: 0,
        total_service_bookings: 0,
        total_service_value: 0,
        peak_viewers: 0,
        average_session_duration: 0,
        engagement_rate: 0,
      };

      metrics?.forEach(metric => {
        switch (metric.metric_type) {
          case 'viewer_join':
            analytics.total_views += metric.metric_value;
            break;
          case 'comment':
            analytics.total_comments += metric.metric_value;
            break;
          case 'reaction':
            analytics.total_reactions += metric.metric_value;
            break;
          case 'gift':
            analytics.total_gifts += metric.metric_value;
            analytics.total_gift_value += metric.metric_value;
            break;
        }
      });

      // Get purchase and booking data from orders table
      const { data: orders, error: ordersError } = await this.supabase
        .from('orders')
        .select('total_amount, source, created_at')
        .eq('source', 'live_stream')
        .eq('status', 'paid')
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()); // Last 30 days

      if (!ordersError && orders) {
        orders.forEach(order => {
          if (order.source === 'live_stream') {
            // This is a simplified check - in reality we'd need to link orders to streams
            analytics.total_purchases += 1;
            analytics.total_purchase_value += parseFloat(order.total_amount);
          }
        });
      }

      // Calculate engagement rate (simplified)
      if (analytics.total_views > 0) {
        analytics.engagement_rate = ((analytics.total_comments + analytics.total_reactions + analytics.total_gifts) / analytics.total_views) * 100;
      }

      return analytics;
    } catch (error) {
      this.logEvent('error', 'get_stream_analytics_data_error', { streamId }, error instanceof Error ? error : new Error(String(error)));
      return this.getDefaultAnalytics();
    }
  }

  /**
   * Get recent activity for a stream
   */
  private async getStreamRecentActivity(streamId: string, limit: number = 10): Promise<any[]> {
    try {
      // Get recent comments
      const { data: comments, error: commentsError } = await this.supabase
        .from('live_stream_comments')
        .select(`
          id,
          message,
          created_at,
          user:user_profiles!user_id(username, avatar_url)
        `)
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(limit);

      // Get recent gifts
      const { data: gifts, error: giftsError } = await this.supabase
        .from('live_stream_gifts')
        .select(`
          id,
          gift_type,
          created_at,
          sender:user_profiles!sender_id(username, avatar_url)
        `)
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(limit);

      // Get recent purchases (simplified - would need proper stream linking)
      const { data: purchases, error: purchasesError } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          total_amount,
          created_at,
          buyer:user_profiles!buyer_id(username)
        `)
        .eq('source', 'live_stream')
        .eq('status', 'paid')
        .order('created_at', { ascending: false })
        .limit(limit);

      const activity: any[] = [];

      // Combine and sort all activity
      if (!commentsError && comments) {
        comments.forEach(comment => {
          activity.push({
            type: 'comment',
            id: comment.id,
            message: comment.message,
            user: comment.user,
            timestamp: comment.created_at,
          });
        });
      }

      if (!giftsError && gifts) {
        gifts.forEach(gift => {
          activity.push({
            type: 'gift',
            id: gift.id,
            gift_type: gift.gift_type,
            user: gift.sender,
            timestamp: gift.created_at,
          });
        });
      }

      if (!purchasesError && purchases) {
        purchases.forEach(purchase => {
          activity.push({
            type: 'purchase',
            id: purchase.id,
            order_number: purchase.order_number,
            amount: purchase.total_amount,
            user: purchase.buyer,
            timestamp: purchase.created_at,
          });
        });
      }

      // Sort by timestamp and limit
      return activity
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit);

    } catch (error) {
      this.logEvent('error', 'get_stream_recent_activity_error', { streamId }, error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  /**
   * Get performance metrics for a stream
   */
  private async getStreamPerformanceMetrics(streamId: string): Promise<any> {
    try {
      // Get hourly viewership data for the last 24 hours
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const { data: hourlyData, error } = await this.supabase
        .from('live_stream_analytics')
        .select('metric_type, metric_value, created_at')
        .eq('stream_id', streamId)
        .eq('metric_type', 'viewer_join')
        .gte('created_at', yesterday.toISOString())
        .order('created_at', { ascending: true });

      const hourlyViews = {};
      if (!error && hourlyData) {
        hourlyData.forEach(entry => {
          const hour = new Date(entry.created_at).getHours();
          hourlyViews[hour] = (hourlyViews[hour] || 0) + entry.metric_value;
        });
      }

      return {
        hourly_viewership: hourlyViews,
        last_updated: new Date().toISOString(),
      };
    } catch (error) {
      this.logEvent('error', 'get_stream_performance_metrics_error', { streamId }, error instanceof Error ? error : new Error(String(error)));
      return {
        hourly_viewership: {},
        last_updated: new Date().toISOString(),
      };
    }
  }

  /**
   * Get default analytics structure
   */
  private getDefaultAnalytics(): any {
    return {
      total_views: 0,
      total_comments: 0,
      total_reactions: 0,
      total_gifts: 0,
      total_gift_value: 0,
      total_purchases: 0,
      total_purchase_value: 0,
      total_service_bookings: 0,
      total_service_value: 0,
      peak_viewers: 0,
      average_session_duration: 0,
      engagement_rate: 0,
    };
  }
}