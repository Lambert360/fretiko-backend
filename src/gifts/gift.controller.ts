import { Controller, Get, Post, Body, UseGuards, Req, Param, Put, Delete, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { GiftService } from './gift.service';
import {
  CreateGiftDto,
  UpdateGiftDto,
  PurchaseGiftsDto,
  ConvertGiftsDto,
  SendGiftDto,
} from './dto/gift.dto';

@Controller('gifts')
export class GiftController {
  constructor(private readonly giftService: GiftService) {}

  /**
   * Get all available gifts (public)
   * GET /gifts
   */
  @Get()
  async getAvailableGifts() {
    return await this.giftService.getAvailableGifts();
  }

  /**
   * Get user's gift collection
   * GET /gifts/my-gifts
   */
  @Get('my-gifts')
  @UseGuards(JwtAuthGuard)
  async getUserGifts(@Req() req) {
    return await this.giftService.getUserGifts(req.user.sub || req.user.id);
  }

  /**
   * Purchase gifts
   * POST /gifts/purchase
   */
  @Post('purchase')
  @UseGuards(JwtAuthGuard)
  async purchaseGifts(@Req() req, @Body() dto: PurchaseGiftsDto) {
    return await this.giftService.purchaseGifts(req.user.sub || req.user.id, dto);
  }

  /**
   * Convert gifts to credits
   * POST /gifts/convert
   */
  @Post('convert')
  @UseGuards(JwtAuthGuard)
  async convertGifts(@Req() req, @Body() dto: ConvertGiftsDto) {
    return await this.giftService.convertGiftsToCredits(req.user.sub || req.user.id, dto);
  }

  /**
   * Send a gift (used by call/stream/auction systems)
   * POST /gifts/send
   */
  @Post('send')
  @UseGuards(JwtAuthGuard)
  async sendGift(@Req() req, @Body() dto: SendGiftDto) {
    await this.giftService.sendGift(req.user.sub || req.user.id, dto);
    return { success: true, message: 'Gift sent successfully' };
  }

  /**
   * Admin: Get admin gift wallet balance
   * GET /gifts/admin/wallet
   */
  @Get('admin/wallet')
  @UseGuards(AdminGuard)
  async getAdminGiftWallet(@Req() req) {
    return await this.giftService.getAdminGiftWalletBalance();
  }

  /**
   * Admin: Get gift economy statistics
   * GET /gifts/admin/stats
   */
  @Get('admin/stats')
  @UseGuards(AdminGuard)
  async getGiftStats(@Req() req) {
    return await this.giftService.getGiftStats();
  }

  /**
   * Admin: Get user gift holdings
   * GET /gifts/admin/user-gift-holdings?page=1&limit=20&search=
   */
  @Get('admin/user-gift-holdings')
  @UseGuards(AdminGuard)
  async getUserGiftHoldings(
    @Req() req,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return await this.giftService.getUserGiftHoldings({
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      search,
    });
  }

  /**
   * Admin: Create a new gift
   * POST /gifts/admin
   * Allows both admin role and staff with view_revenue permission
   */
  @Post('admin')
    async createGift(@Req() req, @Body() dto: CreateGiftDto) {
    return await this.giftService.createGift(dto);
  }

  /**
   * Admin: Update a gift
   * PUT /gifts/admin/:id
   * Allows both admin role and staff with view_revenue permission
   */
  @Put('admin/:id')
    async updateGift(@Req() req, @Param('id') id: string, @Body() dto: UpdateGiftDto) {
    return await this.giftService.updateGift(id, dto);
  }

  /**
   * Admin: Delete a gift
   * DELETE /gifts/admin/:id
   * Allows both admin role and staff with view_revenue permission
   */
  @Delete('admin/:id')
    async deleteGift(@Req() req, @Param('id') id: string) {
    await this.giftService.deleteGift(id);
    return { success: true, message: 'Gift deleted successfully' };
  }

  /**
   * Admin: Get all gifts (including inactive) for management
   * GET /gifts/admin/all
   * Allows both admin role and staff with view_revenue permission
   */
  @Get('admin/all')
    async getAllGifts(@Req() req) {
    return await this.giftService.getAllGiftsForAdmin();
  }
}

