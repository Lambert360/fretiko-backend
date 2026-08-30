import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Query, Request, Req, UploadedFile, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { GiftCardService } from '../gift-cards/gift-cards.service';
import { AdminCreateGiftCardDto } from '../gift-cards/dto/admin-create-gift-card.dto';

@Controller('admin/gift-cards')
@UseGuards(StaffJwtAuthGuard)
export class GiftCardAdminController {
  constructor(private readonly giftCardService: GiftCardService) {}

  @Get('stats')
  async getGiftCardStats() {
    return this.giftCardService.getGiftCardStats();
  }

  @Get('analytics')
  async getGiftCardAnalytics(@Query('period') period: string = '30d') {
    return this.giftCardService.getGiftCardAnalytics(period);
  }

  @Post('designs/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDesignImage(
    @Req() req,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return this.giftCardService.uploadDesignImage(req.user?.sub, file);
  }

  @Get('designs')
  async getGiftCardDesigns() {
    return this.giftCardService.getGiftCardDesigns();
  }

  @Get('settings')
  async getGiftCardSettings() {
    return this.giftCardService.getGiftCardSettings();
  }

  @Get()
  async getAllGiftCards(
    @Query('status') status?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '50',
    @Query('search') search?: string
  ) {
    const pageNumber = parseInt(page);
    const limitNumber = parseInt(limit);
    return this.giftCardService.getAllGiftCards({
      status,
      page: pageNumber,
      limit: limitNumber,
      search
    });
  }

  @Get(':id')
  async getGiftCardById(@Param('id') id: string) {
    return this.giftCardService.getGiftCardById(id);
  }

  @Post(':id/block')
  async blockGiftCard(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.giftCardService.blockGiftCard(id, body.reason);
  }

  @Post(':id/unblock')
  async unblockGiftCard(@Param('id') id: string) {
    return this.giftCardService.unblockGiftCard(id);
  }

  @Post('designs')
  async createGiftCardDesign(@Body() body: any) {
    return this.giftCardService.createGiftCardDesign(body);
  }

  @Put('designs/:id')
  async updateGiftCardDesign(@Param('id') id: string, @Body() body: any) {
    return this.giftCardService.updateGiftCardDesign(id, body);
  }

  @Delete('designs/:id')
  async deleteGiftCardDesign(@Param('id') id: string) {
    return this.giftCardService.deleteGiftCardDesign(id);
  }

  @Put('settings')
  async updateGiftCardSettings(@Body() body: any) {
    return this.giftCardService.updateGiftCardSettings(body);
  }

  @Post('create')
  async createGiftCard(@Request() req, @Body() dto: AdminCreateGiftCardDto) {
    const adminId = req.user?.sub;
    const createdCards = await this.giftCardService.adminCreateGiftCard(adminId, dto);
    return {
      message: `Successfully created ${createdCards.length} gift card(s)`,
      cards: createdCards,
      cardDetails: createdCards.map(card => ({
        cardNumber: card.card_number,
        pin: card.pin,
        claimCode: card.claim_code,
        amount: card.initial_balance,
        design: card.design?.name
      }))
    };
  }

  @Get('marketing-wallet')
  async getMarketingWallet() {
    return this.giftCardService.getMarketingWalletBalance();
  }

  @Get('marketing-wallet/transactions')
  async getMarketingWalletTransactions(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20'
  ) {
    return this.giftCardService.getMarketingWalletTransactions({
      page: parseInt(page),
      limit: parseInt(limit)
    });
  }
}
