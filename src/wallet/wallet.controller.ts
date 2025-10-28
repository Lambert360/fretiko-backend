import { Controller, Get, Post, Body, UseGuards, Req, Query, ValidationPipe, Param } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EscrowBypassCheckDto } from './dto/wallet.dto';

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /**
   * Get wallet for authenticated user
   */
  @Get()
  async getWallet(@Req() req: any) {
    console.log('👤 Wallet request from user:', { sub: req.user?.sub, email: req.user?.email });
    console.log('🆔 User ID (sub):', req.user?.sub);
    
    return this.walletService.getWallet(req.user.sub);
  }

  /**
   * Get wallet statistics
   */
  @Get('stats')
  async getWalletStats(@Req() req: any) {
    console.log('📊 Getting wallet stats for user:', req.user.sub);
    return this.walletService.getWalletStats(req.user.sub);
  }

  /**
   * Get transaction history (redirects to sales history)
   */
  @Get('transactions')
  async getTransactionHistory(
    @Req() req: any,
    @Query('type') type?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    console.log('📋 Fetching wallet transaction history:', {
      userId: req.user.sub,
      type,
      limit,
      offset,
      startDate,
      endDate,
    });
    
    return this.walletService.getTransactionHistory(
      req.user.sub,
      type,
      limit || 50,
      offset || 0,
      startDate,
      endDate,
    );
  }

  /**
   * Get sales history (NEW!)
   * Returns individual sales/earnings transactions for analytics
   */
  @Get('sales-history')
  async getSalesHistory(
    @Req() req: any,
    @Query('type') type?: 'vendor_sale' | 'rider_delivery',
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    console.log('📊 Fetching sales history:', {
      userId: req.user.sub,
      type,
      limit,
      offset,
      startDate,
      endDate,
    });
    
    return this.walletService.getSalesHistory(
      req.user.sub,
      type,
      limit || 50,
      offset || 0,
      startDate,
      endDate,
    );
  }

  /**
   * Get sales analytics (NEW!)
   * Returns aggregated sales data for charts/dashboards
   */
  @Get('sales-analytics')
  async getSalesAnalytics(
    @Req() req: any,
    @Query('period') period?: 'daily' | 'weekly' | 'monthly' | 'yearly',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    console.log('📈 Fetching sales analytics:', {
      userId: req.user.sub,
      period,
      startDate,
      endDate,
    });
    
    return this.walletService.getSalesAnalytics(
      req.user.sub,
      period || 'daily',
      startDate,
      endDate,
    );
  }

  /**
   * Check escrow bypass eligibility
   * Determines if buyer can bypass escrow based on vendor/rider trust scores
   */
  @Post('escrow/check-bypass')
  async checkEscrowBypass(
    @Req() req: any,
    @Body(ValidationPipe) dto: EscrowBypassCheckDto,
  ) {
    console.log('🔒 Checking escrow bypass eligibility:', {
      buyerId: req.user.sub,
      vendorId: dto.vendorId,
      riderId: dto.riderId,
      orderAmount: dto.orderAmount,
      category: dto.category,
    });
    
    return this.walletService.checkEscrowBypass(req.user.sub, dto);
  }

}
