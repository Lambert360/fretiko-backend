import { Controller, Get, Post, Body, UseGuards, Req, Query, ValidationPipe, Param, Headers, Res, BadRequestException, Put, Delete, ForbiddenException } from '@nestjs/common';
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
import { WalletReconciliationService } from './wallet-reconciliation.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EscrowBypassCheckDto, DepositRequestDto, WithdrawRequestDto } from './dto/wallet.dto';
import { SvixService } from '../webhook/svix.service';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly flutterwaveService: FlutterwaveService,
    private readonly bankAccountService: BankAccountService,
    private readonly pinService: PinService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly processingTimeService: ProcessingTimeService,
    private readonly walletReconciliationService: WalletReconciliationService,
    private readonly configService: ConfigService,
    private readonly svixService: SvixService,
  ) {}

  /**
   * Get wallet for authenticated user
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  async getWallet(@Req() req: any) {
        
    return this.walletService.getWallet(req.user.sub);
  }

  /**
   * Get wallet statistics
   */
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  async getWalletStats(@Req() req: any) {
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
    console.log('🚀 DEPOSIT REQUEST RECEIVED:', {
      userId: req.user.sub,
      dto: dto,
      timestamp: new Date().toISOString()
    });
    
    try {
      const result = await this.walletService.createDepositRequest(req.user.sub, dto);
      console.log('✅ DEPOSIT CREATED SUCCESSFULLY:', result);
      return result;
    } catch (error: any) {
      console.error('❌ DEPOSIT CREATION FAILED:', {
        error: error.message,
        stack: error.stack,
        dto: dto,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
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
  // @UseGuards(JwtAuthGuard) // Make public for better frontend compatibility
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

    
    let usingFallback = false;
    let fallbackWarning = '';

    try {
      // Try to get rate from Flutterwave: localCurrency -> USD
      const rateInfo = await this.flutterwaveService.getExchangeRate(
        localCurrency.toUpperCase(),
        'USD',
        amount
      );

      // Calculate FRETI amount correctly (1 USD = 1 FRETI)
      // Don't trust Flutterwave's destination.amount, calculate using the rate
      const fretiAmount = amount * rateInfo.rate; // localAmount * rate = USD amount = FRETI amount
      
      console.log(`🔧 Exchange rate calculation: ${amount} ${localCurrency} × ${rateInfo.rate} = ${fretiAmount} FRETI`);
      console.log(`🔧 Flutterwave returned: source=${rateInfo.source.amount}, destination=${rateInfo.destination.amount}, rate=${rateInfo.rate}`);

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
          destination: rateInfo.destination, // Keep original Flutterwave response
        },
      };
    } catch (flutterwaveError: any) {
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
            destination: { currency: 'USD', amount: fretiAmount }, // Keep consistent format
          },
        };
      } catch (fallbackError: any) {
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
        return this.bankAccountService.getUserBankAccounts(req.user.sub);
  }

  /**
   * Get default bank account
   */
  @Get('bank-accounts/default')
  @UseGuards(JwtAuthGuard)
  async getDefaultBankAccount(@Req() req: any) {
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
        return this.bankAccountService.updateBankAccount(req.user.sub, id, dto);
  }

  /**
   * Set default bank account
   */
  @Put('bank-accounts/:id/set-default')
  @UseGuards(JwtAuthGuard)
  async setDefaultBankAccount(@Req() req: any, @Param('id') id: string) {
        return this.bankAccountService.setDefaultBankAccount(req.user.sub, id);
  }

  /**
   * Delete bank account
   */
  @Delete('bank-accounts/:id')
  @UseGuards(JwtAuthGuard)
  async deleteBankAccount(@Req() req: any, @Param('id') id: string) {
        return this.bankAccountService.deleteBankAccount(req.user.sub, id);
  }

  /**
   * Verify bank account
   */
  @Post('bank-accounts/:id/verify')
  @UseGuards(JwtAuthGuard)
  async verifyBankAccount(@Req() req: any, @Param('id') id: string) {
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
        return this.pinService.requestPinReset(req.user.sub);
  }

  /**
   * Verify PIN reset token
   */
  @Post('pin/verify-reset')
  @UseGuards(JwtAuthGuard)
  async verifyPinReset(@Req() req: any, @Body() body: { token: string }) {
    try {
      const result = await this.pinService.verifyPinReset(req.user.sub, body.token);

      return {
        valid: result.valid,
        message: result.message,
      };
    } catch (error) {
      return {
        valid: false,
        message: error.message || 'Failed to verify reset token',
      };
    }
  }

  /**
   * Confirm PIN reset with new PIN
   */
  @Post('pin/confirm-reset')
  @UseGuards(JwtAuthGuard)
  async confirmPinReset(@Req() req: any, @Body() body: { token: string; newPin: string }) {
    try {
      const result = await this.pinService.confirmPinReset(
        req.user.sub, 
        body.token, 
        body.newPin
      );

      return {
        success: result.success,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to reset PIN',
      };
    }
  }

  /**
   * Webhook verification endpoint (GET)
   * Svix-managed webhook endpoint verification
   */
  @Get('webhooks/flutterwave')
  verifyWebhookEndpoint() {
    return { 
      status: 'success', 
      message: 'Svix-managed webhook endpoint is accessible',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Webhook endpoint for Flutterwave callbacks
   * Now managed by Svix for enhanced reliability and monitoring
   * 
   * BEST PRACTICES:
   * 1. Return 200 OK immediately (Svix expects response within 5 seconds)
   * 2. Process webhook asynchronously to avoid timeouts
   * 3. Use Svix signature verification (webhooks are forwarded from Svix)
   * 4. Always return 200 OK even on errors (Svix will retry if needed)
   */
  @Post('webhooks/flutterwave')
  async handleFlutterwaveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Res() res?: Response,
  ) {
    const startTime = Date.now();
    
    // Get raw body for signature verification - this is now available with rawBody: true
    let rawBody: string;
    if (req.rawBody) {
      // Handle different types of rawBody
      if (req.rawBody instanceof Buffer) {
        rawBody = req.rawBody.toString('utf8');
      } else if (typeof req.rawBody === 'string') {
        rawBody = req.rawBody;
      } else if (req.rawBody && typeof req.rawBody === 'object' && 
                 (req.rawBody as any).type === 'Buffer' && 
                 Array.isArray((req.rawBody as any).data)) {
        // Handle serialized Buffer object: {"type":"Buffer","data":[123,34,...]}
        rawBody = Buffer.from((req.rawBody as any).data).toString('utf8');
      } else {
        rawBody = JSON.stringify(req.rawBody);
      }
    } else {
      // Fallback - this shouldn't happen with rawBody: true
      rawBody = JSON.stringify(req.body);
    }
    
    // Parse the body from raw body
    let parsedBody: any;
    try {
      console.log('🔍 Raw webhook body:', rawBody.substring(0, 200) + '...');
      
      // Check if rawBody is a serialized Buffer object
      if (rawBody.includes('"type":"Buffer"') && rawBody.includes('"data":[')) {
        console.log('🔧 Detected serialized Buffer object, converting...');
        try {
          const bufferObj = JSON.parse(rawBody);
          if (bufferObj.type === 'Buffer' && Array.isArray(bufferObj.data)) {
            rawBody = Buffer.from(bufferObj.data).toString('utf8');
            console.log('✅ Successfully converted Buffer to string');
          }
        } catch (bufferError) {
          console.error('❌ Failed to convert Buffer object:', bufferError);
        }
      }
      
      parsedBody = JSON.parse(rawBody);
      console.log('✅ Parsed webhook body:', JSON.stringify(parsedBody, null, 2).substring(0, 300) + '...');
    } catch (error) {
      console.error('❌ Failed to parse webhook body:', error);
      console.error('❌ Raw body that failed to parse:', rawBody);
      if (res) return res.status(400).json({ status: 'error', message: 'Invalid JSON body' });
      return;
    }
    
    // Support both Flutterwave v2 (event) and v3 (type) formats
    const event = parsedBody?.type || parsedBody?.event || 'unknown';
    
    // Verify webhook signature (supports both Svix and direct Flutterwave)
    let signatureValid = false;
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Check for Flutterwave's verif-hash header (direct webhook) or Svix signature
    const flutterwaveSignature = Array.isArray(req.headers['verif-hash']) 
      ? req.headers['verif-hash'][0] 
      : req.headers['verif-hash'];
    const svixSignature = Array.isArray(req.headers['svix-signature']) 
      ? req.headers['svix-signature'][0] 
      : req.headers['svix-signature'];
    const signature = flutterwaveSignature || svixSignature;
    
    console.log('🔍 WEBHOOK DEBUG:', {
      hasFlutterwaveSignature: !!flutterwaveSignature,
      hasSvixSignature: !!svixSignature,
      signatureLength: signature?.length,
      rawBodyLength: rawBody?.length,
      isProduction,
      env: process.env.NODE_ENV
    });
    
    // Production: Use appropriate signature verification
    // Development: Skip verification for testing
    if (isProduction) {
      console.log('🔒 PRODUCTION MODE: Verifying webhook signature');
      
      if (flutterwaveSignature) {
        // Direct Flutterwave webhook - use Flutterwave signature verification
        console.log('🔍 Direct Flutterwave webhook detected');
        try {
          const secretHash = this.configService.get<string>('FLUTTERWAVE_WEBHOOK_SECRET');
          if (!secretHash) {
            console.error('❌ Missing Flutterwave webhook secret');
            if (res) return res.status(401).json({ status: 'error', message: 'Missing webhook secret' });
            return;
          }
          
          // Create HMAC-SHA256 hash to verify Flutterwave signature
          const crypto = require('crypto');
          const hash = crypto.createHmac('sha256', secretHash).update(rawBody).digest('hex');
          signatureValid = hash === flutterwaveSignature;
          
          if (!signatureValid) {
            console.error('❌ Invalid Flutterwave webhook signature');
            if (res) return res.status(401).json({ status: 'error', message: 'Invalid webhook signature' });
            return;
          }
          console.log('✅ Flutterwave webhook signature verified');
        } catch (error) {
          console.error('❌ Flutterwave webhook verification failed:', error);
          if (res) return res.status(401).json({ status: 'error', message: 'Webhook verification failed' });
          return;
        }
      } else if (svixSignature) {
        // Svix webhook - use Svix signature verification
        console.log('🔍 Svix webhook detected');
        try {
          signatureValid = await this.svixService.verifyWebhook(rawBody, svixSignature);
          if (!signatureValid) {
            if (res) return res.status(401).json({ status: 'error', message: 'Invalid Svix webhook signature' });
            return;
          }
          console.log('✅ Svix webhook signature verified');
        } catch (error) {
          if (res) return res.status(401).json({ status: 'error', message: 'Svix webhook verification failed' });
          return;
        }
      } else {
        console.error('❌ No webhook signature found (neither verif-hash nor svix-signature)');
        if (res) return res.status(401).json({ status: 'error', message: 'Missing webhook signature' });
        return;
      }
    } else {
      console.log('⚠️ DEVELOPMENT MODE: Signature verification disabled');
      signatureValid = true;
    }
    
    // Return 200 OK immediately to avoid Flutterwave timeout
    // Process webhook asynchronously
    const response = { 
      status: 'success', 
      message: 'Webhook received and processed',
      event: event,
      timestamp: new Date().toISOString()
    };

    // Send response immediately
    if (res) {
      res.status(200).json(response);
    }

    // Process webhook asynchronously (don't await)
    console.log('🚀 ABOUT TO PROCESS WEBHOOK ASYNC:', {
      event,
      signatureValid,
      txRef: parsedBody?.data?.tx_ref
    });
    
    this.processWebhookAsync(parsedBody, event, signatureValid, startTime).catch((error) => {
      console.error('❌ Async webhook processing failed:', error);
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
                return;
      }

      // Route to appropriate handler
      if (event === 'charge.completed' || event === 'charge.failed') {
        try {
          await this.walletService.handleDepositWebhook(body);
        } catch (depositError: any) {
                    // Don't rethrow - we already sent 200 response
        }
      } else if (event === 'transfer.completed' || event === 'transfer.failed' || 
                 event === 'transfer' || event?.includes('transfer')) {
                try {
          await this.walletService.handleWithdrawalWebhook(body);
                  } catch (withdrawalError: any) {
                    // Don't rethrow - we already sent 200 response, but log for investigation
        }
      } else {
              }

      const processingTime = Date.now() - startTime;
          } catch (error: any) {
      const processingTime = Date.now() - startTime;
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

  // ================================
  // RECONCILIATION ENDPOINTS (Admin Only)
  // ================================

  /**
   * Trigger manual wallet balance reconciliation
   * GET /wallet/admin/reconcile
   * TODO: Add admin guard to restrict access
   */
  @Get('admin/reconcile')
  @UseGuards(JwtAuthGuard)
  async triggerReconciliation(@Req() req: any) {
    // TODO: Add admin check
    // if (!await this.isAdmin(req.user.sub)) {
    //   throw new ForbiddenException('Admin access required');
    // }

        return this.walletReconciliationService.triggerReconciliation();
  }

  /**
   * Trigger manual escrow balance reconciliation
   * GET /wallet/admin/reconcile/escrow
   * TODO: Add admin guard to restrict access
   */
  @Get('admin/reconcile/escrow')
  @UseGuards(JwtAuthGuard)
  async triggerEscrowReconciliation(@Req() req: any) {
    // TODO: Add admin check
    // if (!await this.isAdmin(req.user.sub)) {
    //   throw new ForbiddenException('Admin access required');
    // }

        return this.walletReconciliationService.triggerEscrowReconciliation();
  }

  /**
   * Reconcile specific user's wallet
   * GET /wallet/admin/reconcile/user/:userId
   * TODO: Add admin guard to restrict access
   */
  @Get('admin/reconcile/user/:userId')
  @UseGuards(JwtAuthGuard)
  async reconcileUserWallet(@Req() req: any, @Param('userId') userId: string) {
    // TODO: Add admin check
    // if (!await this.isAdmin(req.user.sub)) {
    //   throw new ForbiddenException('Admin access required');
    // }

        return this.walletReconciliationService.reconcileUserWallet(userId);
  }

  /**
   * Health check endpoint - verify platform wallet exists
   * GET /wallet/health/platform-wallet
   */
  @Get('health/platform-wallet')
  async checkPlatformWalletHealth() {
    const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000002';
    
    try {
      const { data: wallet, error } = await this.walletService['supabase']
        .from('wallets')
        .select('id, kyc_status, available_balance, escrow_balance')
        .eq('user_id', PLATFORM_USER_ID)
        .single();

      if (error || !wallet) {
        return {
          status: 'unhealthy',
          message: 'Platform wallet not found',
          error: error?.message,
        };
      }

      return {
        status: 'healthy',
        walletId: wallet.id,
        kycStatus: wallet.kyc_status,
        availableBalance: parseFloat(wallet.available_balance || '0'),
        escrowBalance: parseFloat(wallet.escrow_balance || '0'),
        message: 'Platform wallet exists and is operational',
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: 'Failed to check platform wallet',
        error: error.message,
      };
    }
  }

}
