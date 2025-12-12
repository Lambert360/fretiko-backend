import { Controller, Get, Post, Body, UseGuards, Req, Query, ValidationPipe, Param, Headers, Res, BadRequestException, Put, Delete } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { WalletService } from './wallet.service';
import { FlutterwaveService } from './flutterwave.service';
import { BankAccountService } from './bank-account.service';
import type { CreateBankAccountDto, UpdateBankAccountDto } from './bank-account.service';
import { PinService } from './pin.service';
import { ExchangeRateService } from '../shared/exchange-rate.service';
import { ProcessingTimeService } from './processing-time.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EscrowBypassCheckDto, DepositRequestDto, WithdrawRequestDto } from './dto/wallet.dto';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly bankAccountService: BankAccountService,
    private readonly pinService: PinService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly processingTimeService: ProcessingTimeService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Get wallet for authenticated user
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  async getWallet(@Req() req: any) {
    console.log('👤 Wallet request from user:', { sub: req.user?.sub, email: req.user?.email });
    console.log('🆔 User ID (sub):', req.user?.sub);
    
    return this.walletService.getWallet(req.user.sub);
  }

  /**
   * Get wallet statistics
   */
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  async getWalletStats(@Req() req: any) {
    console.log('📊 Getting wallet stats for user:', req.user.sub);
    return this.walletService.getWalletStats(req.user.sub);
  }

  /**
   * Get transaction history (redirects to sales history)
   */
  @Get('transactions')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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

  /**
   * Create deposit request and initialize Flutterwave payment
   */
  @Post('deposit')
  @UseGuards(JwtAuthGuard)
  async createDeposit(
    @Req() req: any,
    @Body(ValidationPipe) dto: DepositRequestDto,
  ) {
    console.log('💰 Creating deposit request:', {
      userId: req.user.sub,
      fretiAmount: dto.fretiAmount,
      localCurrency: dto.localCurrency,
      localAmount: dto.localAmount,
    });

    return this.walletService.createDepositRequest(req.user.sub, dto);
  }

  /**
   * Get user's deposit history
   */
  @Get('deposits')
  @UseGuards(JwtAuthGuard)
  async getDeposits(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    console.log('📥 Fetching deposit history:', {
      userId: req.user.sub,
      status,
      limit,
      offset,
    });

    return this.walletService.getDepositHistory(req.user.sub, {
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  /**
   * Get real-time exchange rate for deposit
   * GET /wallet/deposit/rate?localAmount=19200&localCurrency=NGN
   */
  @Get('deposit/rate')
  @UseGuards(JwtAuthGuard)
  async getDepositExchangeRate(
    @Query('localAmount') localAmount: string,
    @Query('localCurrency') localCurrency: string,
  ) {
    const amount = parseFloat(localAmount);
    if (isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Invalid localAmount. Must be a positive number.');
    }

    if (!localCurrency) {
      throw new BadRequestException('localCurrency is required');
    }

    console.log('💱 Fetching deposit exchange rate:', {
      localAmount: amount,
      localCurrency: localCurrency.toUpperCase(),
    });

    let usingFallback = false;
    let fallbackWarning = '';

    try {
      // Try to get rate from Flutterwave: localCurrency -> USD
      const rateInfo = await this.flutterwaveService.getExchangeRate(
        localCurrency.toUpperCase(),
        'USD',
        amount
      );

      // Calculate FRETI amount (1 USD = 1 FRETI)
      const fretiAmount = rateInfo.destination.amount;

      return {
        localAmount: amount,
        localCurrency: localCurrency.toUpperCase(),
        exchangeRate: rateInfo.rate,
        usdAmount: fretiAmount,
        fretiAmount: fretiAmount,
        usingFallback: false,
        warning: null,
        message: `Depositing ${amount} ${localCurrency.toUpperCase()} will give you approximately ₣${fretiAmount.toFixed(2)} FRETI`,
        rateInfo: {
          source: rateInfo.source,
          destination: rateInfo.destination,
        },
      };
    } catch (flutterwaveError: any) {
      console.error('❌ Flutterwave API failed, attempting fallback:', flutterwaveError.message);
      usingFallback = true;
      
      // Fallback: Use ExchangeRateService which might have cached rates or use alternative sources
      try {
        // Convert local currency to FRETI using ExchangeRateService
        const conversion = await this.exchangeRateService.convertLocalToFreti(
          amount,
          localCurrency.toUpperCase()
        );

        const fretiAmount = conversion.toAmount;
        fallbackWarning = `Real-time exchange rates are temporarily unavailable. Using estimated rate (${conversion.rate.toFixed(4)} ${localCurrency.toUpperCase()}/FRETI). The actual rate may differ slightly when your deposit is processed.`;

        return {
          localAmount: amount,
          localCurrency: localCurrency.toUpperCase(),
          exchangeRate: conversion.rate,
          usdAmount: fretiAmount,
          fretiAmount: fretiAmount,
          usingFallback: true,
          warning: fallbackWarning,
          message: `Depositing ${amount} ${localCurrency.toUpperCase()} will give you approximately ₣${fretiAmount.toFixed(2)} FRETI (estimated rate)`,
          rateInfo: {
            source: { currency: localCurrency.toUpperCase(), amount: amount },
            destination: { currency: 'FRETI', amount: fretiAmount },
          },
        };
      } catch (fallbackError: any) {
        console.error('❌ Fallback exchange rate also failed:', fallbackError.message);
        // Last resort: Throw the original Flutterwave error with context
        throw new BadRequestException(
          `Unable to fetch exchange rates. Flutterwave API error: ${flutterwaveError.message}. Please try again in a few minutes.`
        );
      }
    }
  }

  /**
   * Manually verify a deposit (useful when webhook wasn't received)
   */
  @Post('deposits/:depositId/verify')
  @UseGuards(JwtAuthGuard)
  async verifyDeposit(
    @Req() req: any,
    @Param('depositId') depositId: string,
  ) {
    console.log('🔍 Manually verifying deposit:', {
      userId: req.user.sub,
      depositId,
    });

    await this.walletService.verifyDepositManually(depositId, req.user.sub);
    return { status: 'success', message: 'Deposit verified and processed successfully' };
  }

  /**
   * Manually verify a withdrawal (useful when webhook wasn't received)
   */
  @Post('withdrawals/:payoutId/verify')
  @UseGuards(JwtAuthGuard)
  async verifyWithdrawal(
    @Req() req: any,
    @Param('payoutId') payoutId: string,
  ) {
    console.log('🔍 Manually verifying withdrawal:', {
      userId: req.user.sub,
      payoutId,
    });

    await this.walletService.verifyWithdrawalManually(payoutId, req.user.sub);
    return { status: 'success', message: 'Withdrawal verified and processed successfully' };
  }

  /**
   * Create withdrawal request and initiate Flutterwave transfer
   */
  @Post('withdraw')
  @UseGuards(JwtAuthGuard)
  async createWithdrawal(
    @Req() req: any,
    @Body(ValidationPipe) dto: WithdrawRequestDto,
  ) {
    console.log('💸 Creating withdrawal request:', {
      userId: req.user.sub,
      fretiAmount: dto.fretiAmount,
      bankAccountId: dto.bankAccountId,
    });

    return this.walletService.createWithdrawRequest(req.user.sub, dto);
  }

  /**
   * Get user's withdrawal history
   */
  @Get('withdrawals')
  @UseGuards(JwtAuthGuard)
  async getWithdrawals(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    console.log('📤 Fetching withdrawal history:', {
      userId: req.user.sub,
      status,
      limit,
      offset,
    });

    return this.walletService.getPayoutHistory(req.user.sub, {
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  /**
   * Get processing time for withdrawal
   * GET /wallet/withdraw/processing-time?currency=NGN&bankCountry=NG
   */
  @Get('withdraw/processing-time')
  @UseGuards(JwtAuthGuard)
  async getProcessingTime(
    @Query('currency') currency: string,
    @Query('bankCountry') bankCountry?: string,
  ) {
    if (!currency) {
      throw new BadRequestException('currency is required');
    }

    const time = this.processingTimeService.getProcessingTime(currency, bankCountry);
    return {
      currency: currency.toUpperCase(),
      bankCountry: bankCountry?.toUpperCase(),
      minDays: time.minDays,
      maxDays: time.maxDays,
      displayText: time.displayText,
      message: time.displayText,
    };
  }

  /**
   * Get real-time exchange rate for withdrawal
   * GET /wallet/withdraw/rate?fretiAmount=100&localCurrency=NGN
   */
  @Get('withdraw/rate')
  @UseGuards(JwtAuthGuard)
  async getWithdrawalExchangeRate(
    @Query('fretiAmount') fretiAmount: string,
    @Query('localCurrency') localCurrency: string,
  ) {
    const amount = parseFloat(fretiAmount);
    if (isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Invalid fretiAmount. Must be a positive number.');
    }

    if (!localCurrency) {
      throw new BadRequestException('localCurrency is required');
    }

    console.log('💱 Fetching withdrawal exchange rate:', {
      fretiAmount: amount,
      localCurrency: localCurrency.toUpperCase(),
    });

    try {
      // Get rate from Flutterwave: USD -> localCurrency
      // Since FRETI = USD (1:1), we convert USD to local currency to show what user will receive
      const rateInfo = await this.flutterwaveService.getExchangeRate(
        'USD',
        localCurrency.toUpperCase(),
        amount
      );

      // The destination amount is what the user will receive in local currency
      const localAmount = rateInfo.destination.amount;
      const exchangeRate = rateInfo.rate; // USD to local currency rate

      return {
        fretiAmount: amount,
        localCurrency: localCurrency.toUpperCase(),
        exchangeRate: exchangeRate,
        localAmount: localAmount,
        usdAmount: amount, // FRETI = USD
        message: `Withdrawing ₣${amount} FRETI will give you approximately ${localAmount.toFixed(2)} ${localCurrency.toUpperCase()}`,
        rateInfo: {
          source: { ...rateInfo.source },
          destination: { ...rateInfo.destination },
        },
      };
    } catch (error: any) {
      console.error('❌ Error fetching withdrawal exchange rate:', error);
      throw error;
    }
  }

  // ================================
  // BANK ACCOUNT ENDPOINTS
  // ================================

  /**
   * Get all user's bank accounts
   */
  @Get('bank-accounts')
  @UseGuards(JwtAuthGuard)
  async getBankAccounts(@Req() req: any) {
    console.log('🏦 Fetching bank accounts for user:', req.user.sub);
    return this.bankAccountService.getUserBankAccounts(req.user.sub);
  }

  /**
   * Get default bank account
   */
  @Get('bank-accounts/default')
  @UseGuards(JwtAuthGuard)
  async getDefaultBankAccount(@Req() req: any) {
    console.log('🏦 Fetching default bank account for user:', req.user.sub);
    const account = await this.bankAccountService.getDefaultBankAccount(req.user.sub);
    if (!account) {
      throw new BadRequestException('No default bank account found');
    }
    return account;
  }

  /**
   * Get specific bank account
   */
  @Get('bank-accounts/:id')
  @UseGuards(JwtAuthGuard)
  async getBankAccount(@Req() req: any, @Param('id') id: string) {
    console.log('🏦 Fetching bank account:', { userId: req.user.sub, accountId: id });
    return this.bankAccountService.getBankAccount(req.user.sub, id);
  }

  /**
   * Create new bank account
   */
  @Post('bank-accounts')
  @UseGuards(JwtAuthGuard)
  async createBankAccount(
    @Req() req: any,
    @Body(ValidationPipe) dto: CreateBankAccountDto,
  ) {
    console.log('🏦 Creating bank account for user:', req.user.sub);
    return this.bankAccountService.createBankAccount(req.user.sub, dto);
  }

  /**
   * Update bank account
   */
  @Put('bank-accounts/:id')
  @UseGuards(JwtAuthGuard)
  async updateBankAccount(
    @Req() req: any,
    @Param('id') id: string,
    @Body(ValidationPipe) dto: UpdateBankAccountDto,
  ) {
    console.log('🏦 Updating bank account:', { userId: req.user.sub, accountId: id });
    return this.bankAccountService.updateBankAccount(req.user.sub, id, dto);
  }

  /**
   * Set default bank account
   */
  @Put('bank-accounts/:id/set-default')
  @UseGuards(JwtAuthGuard)
  async setDefaultBankAccount(@Req() req: any, @Param('id') id: string) {
    console.log('🏦 Setting default bank account:', { userId: req.user.sub, accountId: id });
    return this.bankAccountService.setDefaultBankAccount(req.user.sub, id);
  }

  /**
   * Delete bank account
   */
  @Delete('bank-accounts/:id')
  @UseGuards(JwtAuthGuard)
  async deleteBankAccount(@Req() req: any, @Param('id') id: string) {
    console.log('🏦 Deleting bank account:', { userId: req.user.sub, accountId: id });
    return this.bankAccountService.deleteBankAccount(req.user.sub, id);
  }

  /**
   * Verify bank account
   */
  @Post('bank-accounts/:id/verify')
  @UseGuards(JwtAuthGuard)
  async verifyBankAccount(@Req() req: any, @Param('id') id: string) {
    console.log('🏦 Verifying bank account:', { userId: req.user.sub, accountId: id });
    return this.bankAccountService.verifyBankAccount(req.user.sub, id);
  }

  // ================================
  // PIN ENDPOINTS
  // ================================

  /**
   * Get PIN status
   */
  @Get('pin/status')
  @UseGuards(JwtAuthGuard)
  async getPinStatus(@Req() req: any) {
    console.log('🔐 Getting PIN status for user:', req.user.sub);
    return this.pinService.getPinStatus(req.user.sub);
  }

  /**
   * Create PIN
   */
  @Post('pin/create')
  @UseGuards(JwtAuthGuard)
  async createPin(
    @Req() req: any,
    @Body('pin') pin: string,
  ) {
    console.log('🔐 Creating PIN for user:', req.user.sub);
    if (!pin) {
      throw new BadRequestException('PIN is required');
    }
    return this.pinService.createPin(req.user.sub, pin);
  }

  /**
   * Verify PIN
   */
  @Post('pin/verify')
  @UseGuards(JwtAuthGuard)
  async verifyPin(
    @Req() req: any,
    @Body('pin') pin: string,
    @Body('actionType') actionType?: string,
    @Body('referenceId') referenceId?: string,
  ) {
    console.log('🔐 Verifying PIN for user:', req.user.sub, { actionType, referenceId });
    if (!pin) {
      throw new BadRequestException('PIN is required');
    }
    return this.pinService.verifyPin(req.user.sub, pin, actionType, referenceId);
  }

  /**
   * Change PIN
   */
  @Post('pin/change')
  @UseGuards(JwtAuthGuard)
  async changePin(
    @Req() req: any,
    @Body('oldPin') oldPin: string,
    @Body('newPin') newPin: string,
  ) {
    console.log('🔐 Changing PIN for user:', req.user.sub);
    if (!oldPin || !newPin) {
      throw new BadRequestException('Both old PIN and new PIN are required');
    }
    return this.pinService.changePin(req.user.sub, oldPin, newPin);
  }

  /**
   * Request PIN reset
   */
  @Post('pin/reset-request')
  @UseGuards(JwtAuthGuard)
  async requestPinReset(@Req() req: any) {
    console.log('🔐 Requesting PIN reset for user:', req.user.sub);
    return this.pinService.requestPinReset(req.user.sub);
  }

  /**
   * Webhook verification endpoint (GET)
   * Flutterwave can test this to verify the webhook URL is accessible
   */
  @Get('webhooks/flutterwave')
  verifyWebhookEndpoint() {
    console.log('✅ Webhook endpoint verified - URL is accessible');
    return { 
      status: 'success', 
      message: 'Webhook endpoint is accessible',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Webhook endpoint for Flutterwave callbacks
   * Note: This endpoint should NOT require JWT authentication
   * 
   * IMPORTANT: For signature verification to work, NestJS must be configured
   * to provide raw body. Add to main.ts:
   * app.use('/wallet/webhooks/flutterwave', express.raw({ type: 'application/json' }));
   * 
   * BEST PRACTICES:
   * 1. Return 200 OK immediately (Flutterwave expects response within 5 seconds)
   * 2. Process webhook asynchronously to avoid timeouts
   * 3. Don't fail on signature verification errors (log but continue)
   * 4. Always return 200 OK even on errors (Flutterwave will retry if needed)
   */
  @Post('webhooks/flutterwave')
  async handleFlutterwaveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: any,
    @Headers('verif-hash') signature?: string,
    @Res() res?: Response,
  ) {
    const startTime = Date.now();
    
    // Flutterwave sends signature in 'verif-hash' or 'flutterwave-signature' header
    // Check all possible header names
    const signatureFromHeader = req.headers['verif-hash'] || 
                                req.headers['flutterwave-signature'] ||
                                req.headers['x-flutterwave-signature'] ||
                                signature;
    
    // Use signature from decorator first, then fallback to header
    const actualSignature = signature || (typeof signatureFromHeader === 'string' ? signatureFromHeader : undefined);
    
    // Handle body - it might be a Buffer from express.raw middleware
    let parsedBody: any;
    if (Buffer.isBuffer(body)) {
      // Body is a Buffer, parse it as JSON
      parsedBody = JSON.parse(body.toString('utf8'));
    } else {
      parsedBody = body;
    }
    
    // Support both Flutterwave v2 (event) and v3 (type) formats
    const event = parsedBody?.type || parsedBody?.event || 'unknown';
    
    console.log('🔔 Flutterwave webhook received:', event);
    console.log('🔐 Signature header (verif-hash):', signature ? 'present' : 'missing');
    console.log('🔐 Signature value:', actualSignature || 'none');
    console.log('🔐 Signature length:', actualSignature ? actualSignature.length : 0);
    
    // Log all relevant headers to find the correct signature header
    const relevantHeaders = Object.keys(req.headers)
      .filter(k => k.toLowerCase().includes('hash') || 
                   k.toLowerCase().includes('signature') || 
                   k.toLowerCase().includes('flutterwave') ||
                   k.toLowerCase().includes('verif'));
    console.log('🔐 All relevant headers:', relevantHeaders);
    console.log('🔐 Header values:', relevantHeaders.reduce((acc, key) => {
      acc[key] = req.headers[key];
      return acc;
    }, {} as Record<string, any>));
    console.log('📦 Raw body type:', typeof req.rawBody);
    console.log('📦 Raw body is Buffer:', Buffer.isBuffer(req.rawBody));
    console.log('📦 Body type:', typeof body);
    console.log('📦 Body is Buffer:', Buffer.isBuffer(body));

    // Get raw body for signature verification
    // According to Flutterwave docs: HMAC-SHA256(raw_request_body, secret_hash) = signature
    // With express.raw(), the body should be a Buffer
    let rawBody: string;
    if (Buffer.isBuffer(body)) {
      // Body is a Buffer from express.raw middleware - use it directly
      rawBody = body.toString('utf8');
      console.log('✅ Using body Buffer for signature verification');
    } else if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
      // Fallback: check req.rawBody if available
      rawBody = req.rawBody.toString('utf8');
      console.log('✅ Using req.rawBody Buffer for signature verification');
    } else {
      // Last resort: stringify the parsed body (may cause signature mismatch)
      rawBody = JSON.stringify(parsedBody);
      console.warn('⚠️ Using stringified body as fallback - signature verification may fail');
      console.warn('⚠️ This usually means express.raw() middleware is not working correctly');
    }
    
    console.log('📦 Raw body length:', rawBody.length);
    console.log('📦 Raw body (first 200 chars):', rawBody.substring(0, 200));

    // Verify webhook signature - CRITICAL: Flutterwave docs require 401 on failure
    // According to Flutterwave docs:
    // 1. They compute: HMAC-SHA256(raw_body, secret_hash) = signature
    // 2. They send signature in 'verif-hash' header
    // 3. We compute the same and compare
    let signatureValid = false;
    const isProduction = process.env.NODE_ENV === 'production';
    
    if (actualSignature) {
      // Check if Flutterwave is sending the secret instead of the hash (common misconfiguration)
      // A SHA256 hash should be 64 hex characters
      const isLikelySecret = actualSignature.length < 32 || actualSignature === this.configService.get<string>('FLW_WEBHOOK_SECRET');
      
      if (isLikelySecret) {
        console.error('⚠️ WARNING: Flutterwave appears to be sending the webhook SECRET instead of the computed HASH!');
        console.error('⚠️ This is a Flutterwave configuration issue. Check your Flutterwave dashboard:');
        console.error('⚠️ 1. Go to Settings → Webhooks');
        console.error('⚠️ 2. Ensure "Enable webhook signature" or similar option is enabled');
        console.error('⚠️ 3. The signature should be a 64-character hex string, not your secret');
        
        // In development, allow webhook to proceed with a warning
        // In production, reject for security
        if (isProduction) {
          console.error('❌ Rejecting webhook in production - signature is invalid');
          if (res) {
            return res.status(401).json({ 
              status: 'error', 
              message: 'Invalid webhook signature - Flutterwave configuration issue' 
            });
          }
          return { status: 'error', message: 'Invalid webhook signature' };
        } else {
          console.warn('⚠️ ALLOWING webhook in development mode (signature verification bypassed)');
          console.warn('⚠️ FIX THIS BEFORE GOING TO PRODUCTION!');
          signatureValid = true; // Allow in dev
        }
      } else {
        // Normal signature verification
        try {
          signatureValid = this.flutterwaveService.verifyWebhook(rawBody, actualSignature);
          if (signatureValid) {
            console.log('✅ Webhook signature verified');
          } else {
            console.error('❌ Invalid webhook signature - rejecting webhook');
            // Flutterwave docs: Return 401 Unauthorized if signature fails
            if (res) {
              return res.status(401).json({ 
                status: 'error', 
                message: 'Invalid webhook signature' 
              });
            }
            return { status: 'error', message: 'Invalid webhook signature' };
          }
        } catch (error: any) {
          console.error('❌ Error verifying signature:', error.message);
          if (res) {
            return res.status(401).json({ 
              status: 'error', 
              message: 'Signature verification failed' 
            });
          }
          return { status: 'error', message: 'Signature verification failed' };
        }
      }
    } else {
      // No signature header
      if (isProduction) {
        console.error('❌ No signature header - rejecting in production');
        if (res) {
          return res.status(401).json({ 
            status: 'error', 
            message: 'Missing webhook signature' 
          });
        }
        return { status: 'error', message: 'Missing webhook signature' };
      } else {
        console.warn('⚠️ No signature header found in webhook request (allowed in development)');
      }
    }

    // Return 200 OK immediately to avoid Flutterwave timeout
    // Process webhook asynchronously
    const response = { 
      status: 'success', 
      message: 'Webhook received',
      event: event,
      timestamp: new Date().toISOString()
    };

    // Send response immediately
    if (res) {
      res.status(200).json(response);
    }

    // Process webhook asynchronously (don't await)
    this.processWebhookAsync(parsedBody, event, signatureValid, startTime).catch((error) => {
      console.error('❌ Error in async webhook processing:', error);
      console.error('❌ Error stack:', error.stack);
      console.error('❌ Webhook body:', JSON.stringify(parsedBody, null, 2).substring(0, 1000));
    });

    // Return response for non-express res case
    return response;
  }

  /**
   * Process webhook asynchronously
   * This runs after the response is sent to avoid timeouts
   */
  private async processWebhookAsync(
    body: any,
    event: string,
    signatureValid: boolean,
    startTime: number,
  ): Promise<void> {
    try {
      if (!event || event === 'unknown') {
        console.error('❌ No event type in webhook body');
        return;
      }

      // Route to appropriate handler
      if (event === 'charge.completed' || event === 'charge.failed') {
        console.log('💰 Routing to deposit webhook handler...');
        try {
          await this.walletService.handleDepositWebhook(body);
          console.log('✅ Deposit webhook handler completed successfully');
        } catch (depositError: any) {
          console.error('❌ Error in deposit webhook handler:', depositError);
          console.error('❌ Deposit error stack:', depositError.stack);
          // Don't rethrow - we already sent 200 response
        }
      } else if (event === 'transfer.completed' || event === 'transfer.failed' || 
                 event === 'transfer' || event?.includes('transfer')) {
        console.log('💸 Routing to withdrawal webhook handler...');
        console.log('💸 Event type:', event);
        console.log('💸 Event details:', JSON.stringify({ event, dataKeys: body?.data ? Object.keys(body.data) : [], fullKeys: Object.keys(body || {}) }, null, 2).substring(0, 300));
        try {
          await this.walletService.handleWithdrawalWebhook(body);
          console.log('✅ Withdrawal webhook handler completed successfully');
        } catch (withdrawalError: any) {
          console.error('❌ Error in withdrawal webhook handler:', withdrawalError);
          console.error('❌ Withdrawal error stack:', withdrawalError.stack);
          console.error('❌ Withdrawal webhook body:', JSON.stringify(body, null, 2).substring(0, 1000));
          // Don't rethrow - we already sent 200 response, but log for investigation
        }
      } else {
        console.log('⚠️ Unhandled webhook event:', event);
        console.log('⚠️ Event type:', typeof event);
        console.log('⚠️ Full webhook body:', JSON.stringify(body, null, 2).substring(0, 500));
        console.log('⚠️ Webhook keys:', Object.keys(body || {}));
      }

      const processingTime = Date.now() - startTime;
      console.log(`✅ Webhook processed successfully in ${processingTime}ms`);
    } catch (error: any) {
      const processingTime = Date.now() - startTime;
      console.error('❌ Error processing webhook:', {
        error: error.message,
        stack: error.stack,
        processingTime,
        event,
      });
      // Don't throw - we already returned 200 OK
    }
  }

  /**
   * Get Flutterwave configuration diagnostics
   * GET /wallet/diagnostics/flutterwave
   * Useful for debugging Flutterwave API configuration issues
   */
  @Get('diagnostics/flutterwave')
  @UseGuards(JwtAuthGuard)
  async getFlutterwaveDiagnostics(@Req() req: any) {
    const publicKey = this.configService.get<string>('FLW_PUBLIC_KEY');
    const secretKey = this.configService.get<string>('FLW_SECRET_KEY');
    const encryptionKey = this.configService.get<string>('FLW_ENCRYPTION_KEY');
    const webhookSecret = this.configService.get<string>('FLW_WEBHOOK_SECRET');

    const diagnostics: {
      configured: {
        publicKey: boolean;
        secretKey: boolean;
        encryptionKey: boolean;
        webhookSecret: boolean;
      };
      keyFormats: {
        publicKey: {
          length: number;
          startsWith: string;
          format: string;
        } | null;
        secretKey: {
          length: number;
          startsWith: string;
          format: string;
          containsTest: boolean;
          containsLive: boolean;
        } | null;
        encryptionKey: {
          length: number;
          startsWith: string;
        } | null;
      };
      recommendations: string[];
      sdkInitialization?: {
        status: string;
        message: string;
        errorType?: string;
        commonIssues?: string[];
      };
    } = {
      configured: {
        publicKey: !!publicKey,
        secretKey: !!secretKey,
        encryptionKey: !!encryptionKey,
        webhookSecret: !!webhookSecret,
      },
      keyFormats: {
        publicKey: publicKey ? {
          length: publicKey.length,
          startsWith: publicKey.substring(0, 10),
          format: publicKey.startsWith('FLWPUBK') ? 'Valid' : 'Invalid (should start with FLWPUBK)',
        } : null,
        secretKey: secretKey ? {
          length: secretKey.length,
          startsWith: secretKey.substring(0, 10),
          format: secretKey.startsWith('FLWSECK') ? 'Valid' : 'Invalid (should start with FLWSECK)',
          containsTest: secretKey.includes('TEST'),
          containsLive: secretKey.includes('FLWSECK-'),
        } : null,
        encryptionKey: encryptionKey ? {
          length: encryptionKey.length,
          startsWith: encryptionKey.substring(0, 10),
        } : null,
      },
      recommendations: [],
    };

    // Add recommendations
    if (!publicKey) {
      diagnostics.recommendations.push('FLW_PUBLIC_KEY is not set in environment variables');
    } else if (!publicKey.startsWith('FLWPUBK')) {
      diagnostics.recommendations.push('FLW_PUBLIC_KEY format appears invalid (should start with FLWPUBK)');
    }

    if (!secretKey) {
      diagnostics.recommendations.push('FLW_SECRET_KEY is not set in environment variables');
    } else {
      if (!secretKey.startsWith('FLWSECK')) {
        diagnostics.recommendations.push('FLW_SECRET_KEY format appears invalid (should start with FLWSECK)');
      }
      if (secretKey.includes('TEST') && process.env.NODE_ENV === 'production') {
        diagnostics.recommendations.push('WARNING: Using TEST secret key in production environment');
      }
    }

    if (!encryptionKey) {
      diagnostics.recommendations.push('FLW_ENCRYPTION_KEY is not set (optional but recommended)');
    }

    if (!webhookSecret) {
      diagnostics.recommendations.push('FLW_WEBHOOK_SECRET is not set (webhook signature verification will be skipped)');
    }

    // Test SDK initialization (without exposing sensitive data)
    try {
      await this.flutterwaveService.getBanks('NG');
      diagnostics.sdkInitialization = {
        status: 'success',
        message: 'Flutterwave SDK initialized and working correctly',
      };
    } catch (error: any) {
      const commonIssues: string[] = [];

      // Add common issue suggestions
      if (error.message?.includes('parse URL') || error.message?.includes('Invalid URL')) {
        commonIssues.push(
          'URL parsing error: Check that FLW_SECRET_KEY is correctly formatted (should be FLWSECK_TEST-... or FLWSECK-...)'
        );
        commonIssues.push(
          'Ensure there are no extra spaces or characters in the environment variable value'
        );
      }
      if (error.message?.includes('401') || error.message?.includes('unauthorized')) {
        commonIssues.push('Authentication error: Verify your API keys are correct');
        commonIssues.push('Check that your Flutterwave account is active');
      }
      if (error.message?.includes('network') || error.message?.includes('timeout')) {
        commonIssues.push('Network error: Check your internet connection');
        commonIssues.push('Verify Flutterwave API is accessible from your server');
      }

      diagnostics.sdkInitialization = {
        status: 'error',
        message: error.message || 'Failed to initialize Flutterwave SDK',
        errorType: error.constructor.name,
        commonIssues: commonIssues.length > 0 ? commonIssues : undefined,
      };
    }

    return diagnostics;
  }

}
