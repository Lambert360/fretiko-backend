import { Injectable, BadRequestException, NotFoundException, ForbiddenException, HttpException, HttpStatus, Inject, forwardRef, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
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
  LiveStreamProductDto,
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
    // CRITICAL: Use service role client to bypass RLS for system operations
    // like updating agora_resource_id, agora_sid, and other system fields
    this.supabase = createServiceSupabaseClient(this.configService);
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
        await this.joinStream(streamId, userId, undefined); // No accessToken available in this context
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

        // Use service role client to bypass RLS policies during stream creation
        // This ensures products are always added successfully without timing/transaction issues
        const { error: productError } = await this.supabase
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
    accessToken?: string,
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
        
        // 🚀 Start HLS Cloud Recording with S3
        // Run in background to not block status update
        this.startHLSConversion(streamId).catch(err => {
          this.logger.warn(`⚠️ HLS conversion start failed for stream ${streamId}: ${err.message}`);
          // Don't throw - HLS is optional, stream can continue without it
        });
      } else if (updateStatusDto.status === StreamStatus.ENDED) {
        updateData.ended_at = new Date().toISOString();
        
        // Stop recording and get HLS URL from S3
        // Give a small delay to ensure any in-flight recording updates are committed
        setTimeout(() => {
          this.stopHLSRecording(streamId).catch(err => {
            this.logger.warn(`⚠️ Failed to stop recording for stream ${streamId}: ${err.message}`);
          });
        }, 2000); // 2 second delay
      }

      this.logger.log(`🔄 Updating stream ${streamId} status to ${updateStatusDto.status}`);

      // CRITICAL: Use service role client for updates to preserve agora_resource_id and agora_sid
      // User clients may have RLS restrictions that prevent reading/writing these system fields
      // This ensures Cloud Recording IDs are never accidentally cleared
      const clientForUpdate = this.supabase; // Always use service role

      this.logger.log(`📝 Updating stream with data: ${JSON.stringify(updateData)}`);

      const { data: updateResult, error: updateError } = await clientForUpdate
        .from('live_streams')
        .update(updateData)
        .eq('id', streamId)
        .select('id, status'); // Verify the update

      if (updateError) {
        this.logger.error(`❌ Stream status update failed: ${updateError.message}`);
        this.logger.error(`   Full error: ${JSON.stringify(updateError)}`);
        throw updateError;
      }

      if (!updateResult || updateResult.length === 0) {
        this.logger.error(`❌ Stream status update returned no rows. Stream ${streamId} may not exist.`);
        throw new Error(`Stream ${streamId} not found for update`);
      }

      this.logger.log(`✅ Stream status update completed for ${streamId}. Updated status: ${updateResult[0]?.status}`);

      // Small delay to ensure database commit
      await new Promise(resolve => setTimeout(resolve, 100));

      const updatedStream = await this.getStreamById(streamId);
      this.logger.log(`📊 Verified stream status in DB: ${updatedStream.status}`);

      return updatedStream;
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
  async endStream(streamId: string, vendorId: string, accessToken?: string): Promise<void> {
    await this.updateStreamStatus(streamId, vendorId, { status: StreamStatus.ENDED }, accessToken);
  }

  /**
   * Add product to existing live stream
   */
  async addProductToStream(
    streamId: string,
    vendorId: string,
    productDto: LiveStreamProductDto,
    userToken?: string,
  ): Promise<any> {
    try {
      // Verify stream ownership and status
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('vendor_id, status, stream_type')
        .eq('id', streamId)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Live stream not found');
      }

      if (stream.vendor_id !== vendorId) {
        throw new ForbiddenException('Only stream owner can add products');
      }

      if (stream.status !== 'live' && stream.status !== 'setup') {
        throw new BadRequestException('Can only add products to live or setup streams');
      }

      if (stream.stream_type !== 'products') {
        throw new BadRequestException('Can only add products to product streams');
      }

      // Check if product already exists in stream
      const { data: existingProduct } = await this.supabase
        .from('live_stream_products')
        .select('id')
        .eq('stream_id', streamId)
        .eq('product_id', productDto.product_id)
        .single();

      if (existingProduct) {
        throw new BadRequestException('Product already exists in this stream');
      }

      // Get current max display_order
      const { data: existingProducts } = await this.supabase
        .from('live_stream_products')
        .select('display_order')
        .eq('stream_id', streamId)
        .order('display_order', { ascending: false })
        .limit(1);

      const displayOrder = productDto.display_order || ((existingProducts?.[0]?.display_order || -1) + 1);

      // Use service role client to bypass RLS policies
      // This ensures products are always added successfully without timing/transaction issues
      // We've already verified ownership above, so this is safe
      const { data: newProduct, error: insertError } = await this.supabase
        .from('live_stream_products')
        .insert({
          stream_id: streamId,
          product_id: productDto.product_id,
          live_price: productDto.live_price,
          live_stock: productDto.live_stock,
          original_stock: productDto.live_stock,
          display_order: displayOrder,
          is_featured: productDto.is_featured || false,
        })
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
        .single();

      if (insertError || !newProduct) {
        throw new BadRequestException(`Failed to add product: ${insertError?.message}`);
      }

      this.logEvent('log', 'product_added_to_stream', {
        streamId,
        vendorId,
        productId: productDto.product_id,
      });

      return newProduct;
    } catch (error) {
      this.logEvent('error', 'add_product_to_stream_error', { streamId, vendorId }, error instanceof Error ? error : new Error(String(error)));
      throw error instanceof BadRequestException || error instanceof ForbiddenException || error instanceof NotFoundException
        ? error
        : new BadRequestException('Failed to add product to stream');
    }
  }

  // =====================
  // VIEWER MANAGEMENT
  // =====================

  /**
   * Join a live stream as a viewer
   */
  async joinStream(streamId: string, userId: string, accessToken?: string, retryCount = 0): Promise<void> {
    try {
      // Check if stream exists and is live
      this.logger.log(`🔍 Checking stream ${streamId} status for join (retry: ${retryCount})`);

      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('status')
        .eq('id', streamId)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Live stream not found');
      }

      this.logger.log(`📊 Stream ${streamId} status from DB: ${stream.status}`);

      // ✅ RETRY LOGIC: Handle race condition between updateStreamStatus and joinStream
      if (stream.status !== StreamStatus.LIVE && retryCount < 3) {
        this.logger.log(`Stream ${streamId} not live yet, retrying... (${retryCount + 1}/3)`);
        await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1))); // Progressive delay: 100ms, 200ms, 300ms
        return this.joinStream(streamId, userId, accessToken, retryCount + 1);
      }

      if (stream.status !== StreamStatus.LIVE) {
        throw new BadRequestException('Stream is not currently live');
      }

      // Insert or update viewer record
      // ✅ Use user client for viewer operations (respects RLS policies)
      const clientForViewerOps = accessToken
        ? createUserSupabaseClient(this.configService, accessToken)
        : this.supabase;

      const { error: viewerError } = await clientForViewerOps
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

      if (error) {
        // Properly serialize Supabase error before throwing
        const errorMessage = error.message || JSON.stringify(error);
        throw new Error(`Failed to save reaction: ${errorMessage}`);
      }

      // Log analytics
      await this.logAnalytics(sendReactionDto.stream_id, 'reaction', 1, {
        user_id: userId,
        reaction_type: sendReactionDto.reaction_type,
      });
    } catch (error) {
      // Properly extract error message
      let errorMessage = 'Failed to send reaction';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else if (error && typeof error === 'object') {
        errorMessage = (error as any).message || JSON.stringify(error);
      }
      
      this.logEvent('error', 'send_reaction_exception', {
        streamId: sendReactionDto.stream_id,
        userId,
        error: errorMessage,
      }, error instanceof Error ? error : new Error(errorMessage));
      
      throw new BadRequestException(
        errorMessage.includes('not found')
          ? 'Stream not found or not live'
          : errorMessage.includes('violates row-level security')
          ? 'Unable to send reaction. Please try again.'
          : `Failed to send reaction: ${errorMessage}`
      );
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorDetails = error instanceof Error ? error.stack : JSON.stringify(error);
      
      this.logEvent('error', 'send_gift_exception', {
        streamId: sendGiftDto.stream_id,
        userId,
        giftType: sendGiftDto.gift_type,
        quantity: sendGiftDto.quantity,
        error: errorMessage,
        errorDetails,
      }, error instanceof Error ? error : new Error(String(error)));
      
      // Re-throw specific exceptions as-is
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      
      // Provide more descriptive error message
      throw new BadRequestException(
        errorMessage.includes('balance') 
          ? 'Insufficient wallet balance for gift'
          : errorMessage.includes('not found')
          ? 'Gift type or stream not found'
          : `Failed to send gift: ${errorMessage}`
      );
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
      this.logger.debug(`🔍 Querying live_stream_products for stream_id: ${purchaseDto.stream_id}, product_id: ${purchaseDto.product_id}`);
      
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
            user_id
          )
        `)
        .eq('stream_id', purchaseDto.stream_id)
        .eq('product_id', purchaseDto.product_id)
        .single();

      if (productError) {
        this.logger.error(`❌ Error querying live_stream_products:`, {
          error: productError,
          code: productError.code,
          message: productError.message,
          details: productError.details,
          hint: productError.hint,
          stream_id: purchaseDto.stream_id,
          product_id: purchaseDto.product_id,
        });
        
        // Check if it's a "not found" error (PGRST116) or something else
        if (productError.code === 'PGRST116') {
          // Try to see if product exists at all in the stream
          const { data: allProducts, error: checkError } = await this.supabase
            .from('live_stream_products')
            .select('id, product_id, stream_id')
            .eq('stream_id', purchaseDto.stream_id);
          
          this.logger.debug(`📦 Products in stream ${purchaseDto.stream_id}:`, {
            count: allProducts?.length || 0,
            products: allProducts,
            checkError,
          });
        }
        
        throw new NotFoundException('Product not found in this stream');
      }

      if (!liveProduct) {
        this.logger.error(`❌ No product returned (but no error) for stream_id: ${purchaseDto.stream_id}, product_id: ${purchaseDto.product_id}`);
        throw new NotFoundException('Product not found in this stream');
      }

      this.logger.debug(`✅ Found live product:`, {
        id: liveProduct.id,
        product_id: liveProduct.product_id,
        stream_id: purchaseDto.stream_id,
      });

      // 3. Check for duplicate purchase (idempotency) - BEFORE stock deduction
      // Prevent duplicate purchases within last 30 seconds for same product and quantity
      // Increased window to account for slow networks and retries
      const duplicateCheckWindowMs = this.configService.get<number>('LIVE_SALES_DUPLICATE_WINDOW_MS') || 30000; // Default 30 seconds
      const duplicateCheckWindow = new Date(Date.now() - duplicateCheckWindowMs).toISOString();

      // Get product vendor ID for duplicate check and order creation
      // Note: We'll get this from liveProduct.product.user_id after fetching the product
      // For now, use stream.vendor_id in duplicate check (will be updated after product fetch)
      
      // Check for recent orders with same product and quantity
      // Note: This check happens before we fetch the product, so we use stream.vendor_id as approximation
      // The actual vendor_id will be set correctly when creating the order
      const { data: recentOrders, error: duplicateError } = await this.supabase
        .from('orders')
        .select('id, order_number, status, created_at, metadata')
        .eq('buyer_id', userId)
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
      // Use product owner (product.user_id) as vendor_id, not stream owner
      // This ensures the product owner receives payment, even if products from different vendors are in the same stream
      const productVendorId = liveProduct.product.user_id;
      
      // Validate required data before attempting order creation
      if (!userId || !productVendorId || !totalAmount) {
        this.logEvent('error', 'invalid_purchase_order_data', {
          purchaseId,
          userId,
          productVendorId,
          streamVendorId: stream.vendor_id,
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
            vendor_id: productVendorId, // Use product owner, not stream owner
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
              booking_type: 'product', // Distinguish product purchases within live_stream
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
            productVendorId,
            streamVendorId: stream.vendor_id,
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
        productVendorId,
        streamVendorId: stream.vendor_id,
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

        // Generate handoff PINs (3-digit) for order verification
        // For self-pickup: only delivery PIN needed (buyer shows to vendor)
        // For regular delivery: both PINs needed (pickup PIN for rider→vendor, delivery PIN for rider→buyer)
        const pickupPin = Math.floor(100 + Math.random() * 900).toString(); // 3-digit (100-999)
        const deliveryPin = Math.floor(100 + Math.random() * 900).toString(); // 3-digit (100-999)
        
        // Update order with PINs and keep status as 'pending' so vendor can accept it
        // Status will change to 'processing' when vendor accepts, then 'paid' when completed
        await this.supabase
          .from('orders')
          .update({ 
            pickup_pin: pickupPin,
            delivery_pin: deliveryPin,
            status: 'pending', // Keep as 'pending' so vendor can accept the order
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        
        this.logEvent('log', 'pins_generated', {
          purchaseId,
          orderId: order.id,
          orderNumber: order.order_number,
          pickupPin,
          deliveryPin,
          deliveryType: purchaseDto.rider_id ? 'delivery' : 'pickup',
        });

        // Send PIN notifications to relevant parties
        try {
          // Get vendor profile for notifications (use product owner, not stream owner)
          const { data: vendorProfile } = await this.supabase
            .from('user_profiles')
            .select('username')
            .eq('id', productVendorId)
            .single();

          const deliveryType = purchaseDto.rider_id ? 'delivery' : 'pickup';
          
          if (deliveryType === 'pickup') {
            // Self-pickup: Send deliveryPin to BOTH vendor and buyer
            // Buyer provides deliveryPin to vendor for handoff verification
            
            // Send deliveryPin to vendor (for verification) - use product owner
            await this.notificationHelper.notifyVendorSelfPickupPin(productVendorId, {
              id: order.id,
              orderNumber: order.order_number,
              deliveryPin: deliveryPin,
              buyerName: 'Live Stream Customer', // Could fetch buyer username if needed
            });
            this.logEvent('log', 'pickup_pin_sent_to_vendor', {
              orderId: order.id,
              productVendorId,
            });

            // Send deliveryPin to buyer (to provide to vendor)
            await this.notificationHelper.notifyBuyerSelfPickupPin(userId, {
              id: order.id,
              orderNumber: order.order_number,
              deliveryPin: deliveryPin,
              vendorName: vendorProfile?.username,
            });
            this.logEvent('log', 'pickup_pin_sent_to_buyer', {
              orderId: order.id,
              buyerId: userId,
            });
          } else {
            // Regular delivery: Send pickupPin to rider, deliveryPin to buyer
            
            // Send pickup PIN to rider
            if (purchaseDto.rider_id) {
              await this.notificationHelper.notifyRiderPickupPin(purchaseDto.rider_id, {
                id: order.id,
                orderNumber: order.order_number,
                pickupPin: pickupPin,
                vendorName: vendorProfile?.username,
              });
              this.logEvent('log', 'pickup_pin_sent_to_rider', {
                orderId: order.id,
                riderId: purchaseDto.rider_id,
              });
            }

            // Send delivery PIN to buyer
            await this.notificationHelper.notifyBuyerDeliveryPin(userId, {
              id: order.id,
              orderNumber: order.order_number,
              deliveryPin: deliveryPin,
            });
            this.logEvent('log', 'delivery_pin_sent_to_buyer', {
              orderId: order.id,
              buyerId: userId,
            });
          }
        } catch (pinNotifyError) {
          this.logEvent('warn', 'pin_notification_failed', {
            orderId: order.id,
            error: pinNotifyError instanceof Error ? pinNotifyError.message : String(pinNotifyError),
          });
          // Don't throw - PIN notification failure is non-critical
        }

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

      // 12. Notify vendor of new order (notify product owner, not stream owner)
      try {
        await this.notificationHelper.notifyVendorNewOrder(productVendorId, {
          id: order.id,
          orderNumber: order.order_number,
          totalAmount: totalAmount,
          itemCount: 1,
          buyerName: 'Live Stream Customer', // Could fetch buyer profile if needed
        });

        // Notify vendor payment is in escrow
        await this.notificationHelper.notifyVendorOrderPaid(productVendorId, {
          orderId: order.id,
          orderNumber: order.order_number,
          vendorAmount: vendorAmount,
          escrowId: order.id, // Using order ID as escrow reference
        });

        this.logEvent('debug', 'vendor_notified', {
          productVendorId,
          streamVendorId: stream.vendor_id,
          orderId: order.id,
        });
      } catch (notifyError) {
        this.logEvent('warn', 'vendor_notification_failed', {
          productVendorId,
          streamVendorId: stream.vendor_id,
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
        .eq('source', 'live_stream')
        .eq('metadata->>booking_type', 'service')
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
            source: 'live_stream',
            metadata: {
              stream_id: bookingDto.stream_id,
              booking_type: 'service', // Distinguish service bookings within live_stream
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
   * Start HLS Cloud Recording for a live stream
   *
   * Uses Agora's Cloud Recording API (3-step process):
   * 1. Acquire - Get a resource ID
   * 2. Start - Begin recording with HLS configuration + S3 storage
   * 3. Store resourceId/sid for later Query/Stop
   * 
   * Note: This starts 10 seconds after stream goes live to ensure video is publishing
   */
  async startHLSConversion(streamId: string): Promise<void> {
    try {
      const appId = this.configService.get<string>('AGORA_APP_ID');
      
      // Cloud Recording API requires Customer ID & Customer Secret (NOT App ID & Certificate)
      // These are generated in Agora Console → Developer Toolkit → RESTful API
      const customerId = this.configService.get<string>('AGORA_CUSTOMER_ID');
      const customerSecret = this.configService.get<string>('AGORA_CUSTOMER_SECRET');
      
      const channelName = `fretiko_${streamId}`;

      // AWS S3 Configuration
      const s3Bucket = this.configService.get<string>('AWS_S3_BUCKET') || this.configService.get<string>('CLOUD_STORAGE_BUCKET');
      const s3Region = this.configService.get<string>('AWS_S3_REGION') || 'us-east-1';
      const awsAccessKey = this.configService.get<string>('AWS_ACCESS_KEY_ID') || this.configService.get<string>('CLOUD_STORAGE_ACCESS_KEY');
      const awsSecretKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY') || this.configService.get<string>('CLOUD_STORAGE_SECRET_KEY');

      if (!appId) {
        throw new BadRequestException('Agora App ID not configured');
      }

      if (!customerId || !customerSecret) {
        this.logger.warn(`⚠️ Agora Customer ID/Secret not configured for stream ${streamId}, skipping HLS recording`);
        this.logger.warn(`Generate these in: Agora Console → Developer Toolkit → RESTful API → Add a secret`);
        return; // Don't throw - allow stream to continue without HLS
      }

      if (!s3Bucket || !awsAccessKey || !awsSecretKey) {
        this.logger.warn(`⚠️ AWS S3 credentials not configured for stream ${streamId}, skipping HLS recording`);
        return; // Don't throw - allow stream to continue without HLS
      }

      // Generate Agora REST API authentication using Customer credentials
      const plainCredentials = `${customerId}:${customerSecret}`;
      const encodedCredentials = Buffer.from(plainCredentials).toString('base64');

      // Map AWS region to Agora region code
      // Common mappings: us-east-1 -> 0, us-west-1 -> 1, eu-west-1 -> 2, etc.
      const regionMap: Record<string, number> = {
        'us-east-1': 0,
        'us-west-1': 1,
        'eu-west-1': 2,
        'ap-southeast-1': 3,
        'ap-northeast-1': 4,
        'ap-southeast-2': 5,
        'eu-central-1': 6,
        'us-west-2': 7,
        'ap-south-1': 8,
        'sa-east-1': 9,
        'ca-central-1': 10,
        'eu-west-2': 11,
        'eu-west-3': 12,
        'ap-northeast-2': 13,
        'ap-east-1': 14,
        'eu-north-1': 15, // Stockholm, Sweden
      };
      const agoraRegion = regionMap[s3Region] ?? 0;

      // Wait 10 seconds to ensure video is publishing
      await new Promise(resolve => setTimeout(resolve, 10000));

      this.logEvent('log', 'starting_cloud_recording_acquisition', {
        streamId,
        channelName,
        appId,
        s3Bucket,
        s3Region,
      });

      // Step 1: Acquire - Get a resource ID
      const acquireUrl = `https://api.agora.io/v1/apps/${appId}/cloud_recording/acquire`;
      const acquireResponse = await fetch(acquireUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${encodedCredentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cname: channelName,
          uid: '0', // Use string UID for cloud recording
          clientRequest: {
            resourceExpiredHour: 24,
          },
        }),
      });

      if (!acquireResponse.ok) {
        const errorData = await acquireResponse.json();
        this.logEvent('warn', 'cloud_recording_acquire_failed', {
          streamId,
          status: acquireResponse.status,
          error: JSON.stringify(errorData),
        });
        throw new Error(`Cloud Recording acquire failed: ${acquireResponse.statusText}`);
      }

      const acquireData = await acquireResponse.json();
      const resourceId = acquireData.resourceId;

      this.logEvent('log', 'cloud_recording_acquired', {
        streamId,
        resourceId,
      });

      // Step 2: Start - Begin HLS recording with S3 storage
      const startUrl = `https://api.agora.io/v1/apps/${appId}/cloud_recording/resourceid/${resourceId}/mode/mix/start`;
      const startResponse = await fetch(startUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${encodedCredentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cname: channelName,
          uid: '0',
          clientRequest: {
            recordingConfig: {
              maxIdleTime: 300, // Stop after 5 mins of no activity
              streamTypes: 2, // 0=audio only, 1=video only, 2=audio+video ✅
              channelType: 1, // 0=communication, 1=live broadcast ✅
              videoStreamType: 0, // 0=high stream, 1=low stream
              subscribeVideoUids: ['#allstream#'], // Subscribe to all video streams
              subscribeAudioUids: ['#allstream#'], // Subscribe to all audio streams
            },
            recordingFileConfig: {
              avFileType: ['hls'], // ✅ CRITICAL: Enable HLS output (.m3u8 + .ts)
            },
            storageConfig: {
              vendor: 1, // 1 = Amazon S3 ✅
              region: agoraRegion, // Mapped from AWS region
              bucket: s3Bucket,
              accessKey: awsAccessKey,
              secretKey: awsSecretKey,
              fileNamePrefix: ['streams', streamId], // S3 path: streams/streamId/
            },
          },
        }),
      });

      if (!startResponse.ok) {
        const errorData = await startResponse.json();
        this.logEvent('warn', 'cloud_recording_start_failed', {
          streamId,
          resourceId,
          status: startResponse.status,
          error: JSON.stringify(errorData),
        });
        throw new Error(`Cloud Recording start failed: ${startResponse.statusText}`);
      }

      const startData = await startResponse.json();
      const sid = startData.sid;

      // First verify the stream exists
      const { data: streamCheck, error: checkError } = await this.supabase
        .from('live_streams')
        .select('id, status')
        .eq('id', streamId)
        .single();

      if (checkError || !streamCheck) {
        this.logger.error(`❌ Stream ${streamId} not found in database: ${checkError?.message || 'No data returned'}`);
        throw new Error(`Stream not found: ${streamId}`);
      }

      // Store resourceId and sid in database for later use (query/stop)
      // IMPORTANT: Use service role client (this.supabase) to bypass RLS
      // User clients may not have permission to update these system fields
      const { data: updateResult, error: dbError } = await this.supabase
        .from('live_streams')
        .update({
          agora_resource_id: resourceId,
          agora_sid: sid,
        })
        .eq('id', streamId)
        .select('agora_resource_id, agora_sid'); // ✅ Verify the update worked

      if (dbError) {
        this.logger.error(`❌ Failed to save Cloud Recording IDs to database: ${dbError.message}`);
        this.logger.error(`   Full error: ${JSON.stringify(dbError)}`);
        throw new Error(`Database update failed: ${dbError.message}`);
      }

      // Double-check the values were actually saved
      if (!updateResult || updateResult.length === 0 || !updateResult[0].agora_resource_id) {
        this.logger.error(`❌ Database update returned no data or null resourceId. Update result: ${JSON.stringify(updateResult)}`);
        this.logger.error(`   Stream exists: ${!!streamCheck}, Stream status: ${streamCheck?.status}`);
        // Try a direct query to see what's in the DB
        const { data: verifyData } = await this.supabase
          .from('live_streams')
          .select('id, agora_resource_id, agora_sid')
          .eq('id', streamId)
          .single();
        this.logger.error(`   Direct query result: ${JSON.stringify(verifyData)}`);
        throw new Error('Database update verification failed - IDs not saved');
      }

      this.logger.log(`✅ Verified Cloud Recording IDs saved: resourceId=${resourceId.substring(0, 20)}..., sid=${sid}`);
      
      // 🚀 Start polling for HLS URL (available while live, not just at end)
      // HLS URL becomes available 10-30 seconds after recording starts
      this.pollForHLSURL(streamId, resourceId, sid).catch(err => {
        this.logger.warn(`⚠️ HLS URL polling failed for stream ${streamId}: ${err.message}`);
      });
    

      this.logEvent('log', 'cloud_recording_started', {
        streamId,
        resourceId,
        sid,
        s3Bucket,
      });

      this.logger.log(`✅ Cloud Recording (HLS) started for stream ${streamId}, storing to S3: ${s3Bucket}`);
    } catch (error) {
      this.logEvent('error', 'cloud_recording_exception', {
        streamId,
      }, error instanceof Error ? error : new Error(String(error)));
      // Don't throw - let stream continue without HLS
      this.logger.warn(`⚠️ HLS conversion failed for stream ${streamId}, continuing without HLS`);
    }
  }

  /**
   * Poll Agora Cloud Recording API to get HLS URL while stream is live
   * HLS URL becomes available 10-30 seconds after recording starts
   */
  private async pollForHLSURL(streamId: string, resourceId: string, sid: string, maxAttempts: number = 20): Promise<void> {
    const appId = this.configService.get<string>('AGORA_APP_ID');
    const customerId = this.configService.get<string>('AGORA_CUSTOMER_ID');
    const customerSecret = this.configService.get<string>('AGORA_CUSTOMER_SECRET');
    const s3Bucket = this.configService.get<string>('AWS_S3_BUCKET') || this.configService.get<string>('CLOUD_STORAGE_BUCKET');
    const s3Region = this.configService.get<string>('AWS_S3_REGION') || 'us-east-1';

    if (!appId || !customerId || !customerSecret || !s3Bucket) {
      this.logger.warn(`⚠️ Missing Agora/S3 config for HLS polling on stream ${streamId}`);
      return;
    }

    const channelName = `fretiko_${streamId}`;
    const plainCredentials = `${customerId}:${customerSecret}`;
    const encodedCredentials = Buffer.from(plainCredentials).toString('base64');

    let attempts = 0;
    const pollInterval = 5000; // Poll every 5 seconds

    const poll = async (): Promise<void> => {
      attempts++;

      // Check if stream is still live
      const { data: stream } = await this.supabase
        .from('live_streams')
        .select('status, stream_url')
        .eq('id', streamId)
        .single();

      if (!stream || stream.status !== 'live') {
        this.logger.log(`🛑 Stream ${streamId} is no longer live, stopping HLS polling`);
        return;
      }

      // If HLS URL already exists, we're done
      if (stream.stream_url) {
        this.logger.log(`✅ HLS URL already available for stream ${streamId}`);
        return;
      }

      try {
        // Query Agora Cloud Recording status
        const queryUrl = `https://api.agora.io/v1/apps/${appId}/cloud_recording/resourceid/${resourceId}/sid/${sid}/mode/mix/query`;
        const queryResponse = await fetch(queryUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${encodedCredentials}`,
            'Content-Type': 'application/json',
          },
        });

        if (!queryResponse.ok) {
          if (attempts < maxAttempts) {
            this.logger.log(`⏳ HLS not ready yet for stream ${streamId} (attempt ${attempts}/${maxAttempts}), retrying...`);
            setTimeout(poll, pollInterval);
          } else {
            this.logger.warn(`⚠️ HLS URL polling timed out for stream ${streamId} after ${maxAttempts} attempts`);
          }
          return;
        }

        const queryData = await queryResponse.json();
        const serverResponse = queryData.serverResponse;

        // Check if recording has uploaded files
        if (serverResponse?.fileList && serverResponse.fileList.length > 0) {
          // Find HLS file (usually ends with .m3u8)
          const hlsFile = serverResponse.fileList.find((file: any) => 
            file.fileName?.endsWith('.m3u8') || file.fileName?.includes('index.m3u8')
          );

          if (hlsFile && hlsFile.fileName) {
            // Construct S3 HLS URL
            // Format: https://{bucket}.s3.{region}.amazonaws.com/streams/{streamId}/{fileName}
            const hlsUrl = `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/streams/${streamId}/${hlsFile.fileName}`;

            // Update stream_url in database
        const { error: updateError } = await this.supabase
          .from('live_streams')
          .update({ stream_url: hlsUrl })
          .eq('id', streamId);

        if (updateError) {
              this.logger.error(`❌ Failed to update HLS URL in database: ${updateError.message}`);
        } else {
              this.logger.log(`✅ HLS URL available and saved for stream ${streamId}: ${hlsUrl.substring(0, 80)}...`);
              return; // Success!
            }
          }
        }

        // If no HLS file yet, continue polling
        if (attempts < maxAttempts) {
          this.logger.log(`⏳ HLS file not uploaded yet for stream ${streamId} (attempt ${attempts}/${maxAttempts}), retrying in ${pollInterval/1000}s...`);
          setTimeout(poll, pollInterval);
        } else {
          this.logger.warn(`⚠️ HLS URL polling timed out for stream ${streamId} after ${maxAttempts} attempts`);
        }
      } catch (error) {
        this.logger.error(`❌ Error polling HLS URL for stream ${streamId}: ${error instanceof Error ? error.message : String(error)}`);
        if (attempts < maxAttempts) {
          setTimeout(poll, pollInterval);
        }
      }
    };

    // Start polling after initial delay (HLS takes 10-30 seconds to be available)
    setTimeout(poll, 15000); // Wait 15 seconds before first poll
  }

  /**
   * Stop Cloud Recording and get HLS URL from S3
   */
  async stopHLSRecording(streamId: string): Promise<{ hlsUrl: string } | null> {
    try {
      this.logger.log(`🛑 Attempting to stop Cloud Recording for stream ${streamId}`);
      
      // Query with explicit field selection and logging
      const { data: stream, error: dbError } = await this.supabase
        .from('live_streams')
        .select('agora_resource_id, agora_sid, status, vendor_id')
        .eq('id', streamId)
        .single();

      if (dbError) {
        this.logger.error(`❌ Database error fetching recording for stream ${streamId}: ${dbError.message}`);
        this.logger.error(`   Full error: ${JSON.stringify(dbError)}`);
        return null;
      }

      this.logger.log(`📊 Stream data from DB: ${JSON.stringify({
            streamId,
        hasResourceId: !!stream?.agora_resource_id,
        hasSid: !!stream?.agora_sid,
        resourceIdLength: stream?.agora_resource_id?.length || 0,
        sidLength: stream?.agora_sid?.length || 0,
        status: stream?.status
      })}`);

      if (!stream?.agora_resource_id || !stream?.agora_sid) {
        this.logger.warn(`⚠️ No Cloud Recording found for stream ${streamId}. Found in DB: resourceId=${stream?.agora_resource_id || 'null'}, sid=${stream?.agora_sid || 'null'}`);
        this.logger.warn(`   This means either: 1) Recording never started, 2) Database update failed, 3) IDs were cleared by another operation`);
        return null;
      }

      const appId = this.configService.get<string>('AGORA_APP_ID');
      
      // Cloud Recording API requires Customer ID & Customer Secret
      const customerId = this.configService.get<string>('AGORA_CUSTOMER_ID');
      const customerSecret = this.configService.get<string>('AGORA_CUSTOMER_SECRET');
      
      const channelName = `fretiko_${streamId}`;
      const s3Bucket = this.configService.get<string>('AWS_S3_BUCKET') || this.configService.get<string>('CLOUD_STORAGE_BUCKET');
      const s3Region = this.configService.get<string>('AWS_S3_REGION') || 'us-east-1';

      if (!s3Bucket || !s3Region) {
        this.logger.warn(`S3 configuration missing for stream ${streamId}`);
        return null;
      }

      if (!customerId || !customerSecret) {
        this.logger.warn(`Agora Customer credentials missing for stream ${streamId}`);
        return null;
      }

      const plainCredentials = `${customerId}:${customerSecret}`;
      const encodedCredentials = Buffer.from(plainCredentials).toString('base64');

      // Step 3: Stop recording
      const stopUrl = `https://api.agora.io/v1/apps/${appId}/cloud_recording/resourceid/${stream.agora_resource_id}/sid/${stream.agora_sid}/mode/mix/stop`;
      const stopResponse = await fetch(stopUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${encodedCredentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cname: channelName,
          uid: '0',
          clientRequest: {
            async_stop: false, // Wait for upload to complete
          },
        }),
      });

      if (!stopResponse.ok) {
        const errorData = await stopResponse.json();
        this.logger.error(`Stop recording failed: ${JSON.stringify(errorData)}`);
        return null;
      }

      const stopData = await stopResponse.json();
      
      // Wait for upload status to be "uploaded"
      if (stopData.serverResponse?.fileList?.[0]?.uploadingStatus === 'uploaded') {
        const fileName = stopData.serverResponse.fileList[0].fileName;
        const hlsUrl = `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/${fileName}`;
        
        // Update stream with HLS URL
        await this.supabase
          .from('live_streams')
          .update({ stream_url: hlsUrl })
          .eq('id', streamId);

        this.logger.log(`✅ HLS recording uploaded to S3: ${hlsUrl}`);
        return { hlsUrl };
      }

      this.logger.warn(`Recording upload not complete yet for stream ${streamId}`);
      return null;
    } catch (error) {
      this.logger.error(`Error stopping recording: ${error}`);
      return null;
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
      // Verify stream exists and check status
      const { data: stream, error } = await this.supabase
        .from('live_streams')
        .select('status, stream_url, agora_resource_id')
        .eq('id', streamId)
        .single();

      if (error || !stream) {
        throw new NotFoundException('Stream not found');
      }

      // ✅ INDUSTRY STANDARD: LIVE streams use RTC, not HLS!
      // HLS is ONLY for VOD replays after stream ends
      if (stream.status === 'live') {
        return {
          hlsUrl: '',
          status: 'Stream is LIVE - viewers should use Agora RTC for real-time viewing. HLS is for VOD replays only.'
        };
      }

      // ✅ ENDED streams: HLS URL from Cloud Recording (S3)
      if (stream.status === 'ended' && stream.stream_url) {
        return {
          hlsUrl: stream.stream_url,
          status: 'VOD replay available from Cloud Recording'
        };
      }

      // ✅ ENDED but HLS not ready yet
      if (stream.status === 'ended' && stream.agora_resource_id) {
      return {
        hlsUrl: '',
          status: 'Cloud Recording is finalizing... HLS replay will be available shortly'
        };
      }

      // ✅ Stream not started or no recording
      return {
        hlsUrl: '',
        status: `Stream is ${stream.status}. No HLS replay available.`
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
          source_filter: ['live_stream'],
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
   * Cleanup abandoned live streams
   * Ends live streams that have been running for more than 8 hours or
   * have no vendor connected for more than 30 minutes
   * Runs every 30 minutes
   */
  @Cron('*/30 * * * *') // Every 30 minutes
  async cleanupAbandonedStreams(): Promise<void> {
    try {
      const now = new Date();
      const eightHoursAgo = new Date(now.getTime() - 8 * 60 * 60 * 1000);
      const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

      this.logger.log('🧹 Starting cleanup of abandoned live streams');

      // Find live streams that have been running for more than 8 hours
      const { data: oldStreams, error: oldStreamsError } = await this.supabase
        .from('live_streams')
        .select('id, vendor_id, title, started_at')
        .eq('status', 'live')
        .lt('started_at', eightHoursAgo.toISOString());

      if (oldStreamsError) {
        this.logger.error('Failed to find old live streams:', oldStreamsError.message);
      } else if (oldStreams && oldStreams.length > 0) {
        this.logger.log(`Found ${oldStreams.length} streams running for >8 hours`);

        for (const stream of oldStreams) {
          try {
            // End the stream automatically
            await this.endStream(stream.id, stream.vendor_id, undefined); // No access token available in cron
            this.logger.log(`🏁 Auto-ended old stream: ${stream.title} (${stream.id})`);

            this.logEvent('log', 'stream_auto_ended_old', {
              streamId: stream.id,
              vendorId: stream.vendor_id,
              reason: 'running_too_long',
              durationHours: Math.floor((now.getTime() - new Date(stream.started_at).getTime()) / (1000 * 60 * 60)),
            });
          } catch (endError) {
            this.logger.error(`Failed to end old stream ${stream.id}:`, endError);
          }
        }
      }

      // Find live streams with no recent vendor activity
      // This is harder to detect since we don't track vendor connection times
      // For now, we'll rely on the disconnect handling to end streams when vendors leave

      this.logger.log('✅ Abandoned streams cleanup completed');
    } catch (error) {
      this.logger.error('Error in abandoned streams cleanup:', error);
      this.logEvent('error', 'cleanup_abandoned_streams_error', {},
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

  // =====================
  // PORTFOLIO SERVICES
  // =====================

  /**
   * Get portfolio services for a stream
   */
  async getPortfolioServices(streamId: string): Promise<any[]> {
    try {
      // Get portfolio services with their images
      const { data: portfolioServices, error: portfolioError } = await this.supabase
        .from('live_portfolio_services')
        .select(`
          id,
          stream_id,
          title,
          description,
          price,
          category,
          impressions,
          add_to_cart_clicks,
          bookings,
          revenue,
          display_order,
          created_at,
          images:live_portfolio_images!portfolio_id (
            id,
            image_url,
            caption,
            display_order,
            is_primary
          )
        `)
        .eq('stream_id', streamId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: false });

      if (portfolioError) {
        this.logEvent('error', 'get_portfolio_services_failed', { streamId }, portfolioError);
        throw new BadRequestException('Failed to fetch portfolio services');
      }

      // Transform data to match frontend expectations
      const transformed = (portfolioServices || []).map((service: any) => ({
        id: service.id,
        stream_id: service.stream_id,
        title: service.title,
        description: service.description,
        price: parseFloat(service.price) || 0,
        category: service.category,
        display_order: service.display_order || 0,
        created_at: service.created_at,
        images: (service.images || []).map((img: any) => ({
          id: img.id,
          url: img.image_url,
          caption: img.caption,
          display_order: img.display_order || 0,
          is_primary: img.is_primary || false,
        })),
        // Analytics
        impressions: service.impressions || 0,
        add_to_cart_clicks: service.add_to_cart_clicks || 0,
        bookings: service.bookings || 0,
        revenue: parseFloat(service.revenue) || 0,
      }));

      return transformed;
    } catch (error) {
      this.logEvent('error', 'get_portfolio_services_error', { streamId }, error instanceof Error ? error : new Error(String(error)));
      throw new BadRequestException('Failed to fetch portfolio services');
    }
  }

  /**
   * Book a portfolio service during live stream
   */
  async bookPortfolioService(
    userId: string,
    bookingDto: {
      stream_id: string;
      portfolio_id: string;
      service_date: string;
      service_time: string;
      service_notes?: string;
    },
  ): Promise<TransactionResponse> {
    const startTime = Date.now();
    const bookingId = `portfolio_booking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Input validation
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new BadRequestException('Invalid user ID');
    }

    if (!bookingDto.stream_id || typeof bookingDto.stream_id !== 'string') {
      throw new BadRequestException('Invalid stream ID');
    }

    if (!bookingDto.portfolio_id || typeof bookingDto.portfolio_id !== 'string') {
      throw new BadRequestException('Invalid portfolio ID');
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

    this.logEvent('log', 'portfolio_booking_initiated', {
      bookingId,
      userId,
      streamId: bookingDto.stream_id,
      portfolioId: bookingDto.portfolio_id,
      serviceDate: bookingDto.service_date,
      serviceTime: bookingDto.service_time,
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
        throw new BadRequestException('Cannot book portfolio services from inactive streams');
      }

      if (stream.vendor_id === userId) {
        throw new BadRequestException('Cannot book portfolio services from your own stream');
      }

      // 2. Get portfolio service details
      const { data: portfolioService, error: portfolioError } = await this.supabase
        .from('live_portfolio_services')
        .select(`
          id,
          stream_id,
          title,
          description,
          price,
          category
        `)
        .eq('id', bookingDto.portfolio_id)
        .eq('stream_id', bookingDto.stream_id)
        .eq('is_active', true)
        .is('deleted_at', null)
        .single();

      if (portfolioError || !portfolioService) {
        throw new NotFoundException('Portfolio service not found in this stream');
      }

      // 3. Check for duplicate booking (idempotency)
      const duplicateCheckWindowMs = this.configService.get<number>('LIVE_SALES_DUPLICATE_WINDOW_MS') || 30000;
      const duplicateCheckWindow = new Date(Date.now() - duplicateCheckWindowMs).toISOString();
      const { data: recentBooking, error: duplicateError } = await this.supabase
        .from('orders')
        .select('id, order_number, status, created_at, metadata')
        .eq('buyer_id', userId)
        .eq('vendor_id', stream.vendor_id)
        .eq('source', 'live_stream')
        .eq('metadata->>booking_type', 'portfolio')
        .in('status', ['pending', 'paid', 'processing'])
        .gte('created_at', duplicateCheckWindow)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (duplicateError) {
        this.logEvent('warn', 'portfolio_duplicate_check_failed', {
          bookingId,
          userId,
          streamId: bookingDto.stream_id,
          error: duplicateError.message,
        });
      }

      if (recentBooking) {
        const recentMetadata = recentBooking.metadata as any;
        if (recentMetadata?.portfolio_id === bookingDto.portfolio_id &&
            recentMetadata?.booking_date === bookingDto.service_date &&
            recentMetadata?.booking_time === bookingDto.service_time) {
          const timeSinceBooking = Date.now() - new Date(recentBooking.created_at).getTime();
          this.logEvent('log', 'duplicate_portfolio_booking_detected', {
            bookingId,
            userId,
            streamId: bookingDto.stream_id,
            portfolioId: bookingDto.portfolio_id,
            recentOrderId: recentBooking.id,
            timeSinceBooking,
          });

          return {
            id: recentBooking.metadata?.transaction_id || `dup_${recentBooking.id}`,
            stream_id: bookingDto.stream_id,
            transaction_type: TransactionType.SERVICE,
            total_amount: recentBooking.total_amount,
            status: TransactionStatus.PENDING,
            service: {
              date: bookingDto.service_date,
              time: bookingDto.service_time,
              notes: recentMetadata?.service_notes,
            },
            created_at: recentBooking.created_at,
          };
        }
      }

      // 4. Calculate pricing
      const servicePrice = parseFloat(portfolioService.price) || 0;
      if (servicePrice <= 0) {
        throw new BadRequestException('Portfolio service price must be greater than zero');
      }

      const platformFeeRate = 0.05; // 5% platform fee
      const platformFee = servicePrice * platformFeeRate;
      const vendorAmount = servicePrice - platformFee;

      this.logEvent('log', 'portfolio_booking_calculation', {
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
        throw new BadRequestException('Insufficient wallet balance for portfolio service booking');
      }

      // 7. Start transaction processing
      const transactionId = `portfolio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const orderNumber = `PORT-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;

      // 8. Create order record for portfolio booking
      if (!userId || !stream.vendor_id || !servicePrice) {
        this.logEvent('error', 'invalid_portfolio_booking_data', {
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
            delivery_fee: 0, // Portfolio services don't have delivery
            platform_fee: platformFee,
            status: 'pending',
            escrow_enabled: true,
            source: 'live_stream',
            metadata: {
              stream_id: bookingDto.stream_id,
              booking_type: 'portfolio', // Distinguish portfolio bookings within live_stream
              portfolio_id: bookingDto.portfolio_id,
              portfolio_title: portfolioService.title,
              booking_date: bookingDto.service_date,
              booking_time: bookingDto.service_time,
              transaction_id: transactionId,
              service_notes: bookingDto.service_notes,
            }
          })
          .select()
          .single();

        if (orderError) {
          this.logEvent('error', 'portfolio_booking_order_creation_failed', {
            bookingId,
            userId,
            vendorId: stream.vendor_id,
            servicePrice,
            orderNumber,
            errorCode: orderError.code,
            errorMessage: orderError.message,
          });

          if (orderError.code === '23505') {
            throw new BadRequestException('Order number already exists. Please try again.');
          } else if (orderError.code === '23503') {
            throw new BadRequestException('Invalid reference data. Please verify portfolio and vendor information.');
          } else {
            throw new BadRequestException(`Failed to create booking order: ${orderError.message || 'Unknown error'}`);
          }
        }

        if (!orderData) {
          throw new BadRequestException('Order creation returned no data');
        }

        order = orderData;
      } catch (error) {
        this.logEvent('error', 'portfolio_booking_order_creation_failed', {
          bookingId,
          userId,
          streamId: bookingDto.stream_id,
          portfolioId: bookingDto.portfolio_id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        if (error instanceof BadRequestException) {
          throw error;
        }
        throw new BadRequestException(`Failed to create booking order: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      this.logEvent('log', 'portfolio_order_created', {
        orderId: order.id,
        orderNumber: order.order_number,
        userId,
        vendorId: stream.vendor_id,
      });

      // 9. Create order item for portfolio service
      const { error: orderItemError } = await this.supabase
        .from('order_items')
        .insert({
          order_id: order.id,
          product_id: null, // Portfolio services don't have product IDs
          product_name: portfolioService.title,
          unit_price: servicePrice,
          quantity: 1,
          total_price: servicePrice,
          product_metadata: {
            portfolio_id: bookingDto.portfolio_id,
            portfolio_title: portfolioService.title,
            portfolio_category: portfolioService.category,
            booking_date: bookingDto.service_date,
            booking_time: bookingDto.service_time,
            description: portfolioService.description,
            special_notes: bookingDto.service_notes,
          }
        });

      if (orderItemError) {
        this.logEvent('error', 'portfolio_order_item_creation_failed', {
          bookingId,
          orderId: order.id,
          error: orderItemError.message,
        });
        throw new BadRequestException('Failed to create order item. Please try again.');
      }

      // 10. Deduct from customer wallet (move to escrow)
      const deductResult = await this.walletService.processWalletTransaction(
        userId,
        WalletTransactionType.PURCHASE_HOLD,
        servicePrice,
        `Portfolio booking: ${portfolioService.title} on ${bookingDto.service_date} ${bookingDto.service_time}`,
        order.id,
        'order',
      );

      if (!deductResult.success) {
        this.logEvent('error', 'portfolio_booking_wallet_deduction_failed', {
          bookingId,
          orderId: order.id,
          userId,
          amount: servicePrice,
          error: deductResult.error,
        });
        throw new BadRequestException(`Failed to process booking payment: ${deductResult.error}`);
      }

      // 11. Create escrow for buyer protection
      try {
        const escrowBreakdown = {
          totalAmount: servicePrice,
          vendorAmount: vendorAmount,
          riderAmount: 0, // Portfolio services don't have delivery
          platformAmount: platformFee,
        };

        await this.escrowService.createEscrow(order.id, escrowBreakdown);
        this.logEvent('log', 'portfolio_escrow_created', {
          orderId: order.id,
          orderNumber: order.order_number,
          amount: servicePrice,
        });

        // Generate handoff PINs (3-digit) for service verification
        // Portfolio services are in-person, so use self-pickup style PINs
        const pickupPin = Math.floor(100 + Math.random() * 900).toString(); // 3-digit (100-999)
        const deliveryPin = Math.floor(100 + Math.random() * 900).toString(); // 3-digit (100-999)
        
        // Update order with PINs and keep status as 'pending' so vendor can accept it
        await this.supabase
          .from('orders')
          .update({ 
            pickup_pin: pickupPin,
            delivery_pin: deliveryPin,
            status: 'pending', // Keep as 'pending' so vendor can accept the order
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        
        this.logEvent('log', 'pins_generated', {
          bookingId,
          orderId: order.id,
          orderNumber: order.order_number,
          pickupPin,
          deliveryPin,
          deliveryType: 'pickup', // Portfolio services are in-person
        });

        // Send PIN notifications to vendor and buyer
        try {
          // Get vendor and buyer profiles for notifications
          const { data: vendorProfile } = await this.supabase
            .from('user_profiles')
            .select('username')
            .eq('id', stream.vendor_id)
            .single();

          const { data: buyerProfile } = await this.supabase
            .from('user_profiles')
            .select('username')
            .eq('id', userId)
            .single();

          // Portfolio services are in-person, so send deliveryPin to both vendor and buyer
          // Buyer provides deliveryPin to vendor for service verification
          
          // Send deliveryPin to vendor (for verification)
          await this.notificationHelper.notifyVendorSelfPickupPin(stream.vendor_id, {
            id: order.id,
            orderNumber: order.order_number,
            deliveryPin: deliveryPin,
            buyerName: buyerProfile?.username || 'Portfolio Customer',
          });
          this.logEvent('log', 'pickup_pin_sent_to_vendor', {
            orderId: order.id,
            vendorId: stream.vendor_id,
          });

          // Send deliveryPin to buyer (to provide to vendor)
          await this.notificationHelper.notifyBuyerSelfPickupPin(userId, {
            id: order.id,
            orderNumber: order.order_number,
            deliveryPin: deliveryPin,
            vendorName: vendorProfile?.username,
          });
          this.logEvent('log', 'pickup_pin_sent_to_buyer', {
            orderId: order.id,
            buyerId: userId,
          });
        } catch (pinNotifyError) {
          this.logEvent('warn', 'portfolio_pin_notification_failed', {
            orderId: order.id,
            error: pinNotifyError instanceof Error ? pinNotifyError.message : String(pinNotifyError),
          });
          // Don't throw - PIN notification failure is non-critical
        }

      } catch (escrowError) {
        this.logEvent('error', 'portfolio_escrow_creation_failed', {
          userId,
          orderId: order.id,
          amount: servicePrice,
        }, escrowError instanceof Error ? escrowError : new Error(String(escrowError)));
        
        // Rollback transaction
        const rollbackReason = `Escrow creation failed: ${escrowError instanceof Error ? escrowError.message : 'Unknown error'}`;
        const rollbackResult = await this.rollbackPurchaseTransaction(
          userId,
          order.id,
          servicePrice,
          rollbackReason,
        );

        if (!rollbackResult.success) {
          this.logEvent('error', 'portfolio_rollback_failed_after_escrow_failure', {
            userId,
            orderId: order.id,
            rollbackError: rollbackResult.error,
          });
          throw new HttpException(
            `Payment processed but escrow creation failed. Rollback also failed: ${rollbackResult.error}. Manual intervention required. Order ID: ${order.id}`,
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }

        throw new BadRequestException(
          'Payment was processed but escrow creation failed. Payment has been refunded to your wallet. Please try again.'
        );
      }

      // 12. Notify vendor of new booking
      try {
        await this.notificationHelper.notifyVendorNewOrder(stream.vendor_id, {
          id: order.id,
          orderNumber: order.order_number,
          totalAmount: servicePrice,
          itemCount: 1,
          buyerName: 'Portfolio Customer',
        });

        // Don't notify as paid - order is pending vendor acceptance
        // notifyVendorOrderPaid will be called when vendor accepts the order
      } catch (notifyError) {
        this.logEvent('warn', 'portfolio_vendor_notification_failed', {
          vendorId: stream.vendor_id,
          orderId: order.id,
        }, notifyError instanceof Error ? notifyError : new Error(String(notifyError)));
      }

      // 13. Log analytics
      await this.logAnalytics(bookingDto.stream_id, 'portfolio_booking', servicePrice, {
        customer_id: userId,
        portfolio_id: bookingDto.portfolio_id,
        booking_date: bookingDto.service_date,
        booking_time: bookingDto.service_time,
        service_price: servicePrice,
      });

      const duration = Date.now() - startTime;
      this.logEvent('log', 'portfolio_booking_completed', {
        bookingId,
        transactionId,
        userId,
        vendorId: stream.vendor_id,
        portfolioId: bookingDto.portfolio_id,
        portfolioTitle: portfolioService.title,
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
      this.logEvent('error', 'portfolio_booking_exception', {
        streamId: bookingDto.stream_id,
        userId,
        portfolioId: bookingDto.portfolio_id,
        serviceDate: bookingDto.service_date,
        serviceTime: bookingDto.service_time,
      }, error instanceof Error ? error : new Error(String(error)));
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to process portfolio service booking');
    }
  }

  /**
   * Create/upload portfolio service for a stream
   */
  async createPortfolioService(
    vendorId: string,
    streamId: string,
    portfolioData: {
      title: string;
      description?: string;
      price: number;
      category: 'work_sample' | 'consultation' | 'service_package' | 'testimonial';
      display_order?: number;
    },
    images?: Express.Multer.File[],
    imageCaptions?: string[],
    imageIsPrimary?: boolean[],
    userToken?: string,
  ): Promise<any> {
    try {
      // Verify stream ownership
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('vendor_id, status')
        .eq('id', streamId)
        .single();

      if (streamError || !stream) {
        throw new NotFoundException('Stream not found');
      }

      if (stream.vendor_id !== vendorId) {
        throw new ForbiddenException('Only stream owner can add portfolio services');
      }

      // Use user-authenticated client if token provided
      const client = userToken
        ? createUserSupabaseClient(this.configService, userToken)
        : this.supabase;

      // Upload images to Supabase Storage
      const imageUrls: Array<{ url: string; caption?: string; is_primary: boolean }> = [];
      if (images && images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          const image = images[i];
          const fileExtension = image.originalname.split('.').pop() || 'jpg';
          const fileName = `${vendorId}/portfolio/${Date.now()}-${i}-${Math.random().toString(36).substring(7)}.${fileExtension}`;

          const { data: uploadData, error: uploadError } = await client.storage
            .from('media')
            .upload(fileName, image.buffer, {
              contentType: image.mimetype,
              cacheControl: '3600',
            });

          if (uploadError) {
            throw new BadRequestException(`Failed to upload image: ${uploadError.message}`);
          }

          const { data: publicUrlData } = client.storage
            .from('media')
            .getPublicUrl(fileName);

          imageUrls.push({
            url: publicUrlData.publicUrl,
            caption: imageCaptions?.[i] || undefined,
            is_primary: imageIsPrimary?.[i] || false,
          });
        }
      }

      // Get next display order if not provided
      const { data: existingPortfolios } = await this.supabase
        .from('live_portfolio_services')
        .select('display_order')
        .eq('stream_id', streamId)
        .order('display_order', { ascending: false })
        .limit(1);

      const displayOrder = portfolioData.display_order || ((existingPortfolios?.[0]?.display_order || 0) + 1);

      // Create portfolio service
      // Use service role client to bypass RLS policies
      // This ensures portfolio services are always added successfully without timing/transaction issues
      // We've already verified ownership above, so this is safe
      const { data: portfolio, error: portfolioError } = await this.supabase
        .from('live_portfolio_services')
        .insert({
          stream_id: streamId,
          title: portfolioData.title,
          description: portfolioData.description || null,
          price: portfolioData.price,
          category: portfolioData.category,
          display_order: displayOrder,
        })
        .select()
        .single();

      if (portfolioError || !portfolio) {
        throw new BadRequestException(`Failed to create portfolio service: ${portfolioError?.message}`);
      }

      // Insert portfolio images
      // Use service role client to bypass RLS policies for consistent behavior
      if (imageUrls.length > 0) {
        const imageRecords = imageUrls.map((img, index) => ({
          portfolio_id: portfolio.id,
          image_url: img.url,
          caption: img.caption || null,
          display_order: index,
          is_primary: img.is_primary || index === 0, // First image is primary by default
        }));

        const { error: imagesError } = await this.supabase
          .from('live_portfolio_images')
          .insert(imageRecords);

        if (imagesError) {
          this.logger.warn(`Failed to insert portfolio images: ${imagesError.message}`);
          // Don't fail the entire operation if images fail
        }
      }

      // Return portfolio with images
      return await this.getPortfolioServices(streamId).then(services => 
        services.find(s => s.id === portfolio.id)
      ) || portfolio;
    } catch (error) {
      this.logEvent('error', 'create_portfolio_service_error', { streamId, vendorId }, error instanceof Error ? error : new Error(String(error)));
      throw error instanceof BadRequestException || error instanceof ForbiddenException || error instanceof NotFoundException
        ? error
        : new BadRequestException('Failed to create portfolio service');
    }
  }

  /**
   * Delete portfolio service
   */
  async deletePortfolioService(portfolioId: string, vendorId: string, userToken?: string): Promise<void> {
    try {
      // Verify portfolio exists and belongs to vendor's stream
      const { data: portfolio, error: portfolioError } = await this.supabase
        .from('live_portfolio_services')
        .select(`
          id,
          stream_id,
          stream:live_streams!stream_id (vendor_id)
        `)
        .eq('id', portfolioId)
        .single();

      if (portfolioError || !portfolio) {
        throw new NotFoundException('Portfolio service not found');
      }

      if ((portfolio.stream as any)?.vendor_id !== vendorId) {
        throw new ForbiddenException('Only stream owner can delete portfolio services');
      }

      const client = userToken
        ? createUserSupabaseClient(this.configService, userToken)
        : this.supabase;

      // Soft delete portfolio service
      const { error: deleteError } = await client
        .from('live_portfolio_services')
        .update({
          is_active: false,
          deleted_at: new Date().toISOString(),
        })
        .eq('id', portfolioId);

      if (deleteError) {
        throw new BadRequestException(`Failed to delete portfolio service: ${deleteError.message}`);
      }
    } catch (error) {
      this.logEvent('error', 'delete_portfolio_service_error', { portfolioId, vendorId }, error instanceof Error ? error : new Error(String(error)));
      throw error instanceof BadRequestException || error instanceof ForbiddenException || error instanceof NotFoundException
        ? error
        : new BadRequestException('Failed to delete portfolio service');
    }
  }

  /**
   * Track portfolio impression
   */
  async trackPortfolioImpression(portfolioId: string): Promise<void> {
    try {
      const { error } = await this.supabase.rpc('track_portfolio_impression', {
        p_portfolio_id: portfolioId,
      });

      if (error) {
        this.logger.warn(`Failed to track portfolio impression: ${error.message}`);
        // Don't throw - analytics failures shouldn't break UX
      }
    } catch (error) {
      this.logger.warn('Error tracking portfolio impression:', error);
      // Silently fail - analytics shouldn't break functionality
    }
  }

  /**
   * Track portfolio add to cart
   */
  async trackPortfolioAddToCart(portfolioId: string): Promise<void> {
    try {
      const { error } = await this.supabase.rpc('track_portfolio_add_to_cart', {
        p_portfolio_id: portfolioId,
      });

      if (error) {
        this.logger.warn(`Failed to track add to cart: ${error.message}`);
      }
    } catch (error) {
      this.logger.warn('Error tracking add to cart:', error);
    }
  }

  /**
   * Get portfolio analytics for a stream
   */
  async getPortfolioAnalytics(streamId: string): Promise<any[]> {
    try {
      const { data, error } = await this.supabase.rpc('get_portfolio_analytics', {
        p_stream_id: streamId,
      });

      if (error) {
        throw new BadRequestException(`Failed to fetch portfolio analytics: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      this.logEvent('error', 'get_portfolio_analytics_error', { streamId }, error instanceof Error ? error : new Error(String(error)));
      throw new BadRequestException('Failed to fetch portfolio analytics');
    }
  }
}