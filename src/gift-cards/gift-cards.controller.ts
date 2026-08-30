import { Controller, Get, Post, Body, UseGuards, Req, Header, Param } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GiftCardService } from './gift-cards.service';
import { 
  PurchaseGiftCardDto, 
  ClaimGiftCardDto, 
  RedeemGiftCardDto, 
  CheckBalanceDto 
} from './dto/purchase-gift-card.dto';

@Controller('gift-cards')
export class GiftCardController {
  constructor(private readonly giftCardService: GiftCardService) {}

  @Post('purchase')
  @UseGuards(JwtAuthGuard)
  async purchaseGiftCard(@Req() req, @Body() dto: PurchaseGiftCardDto) {
    return await this.giftCardService.purchaseGiftCard(req.user.sub || req.user.id, dto);
  }

  @Post('claim')
  @UseGuards(JwtAuthGuard)
  async claimGiftCard(@Req() req, @Body() dto: ClaimGiftCardDto) {
    return await this.giftCardService.claimGiftCard(dto.claimCode, req.user.sub || req.user.id);
  }

  @Post('redeem')
  @UseGuards(JwtAuthGuard)
  async redeemGiftCard(@Req() req, @Body() dto: RedeemGiftCardDto) {
    return await this.giftCardService.applyToCheckout(
      dto.cardNumber, 
      dto.pin, 
      dto.orderTotal, 
      req.user.sub || req.user.id,
      dto.amount,
    );
  }

  @Post('check-balance')
  async checkBalance(@Body() dto: CheckBalanceDto) {
    return await this.giftCardService.checkBalance(dto.cardNumber, dto.pin);
  }

  @Get('my-cards')
  @UseGuards(JwtAuthGuard)
  async getMyGiftCards(@Req() req) {
    return await this.giftCardService.getMyGiftCards(req.user.sub || req.user.id);
  }

  @Get('claim-status/:claimCode')
  @UseGuards(JwtAuthGuard)
  async getClaimStatus(@Req() req, @Param('claimCode') claimCode: string) {
    return await this.giftCardService.getClaimStatus(claimCode, req.user.sub || req.user.id);
  }

  @Get('claim/:claimCode')
  @Header('Content-Type', 'text/html')
  renderClaimLandingPage(@Param('claimCode') claimCode: string) {
    return this.giftCardService.generateGiftCardClaimLandingPage(claimCode);
  }
}
