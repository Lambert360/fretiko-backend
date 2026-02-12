import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ValidationPipe,
  HttpStatus,
  HttpCode,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { FilesInterceptor, FileFieldsInterceptor } from '@nestjs/platform-express';
import { AuctionsService } from './auctions.service';
import { CreateAuctionDto, PlaceBidDto, AuctionFilterDto, UpdateProxyBidDto, WatchlistDto, CreateAuctionItemDto } from './dto';
import { AuctionOwnerGuard, AuctionActiveGuard } from './guards';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';

/**
 * Auctions Controller
 *
 * Handles all auction-related HTTP endpoints
 * Includes authentication, authorization, and validation
 */
@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctionsService: AuctionsService) {}

  /**
   * Get all auction categories
   * Public endpoint - no authentication required
   */
  @Get('categories')
  async getCategories(@Query('include_stats') includeStats?: string) {
    return this.auctionsService.getCategories(includeStats === 'true');
  }

  /**
   * Get auctions with filtering and pagination
   * Public endpoint with optional user-specific data
   */
  @Get()
  async getAuctions(
    @Query(ValidationPipe) filters: AuctionFilterDto,
    @Request() req?: any,
  ) {
    const userId = req?.user?.sub; // Optional user ID for personalization
    return this.auctionsService.findAuctions(filters, userId);
  }

  /**
   * Get featured auctions for discovery screen
   */
  @Get('featured')
  async getFeaturedAuctions(@Request() req?: any) {
    const userId = req?.user?.sub;
    const filters: AuctionFilterDto = {
      featured_only: true,
      status: 'active',
      limit: 10,
      sort: 'bids_desc',
    };
    return this.auctionsService.findAuctions(filters, userId);
  }

  /**
   * Get auctions ending soon
   */
  @Get('ending-soon')
  async getAuctionsEndingSoon(@Request() req?: any) {
    const userId = req?.user?.sub;
    const filters: AuctionFilterDto = {
      time_filter: 'ending_soon',
      status: 'active',
      limit: 20,
      sort: 'time_asc',
    };
    return this.auctionsService.findAuctions(filters, userId);
  }

  /**
   * Get auctions by category
   */
  @Get('category/:categorySlug')
  async getAuctionsByCategory(
    @Param('categorySlug') categorySlug: string,
    @Query(ValidationPipe) filters: AuctionFilterDto,
    @Request() req?: any,
  ) {
    const userId = req?.user?.sub;
    const categoryFilters: AuctionFilterDto = {
      ...filters,
      category_slug: categorySlug,
    };
    return this.auctionsService.findAuctions(categoryFilters, userId);
  }

  /**
   * Get single auction details
   * Optional authentication - if user is logged in, includes user-specific data (watchlist status, etc.)
   */
  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  async getAuction(@Param('id') id: string, @Request() req?: any) {
    const userId = req?.user?.sub;
    return this.auctionsService.findById(id, userId);
  }

  /**
   * Track auction view (increment viewer count)
   * Requires authentication for unique user tracking
   */
  @Post(':id/view')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async trackAuctionView(
    @Param('id') auctionId: string,
    @Request() req: any,
  ) {
    const userId = req.user.sub;
    const viewerCount = await this.auctionsService.trackAuctionView(auctionId, userId);
    return { success: true, viewerCount };
  }

  /**
   * Get bid history for an auction
   */
  @Get(':id/bids')
  async getBidHistory(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const bidLimit = limit ? parseInt(limit) : 50;
    return this.auctionsService.getBidHistory(id, bidLimit);
  }

  /**
   * Create a new auction
   * Requires authentication and seller status
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FilesInterceptor('files', 50, {
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB max file size
      },
      fileFilter: (req, file, cb) => {
        console.log('🔍 FilesInterceptor - Processing file:', {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        });
        // Accept all files and let the service handle the logic
        cb(null, true);
      },
    }),
  )
  @HttpCode(HttpStatus.CREATED)
  async createAuction(
    @Body() createAuctionDto: CreateAuctionDto,
    @UploadedFiles() files: Express.Multer.File[],
    @Request() req: any,
  ) {
    console.log('📁 Received', files?.length || 0, 'total files for auction creation');
    
    // Log ALL files received with details
    if (files && files.length > 0) {
      console.log('📁 ALL FILES RECEIVED:');
      files.forEach((file, index) => {
        console.log(`  File ${index}:`, {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          fieldname: file.fieldname
        });
      });
    }
    
    // Always process files the same way regardless of auction type
    const images = files?.filter(file => file.mimetype.startsWith('image/')) || [];
    const video = files?.find(file => file.mimetype.startsWith('video/'));

    console.log('📸 Received', images.length, 'images for auction creation');
    console.log('🎥 Received', video ? '1 video' : '0 videos', 'for auction creation');
    console.log('📝 Raw FormData body:', createAuctionDto);
    console.log('📦 Items received:', JSON.stringify(createAuctionDto.items, null, 2));
    console.log('📦 Items type:', typeof createAuctionDto.items);
    console.log('📦 Items length:', createAuctionDto.items?.length);

    return this.auctionsService.createAuction(
      req.user.sub,
      createAuctionDto,
      req.supabaseToken,
      images,
      video ? [video] : undefined,
    );
  }

  /**
   * Place a bid on an auction
   * Requires authentication and active auction
   */
  @Post('bid')
  @UseGuards(JwtAuthGuard, AuctionActiveGuard)
  @HttpCode(HttpStatus.CREATED)
  async placeBid(
    @Body(ValidationPipe) placeBidDto: PlaceBidDto,
    @Request() req: any,
  ) {
    return this.auctionsService.placeBid(
      req.user.sub,
      placeBidDto,
      req.headers.authorization?.replace('Bearer ', ''),
    );
  }

  /**
   * Update proxy bid settings
   * Requires authentication
   */
  @Put('proxy-bid')
  @UseGuards(JwtAuthGuard)
  async updateProxyBid(
    @Body(ValidationPipe) updateProxyBidDto: UpdateProxyBidDto,
    @Request() req: any,
  ) {
    return this.auctionsService.updateProxyBid(
      req.user.sub,
      updateProxyBidDto.auction_id,
      updateProxyBidDto.max_bid_amount,
    );
  }

  /**
   * Add/remove auction from watchlist
   * Requires authentication
   */
  @Post('watchlist')
  @UseGuards(JwtAuthGuard)
  async toggleWatchlist(
    @Body() body: any,
    @Request() req: any,
  ) {
    // Debug logging
    console.log('🔍 toggleWatchlist - req.user:', req.user);
    console.log('🔍 toggleWatchlist - req.user?.sub:', req.user?.sub);
    console.log('🔍 toggleWatchlist - body:', body);
    console.log('🔍 toggleWatchlist - body.auction_id:', body?.auction_id);
    console.log('🔍 toggleWatchlist - typeof body:', typeof body);
    
    if (!req.user || !req.user.sub) {
      throw new UnauthorizedException('User not authenticated');
    }
    
    // Manually validate and create DTO
    const watchlistDto: WatchlistDto = {
      auction_id: body?.auction_id,
      notification_enabled: body?.notification_enabled !== false,
    };
    
    if (!watchlistDto.auction_id) {
      throw new BadRequestException('auction_id is required');
    }
    
    // Pass the user token so the service can use createUserSupabaseClient for RLS compliance
    return this.auctionsService.toggleWatchlist(req.user.sub, watchlistDto, req.supabaseToken);
  }

  /**
   * Get user's watchlist
   * Requires authentication
   */
  @Get('user/watchlist')
  @UseGuards(JwtAuthGuard)
  async getUserWatchlist(@Request() req: any, @Query('limit') limit?: string) {
    const watchlistLimit = limit ? parseInt(limit) : 50;
    // Pass the user token so the service can use createUserSupabaseClient for RLS compliance
    return this.auctionsService.getUserWatchlist(req.user.sub, watchlistLimit, req.supabaseToken);
  }

  /**
   * Get user's auctions (as seller)
   * Requires authentication
   */
  @Get('user/my-auctions')
  @UseGuards(JwtAuthGuard)
  async getMyAuctions(@Request() req: any, @Query(ValidationPipe) filters: AuctionFilterDto) {
    const sellerFilters: AuctionFilterDto = {
      ...filters,
      seller_id: req.user.sub,
    };
    return this.auctionsService.findAuctions(sellerFilters, req.user.sub);
  }

  /**
   * Generate Agora token for live auction streaming
   * Links auction to live stream infrastructure
   */
  @Get(':id/live-stream-token')
  @UseGuards(JwtAuthGuard)
  async generateLiveStreamToken(
    @Param('id') auctionId: string,
    @Query('role') role: 'host' | 'audience' = 'audience',
    @Request() req: any,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    return this.auctionsService.generateAgoraToken(auctionId, userId, role);
  }

  /**
   * Start broadcasting for a live auction
   * Called when auctioneer successfully joins Agora channel
   */
  @Post(':id/start-broadcast')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async startBroadcast(
    @Param('id') auctionId: string,
    @Request() req: any,
  ) {
    return this.auctionsService.startBroadcast(auctionId, req.user.sub);
  }

  /**
   * Stop broadcasting for a live auction
   * Called when auctioneer leaves Agora channel
   */
  @Post(':id/stop-broadcast')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async stopBroadcast(
    @Param('id') auctionId: string,
    @Request() req: any,
  ) {
    return this.auctionsService.stopBroadcast(auctionId, req.user.sub);
  }

  /**
   * Get user's bid history
   * Requires authentication
   */
  @Get('user/my-bids')
  @UseGuards(JwtAuthGuard)
  async getMyBids(@Request() req: any) {
    return this.auctionsService.getUserBidHistory(req.user.sub);
  }

  /**
   * Get auctions that the user has participated in (placed bids)
   * Returns unique auctions, not individual bids
   * Requires authentication
   */
  @Get('user/my-participated')
  @UseGuards(JwtAuthGuard)
  async getMyParticipatedAuctions(@Request() req: any, @Query(ValidationPipe) filters: AuctionFilterDto) {
    return this.auctionsService.getMyParticipatedAuctions(req.user.sub, filters);
  }

  /**
   * Update auction (owner only)
   * Requires authentication and ownership
   */
  @Put(':id')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  async updateAuction(
    @Param('id') id: string,
    @Body() updateData: Partial<CreateAuctionDto>,
    @Request() req: any,
  ) {
    return this.auctionsService.updateAuction(id, req.user.sub, updateData);
  }

  /**
   * Cancel/delete auction (owner only)
   * Requires authentication and ownership
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAuction(@Param('id') id: string, @Request() req: any) {
    return this.auctionsService.cancelAuction(id, req.user.sub);
  }

  // ==================== AUCTION ITEM CONTROLS (Auctioneer) ====================

  /**
   * Create a new auction item during live auction
   * Allows host to add items on-the-fly
   * Only auction seller can add items
   */
  @Post(':auctionId/items')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB max file size
      },
      fileFilter: (req, file, cb) => {
        // Accept all files and let the service handle the logic
        cb(null, true);
      },
    }),
  )
  @HttpCode(HttpStatus.CREATED)
  async createAuctionItem(
    @Param('auctionId') auctionId: string,
    @Body() body: any, // Use any for FormData parsing
    @UploadedFiles() files: Express.Multer.File[],
    @Request() req: any,
  ) {
    console.log('🎯 CREATE AUCTION ITEM ENDPOINT HIT!');
    console.log(`🎯 Auction ID: ${auctionId}`);
    console.log(`🎯 User ID: ${req.user.sub}`);
    console.log('📁 Received', files?.length || 0, 'total files for auction item creation');
    
    // Log ALL files received with details
    if (files && files.length > 0) {
      console.log('📁 ALL FILES RECEIVED:');
      files.forEach((file, index) => {
        console.log(`  File ${index}:`, {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          fieldname: file.fieldname
        });
      });
    }
    
    // Filter images and videos separately
    const images = files?.filter(file => file.mimetype.startsWith('image/')) || [];
    const video = files?.find(file => file.mimetype.startsWith('video/'));

    console.log('📸 Received', images.length, 'images for auction item creation');
    console.log('🎥 Received', video ? '1 video' : '0 videos', 'for auction item creation');
    
    if (video) {
      console.log('🎥 VIDEO DETAILS:', {
        originalname: video.originalname,
        mimetype: video.mimetype,
        size: video.size
      });
    }
    
    console.log('📝 Raw FormData body:', body);
    
    // Parse FormData fields manually (FormData sends everything as strings)
    const createAuctionItemDto: CreateAuctionItemDto = {
      title: body.title,
      description: body.description || undefined,
      lot_number: body.lot_number || undefined,
      starting_price: parseFloat(body.starting_price),
      reserve_price: body.reserve_price ? parseFloat(body.reserve_price) : undefined,
      bid_increment: body.bid_increment ? parseFloat(body.bid_increment) : undefined,
      bidding_duration: body.bidding_duration ? parseInt(body.bidding_duration) : undefined,
      images: [], // Will be populated by the service from uploaded files
    };

    console.log('📦 Parsed item data:', createAuctionItemDto);

    return this.auctionsService.createAuctionItem(
      auctionId,
      req.user.sub,
      createAuctionItemDto,
      req.supabaseToken,
      images,
      video ? [video] : undefined,
    );
  }

  /**
   * Get current auction item
   */
  @Get(':auctionId/current-item')
  @UseGuards(JwtAuthGuard)
  async getCurrentItem(@Param('auctionId') auctionId: string) {
    return this.auctionsService.getCurrentAuctionItem(auctionId);
  }

  /**
   * Get all auction items for an auction
   */
  @Get(':auctionId/items')
  @UseGuards(JwtAuthGuard)
  async getAuctionItems(@Param('auctionId') auctionId: string) {
    return this.auctionsService.getAuctionItems(auctionId);
  }

  /**
   * Start countdown for auction item (3-2-1 countdown)
   * Only auction seller can control
   */
  @Post(':auctionId/items/:itemId/start-countdown')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async startItemCountdown(
    @Param('auctionId') auctionId: string,
    @Param('itemId') itemId: string,
    @Request() req: any,
  ) {
    await this.auctionsService.startItemCountdown(auctionId, itemId, req.user.sub);
    return { message: 'Countdown started', item_id: itemId };
  }

  /**
   * Open bidding for auction item
   * Only auction seller can control
   */
  @Post(':auctionId/items/:itemId/open-bidding')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async openItemBidding(
    @Param('auctionId') auctionId: string,
    @Param('itemId') itemId: string,
    @Request() req: any,
  ) {
    await this.auctionsService.openItemBidding(auctionId, itemId, req.user.sub);
    return { message: 'Bidding opened', item_id: itemId };
  }

  /**
   * End bidding for auction item (manual)
   * Only auction seller can control
   */
  @Post(':auctionId/items/:itemId/end-bidding')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async endItemBidding(
    @Param('auctionId') auctionId: string,
    @Param('itemId') itemId: string,
    @Request() req: any,
  ) {
    await this.auctionsService.endItemBidding(auctionId, itemId, req.user.sub);
    return { message: 'Bidding ended', item_id: itemId };
  }

  /**
   * Mark item as sold (auctioneer strikes gavel)
   * Only auction seller can control
   */
  @Post(':auctionId/items/:itemId/mark-sold')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async markItemSold(
    @Param('auctionId') auctionId: string,
    @Param('itemId') itemId: string,
    @Request() req: any,
  ) {
    await this.auctionsService.markItemSold(auctionId, itemId, req.user.sub);
    return { message: 'Item marked as sold', item_id: itemId };
  }

  /**
   * Skip/Pass item (no bids or reserve not met)
   * Only auction seller can control
   */
  @Post(':auctionId/items/:itemId/skip')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async skipItem(
    @Param('auctionId') auctionId: string,
    @Param('itemId') itemId: string,
    @Request() req: any,
  ) {
    await this.auctionsService.skipItem(auctionId, itemId, req.user.sub);
    return { message: 'Item skipped', item_id: itemId };
  }

  /**
   * Load next item in auction
   * Only auction seller can control
   */
  @Post(':auctionId/load-next-item')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async loadNextItem(
    @Param('auctionId') auctionId: string,
    @Request() req: any,
  ) {
    await this.auctionsService.loadNextItem(auctionId, req.user.sub);
    return { message: 'Next item loaded' };
  }

  /**
   * Get user's auction wins
   * Returns all won auction items (pending checkout, checked out, expired)
   */
  @Get('user/my-wins')
  @UseGuards(JwtAuthGuard)
  async getUserAuctionWins(
    @Request() req: any,
    @Query('status') status?: 'pending_checkout' | 'checked_out' | 'expired',
  ) {
    return this.auctionsService.getUserAuctionWins(req.user.sub, status, req.headers.authorization?.replace('Bearer ', ''));
  }

  /**
   * Mark auction win as checked out (after order is created)
   */
  @Put('wins/:winId/checkout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async markWinCheckedOut(
    @Param('winId') winId: string,
    @Body() body: { orderId: string },
    @Request() req: any,
  ) {
    await this.auctionsService.markWinCheckedOut(
      winId,
      body.orderId,
      req.user.sub,
      req.headers.authorization?.replace('Bearer ', ''),
    );
    return { message: 'Win marked as checked out', win_id: winId };
  }

}