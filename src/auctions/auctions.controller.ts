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
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { AuctionsService } from './auctions.service';
import { CreateAuctionDto, PlaceBidDto, AuctionFilterDto, UpdateProxyBidDto } from './dto';
import type { WatchlistDto } from './dto';
import { AuctionOwnerGuard, AuctionActiveGuard } from './guards';
import { JwtAuthGuard } from '../auth/jwt-auth.guard'; // Assuming you have this from auth module

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
    const userId = req?.user?.id; // Optional user ID for personalization
    return this.auctionsService.findAuctions(filters, userId);
  }

  /**
   * Get featured auctions for discovery screen
   */
  @Get('featured')
  async getFeaturedAuctions(@Request() req?: any) {
    const userId = req?.user?.id;
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
    const userId = req?.user?.id;
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
    const userId = req?.user?.id;
    const categoryFilters: AuctionFilterDto = {
      ...filters,
      category_slug: categorySlug,
    };
    return this.auctionsService.findAuctions(categoryFilters, userId);
  }

  /**
   * Get single auction details
   */
  @Get(':id')
  async getAuction(@Param('id') id: string, @Request() req?: any) {
    const userId = req?.user?.id;
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
  @UseInterceptors(FilesInterceptor('images', 10)) // Max 10 images
  @HttpCode(HttpStatus.CREATED)
  async createAuction(
    @Body() createAuctionDto: CreateAuctionDto,
    @UploadedFiles() images: Express.Multer.File[],
    @Request() req: any,
  ) {
    console.log('📸 Received', images?.length || 0, 'images for auction creation');
    return this.auctionsService.createAuction(
      req.user.sub,
      createAuctionDto,
      req.supabaseToken,
      images,
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
      req.user.id,
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
    // TODO: Implement proxy bid update logic
    throw new Error('Proxy bid updates not yet implemented');
  }

  /**
   * Add/remove auction from watchlist
   * Requires authentication
   */
  @Post('watchlist')
  @UseGuards(JwtAuthGuard)
  async toggleWatchlist(
    @Body(ValidationPipe) watchlistDto: WatchlistDto,
    @Request() req: any,
  ) {
    return this.auctionsService.toggleWatchlist(req.user.id, watchlistDto);
  }

  /**
   * Get user's watchlist
   * Requires authentication
   */
  @Get('user/watchlist')
  @UseGuards(JwtAuthGuard)
  async getUserWatchlist(@Request() req: any, @Query('limit') limit?: string) {
    const watchlistLimit = limit ? parseInt(limit) : 50;
    return this.auctionsService.getUserWatchlist(req.user.id, watchlistLimit);
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
      seller_id: req.user.id,
    };
    return this.auctionsService.findAuctions(sellerFilters, req.user.id);
  }

  /**
   * Get user's bid history
   * Requires authentication
   */
  @Get('user/my-bids')
  @UseGuards(JwtAuthGuard)
  async getMyBids(@Request() req: any) {
    // TODO: Implement user bid history
    throw new Error('User bid history not yet implemented');
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
    // TODO: Implement auction update logic
    throw new Error('Auction updates not yet implemented');
  }

  /**
   * Cancel/delete auction (owner only)
   * Requires authentication and ownership
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAuction(@Param('id') id: string, @Request() req: any) {
    // TODO: Implement auction cancellation logic
    throw new Error('Auction cancellation not yet implemented');
  }

  /**
   * Mark auction as sold and process payment
   * Requires authentication and ownership
   */
  @Post(':id/complete-sale')
  @UseGuards(JwtAuthGuard, AuctionOwnerGuard)
  async completeSale(@Param('id') id: string, @Request() req: any) {
    return this.auctionsService.completeAuctionSale(id, req.user.id);
  }
}