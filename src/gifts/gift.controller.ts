import { Controller, Get, Post, Body, UseGuards, Req, Param, Put, Delete, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { GiftService } from './gift.service';
import {
  CreateGiftDto,
  UpdateGiftDto,
  PurchaseGiftsDto,
  ConvertGiftsDto,
  SendGiftDto,
  CreateSoundDto,
  UpdateSoundDto,
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
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async getAdminGiftWallet(@Req() req) {
    return await this.giftService.getAdminGiftWalletBalance();
  }

  /**
   * Admin: Get gift economy statistics
   * GET /gifts/admin/stats
   */
  @Get('admin/stats')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async getGiftStats(@Req() req) {
    return await this.giftService.getGiftStats();
  }

  /**
   * Admin: Get user gift holdings
   * GET /gifts/admin/user-gift-holdings?page=1&limit=20&search=
   */
  @Get('admin/user-gift-holdings')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
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
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async createGift(@Req() req, @Body() dto: CreateGiftDto) {
    return await this.giftService.createGift(dto);
  }

  /**
   * Admin: Update a gift
   * PUT /gifts/admin/:id
   * Allows both admin role and staff with view_revenue permission
   */
  @Put('admin/:id')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async updateGift(@Req() req, @Param('id') id: string, @Body() dto: UpdateGiftDto) {
    return await this.giftService.updateGift(id, dto);
  }

  /**
   * Admin: Delete a gift
   * DELETE /gifts/admin/:id
   * Allows both admin role and staff with view_revenue permission
   */
  @Delete('admin/:id')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
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
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async getAllGifts(@Req() req) {
    return await this.giftService.getAllGiftsForAdmin();
  }

  /**
   * Admin: Upload a gift asset (lottie or sound)
   * POST /gifts/admin/upload
   */
  @Post('admin/upload')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  @UseInterceptors(FileInterceptor('file'))
  async uploadGiftAsset(
    @Req() req,
    @UploadedFile() file: Express.Multer.File,
    @Body('type') type: 'lottie' | 'sound',
  ) {
    if (!file || !type || !['lottie', 'sound'].includes(type)) {
      return { success: false, message: 'Missing file or invalid type' };
    }
    return await this.giftService.uploadAsset(file, type);
  }

  /**
   * Admin: List sounds
   * GET /gifts/admin/sounds
   */
  @Get('admin/sounds')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async getSounds(@Req() req) {
    return await this.giftService.getSounds();
  }

  /**
   * Admin: Create a sound
   * POST /gifts/admin/sounds
   */
  @Post('admin/sounds')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async createSound(@Req() req, @Body() dto: CreateSoundDto) {
    return await this.giftService.createSound(dto);
  }

  /**
   * Admin: Update a sound
   * PUT /gifts/admin/sounds/:id
   */
  @Put('admin/sounds/:id')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async updateSound(@Req() req, @Param('id') id: string, @Body() dto: UpdateSoundDto) {
    return await this.giftService.updateSound(id, dto);
  }

  /**
   * Admin: Delete a sound
   * DELETE /gifts/admin/sounds/:id
   */
  @Delete('admin/sounds/:id')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_revenue')
  async deleteSound(@Req() req, @Param('id') id: string) {
    await this.giftService.deleteSound(id);
    return { success: true, message: 'Sound deleted successfully' };
  }
}

