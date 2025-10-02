import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  UseGuards,
  Request,
  Query,
  Param,
  BadRequestException
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WalletService } from './wallet.service';
import { 
  WalletResponseDto,
  DepositRequestDto,
  WithdrawRequestDto,
  TransactionHistoryQueryDto,
  WalletStatsDto,
  EscrowBypassCheckDto,
  EscrowBypassResponseDto,
  PayoutRequestResponseDto,
  DepositResponseDto
} from './dto/wallet.dto';
import { WalletLedger } from './entities/wallet.entity';

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  // ================================
  // WALLET INFO ENDPOINTS
  // ================================

  @Get()
  async getMyWallet(@Request() req): Promise<WalletResponseDto> {
    console.log('👤 Wallet request from user:', req.user);
    console.log('🆔 User ID (sub):', req.user?.sub);
    return this.walletService.getWallet(req.user.sub);
  }

  @Get('stats')
  async getWalletStats(@Request() req): Promise<WalletStatsDto> {
    return this.walletService.getWalletStats(req.user.sub);
  }

  @Get('balance')
  async getBalance(@Request() req): Promise<{ 
    availableBalance: number; 
    escrowBalance: number; 
    pendingWithdrawal: number;
    totalBalance: number;
  }> {
    const wallet = await this.walletService.getWallet(req.user.sub);
    return {
      availableBalance: wallet.availableBalance,
      escrowBalance: wallet.escrowBalance,
      pendingWithdrawal: wallet.pendingWithdrawal,
      totalBalance: wallet.availableBalance + wallet.escrowBalance,
    };
  }

  // ================================
  // DEPOSIT ENDPOINTS
  // ================================

  @Post('deposit')
  async createDeposit(@Request() req, @Body() depositDto: DepositRequestDto): Promise<DepositResponseDto> {
    console.log('💰 Creating deposit request:', {
      userId: req.user.sub,
      fretiAmount: depositDto.fretiAmount,
      localAmount: depositDto.localAmount,
      currency: depositDto.localCurrency
    });

    try {
      return await this.walletService.createDepositRequest(req.user.sub, depositDto);
    } catch (error) {
      console.error('❌ Deposit creation failed:', error);
      throw error;
    }
  }

  @Get('deposits')
  async getMyDeposits(@Request() req, @Query() query: { 
    status?: string; 
    limit?: number; 
    offset?: number 
  }): Promise<DepositResponseDto[]> {
    // This would be implemented to fetch user's deposit history
    // For now, return empty array
    return [];
  }

  // ================================
  // WITHDRAWAL ENDPOINTS
  // ================================

  @Post('withdraw')
  async createWithdrawal(@Request() req, @Body() withdrawDto: WithdrawRequestDto): Promise<PayoutRequestResponseDto> {
    console.log('💸 Creating withdrawal request:', {
      userId: req.user.sub,
      fretiAmount: withdrawDto.fretiAmount,
      currency: withdrawDto.localCurrency
    });

    try {
      return await this.walletService.createWithdrawRequest(req.user.sub, withdrawDto);
    } catch (error) {
      console.error('❌ Withdrawal creation failed:', error);
      throw error;
    }
  }

  @Get('withdrawals')
  async getMyWithdrawals(@Request() req, @Query() query: { 
    status?: string; 
    limit?: number; 
    offset?: number 
  }): Promise<PayoutRequestResponseDto[]> {
    // This would be implemented to fetch user's withdrawal history
    // For now, return empty array
    return [];
  }

  // ================================
  // TRANSACTION HISTORY
  // ================================

  @Get('transactions')
  async getTransactionHistory(
    @Request() req, 
    @Query() query: any
  ): Promise<WalletLedger[]> {
    // Convert query parameters and set defaults
    let limit = parseInt(query.limit) || 20;
    let offset = parseInt(query.offset) || 0;

    // Validate limits
    if (limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    if (offset < 0) offset = 0;

    const sanitizedQuery: TransactionHistoryQueryDto = {
      type: query.type,
      limit: limit,
      offset: offset
    };

    console.log('📋 Fetching transaction history:', {
      userId: req.user.sub,
      type: sanitizedQuery.type,
      limit: sanitizedQuery.limit,
      offset: sanitizedQuery.offset,
      originalQuery: query
    });

    return this.walletService.getTransactionHistory(req.user.sub, sanitizedQuery);
  }

  @Get('transactions/summary')
  async getTransactionSummary(@Request() req): Promise<{
    totalTransactions: number;
    monthlyDeposits: number;
    monthlyWithdrawals: number;
    monthlySpending: number;
    lastTransactionDate: string;
  }> {
    const stats = await this.walletService.getWalletStats(req.user.sub);
    
    return {
      totalTransactions: stats.recentTransactionCount,
      monthlyDeposits: stats.monthlyDeposits,
      monthlyWithdrawals: 0, // Would calculate from withdrawal data
      monthlySpending: stats.monthlySpending,
      lastTransactionDate: new Date().toISOString(), // Would get from actual data
    };
  }

  // ================================
  // ESCROW & TRUST ENDPOINTS
  // ================================

  @Post('escrow/check-bypass')
  async checkEscrowBypass(
    @Request() req, 
    @Body() checkDto: EscrowBypassCheckDto
  ): Promise<EscrowBypassResponseDto> {
    console.log('🔒 Checking escrow bypass eligibility:', {
      buyerId: req.user.sub,
      vendorId: checkDto.vendorId,
      riderId: checkDto.riderId,
      orderAmount: checkDto.orderAmount
    });

    return this.walletService.checkEscrowBypass(req.user.sub, checkDto);
  }

  // ================================
  // UTILITY ENDPOINTS
  // ================================

  @Get('convert/:amount/:fromCurrency/:toCurrency')
  async convertCurrency(
    @Param('amount') amount: string,
    @Param('fromCurrency') fromCurrency: string,
    @Param('toCurrency') toCurrency: string
  ): Promise<{
    originalAmount: number;
    convertedAmount: number;
    fromCurrency: string;
    toCurrency: string;
    exchangeRate: number;
  }> {
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      throw new BadRequestException('Invalid amount');
    }

    // For now, simple conversion logic
    // In production, this would integrate with real exchange rate APIs
    let exchangeRate = 1.0;
    let convertedAmount = numericAmount;

    if (fromCurrency.toLowerCase() === 'freti' && toCurrency.toLowerCase() === 'usd') {
      exchangeRate = 1.0; // 1 Freti = 1 USD
      convertedAmount = numericAmount * exchangeRate;
    } else if (fromCurrency.toLowerCase() === 'usd' && toCurrency.toLowerCase() === 'freti') {
      exchangeRate = 1.0; // 1 USD = 1 Freti
      convertedAmount = numericAmount * exchangeRate;
    } else {
      // For other currencies, would integrate with exchange rate API
      exchangeRate = 1.0;
      convertedAmount = numericAmount;
    }

    return {
      originalAmount: numericAmount,
      convertedAmount,
      fromCurrency: fromCurrency.toUpperCase(),
      toCurrency: toCurrency.toUpperCase(),
      exchangeRate,
    };
  }

  @Get('limits')
  async getWalletLimits(@Request() req): Promise<{
    dailyDepositLimit: number;
    dailyWithdrawalLimit: number;
    remainingDepositLimit: number;
    remainingWithdrawalLimit: number;
    kycStatus: string;
  }> {
    const wallet = await this.walletService.getWallet(req.user.sub);
    
    // For now, return full limits as remaining (would calculate actual usage)
    return {
      dailyDepositLimit: wallet.dailyDepositLimit,
      dailyWithdrawalLimit: wallet.dailyWithdrawalLimit,
      remainingDepositLimit: wallet.dailyDepositLimit, // Would calculate actual remaining
      remainingWithdrawalLimit: wallet.dailyWithdrawalLimit, // Would calculate actual remaining
      kycStatus: wallet.kycStatus,
    };
  }

  // ================================
  // ADMIN ENDPOINTS (Future)
  // ================================

  // These would be protected by admin guards
  // @Post('admin/adjust-balance')
  // @Post('admin/freeze-wallet')
  // @Post('admin/set-limits')
  // @Get('admin/suspicious-activities')
}