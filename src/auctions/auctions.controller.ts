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
import { CreateAuctionDto, PlaceBidDto, AuctionFilterDto, UpdateProxyBidDto, WatchlistDto } from './dto';
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
    FileFieldsInterceptor([
      { name: 'images', maxCount: 10 },
      { name: 'video', maxCount: 1 }, // Single video for auctions
    ]),
  )
  @HttpCode(HttpStatus.CREATED)
  async createAuction(
    @Body() createAuctionDto: CreateAuctionDto,
    @UploadedFiles() files: { images?: Express.Multer.File[]; video?: Express.Multer.File[] },
    @Request() req: any,
  ) {
    console.log('📸 Received', files?.images?.length || 0, 'images for auction creation');
    console.log('🎥 Received', files?.video?.length || 0, 'video for auction creation');
    return this.auctionsService.createAuction(
      req.user.sub,
      createAuctionDto,
      req.supabaseToken,
      files?.images || [],
      files?.video?.[0], // Single video file
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
    // Verify auction exists and is a live auction
    const auction = await this.auctionsService.findById(auctionId, req.user.sub);
    
    if (auction.auction_type !== 'live') {
      throw new BadRequestException('This auction is not a live auction');
    }
    
    // For hosts, verify they own the auction
    if (role === 'host' && auction.seller_id !== req.user.sub) {
      throw new UnauthorizedException('Only the auction owner can host the stream');
    }
    
    // Generate channel name for this auction
    const channelName = `auction_${auctionId}`;
    
    return {
      auctionId,
      channelName,
      role,
      auctionTitle: auction.title,
      currentBid: auction.current_bid,
      // Note: Actual Agora token generation would be integrated here
      // using the liveSalesService.generateAgoraToken() method
      message: 'Endpoint ready - integrate with Agora token service',
    };
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

}