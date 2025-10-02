import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ExchangeRateService, CurrencyConversion } from './exchange-rate.service';

@Controller('exchange-rates')
@UseGuards(JwtAuthGuard)
export class ExchangeRateController {
  constructor(private readonly exchangeRateService: ExchangeRateService) {}

  /**
   * Get current exchange rate from USD to target currency
   * GET /exchange-rates/rate?target=NGN
   */
  @Get('rate')
  async getExchangeRate(@Query('target') targetCurrency: string) {
    if (!targetCurrency) {
      throw new Error('Target currency is required');
    }
    
    return this.exchangeRateService.getExchangeRate(targetCurrency.toUpperCase());
  }

  /**
   * Get multiple exchange rates at once
   * GET /exchange-rates/rates?currencies=NGN,EUR,GBP
   */
  @Get('rates')
  async getMultipleRates(@Query('currencies') currencies: string) {
    if (!currencies) {
      throw new Error('Currencies parameter is required');
    }
    
    const currencyList = currencies.split(',').map(c => c.trim().toUpperCase());
    return this.exchangeRateService.getMultipleRates(currencyList);
  }

  /**
   * Convert between any two currencies
   * GET /exchange-rates/convert?from=USD&to=NGN&amount=100
   */
  @Get('convert')
  async convertCurrency(
    @Query('from') fromCurrency: string,
    @Query('to') toCurrency: string,
    @Query('amount') amount: string
  ): Promise<CurrencyConversion> {
    if (!fromCurrency || !toCurrency || !amount) {
      throw new Error('from, to, and amount parameters are required');
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    return this.exchangeRateService.convertCurrency(
      fromCurrency.toUpperCase(),
      toCurrency.toUpperCase(),
      numAmount
    );
  }

  /**
   * Convert Freti to local currency
   * GET /exchange-rates/freti-to-local?amount=100&currency=NGN
   */
  @Get('freti-to-local')
  async convertFretiToLocal(
    @Query('amount') amount: string,
    @Query('currency') localCurrency: string
  ): Promise<CurrencyConversion> {
    if (!amount || !localCurrency) {
      throw new Error('amount and currency parameters are required');
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    return this.exchangeRateService.convertFretiToLocal(
      numAmount,
      localCurrency.toUpperCase()
    );
  }

  /**
   * Convert local currency to Freti
   * GET /exchange-rates/local-to-freti?amount=100000&currency=NGN
   */
  @Get('local-to-freti')
  async convertLocalToFreti(
    @Query('amount') amount: string,
    @Query('currency') localCurrency: string
  ): Promise<CurrencyConversion> {
    if (!amount || !localCurrency) {
      throw new Error('amount and currency parameters are required');
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    return this.exchangeRateService.convertLocalToFreti(
      numAmount,
      localCurrency.toUpperCase()
    );
  }

  /**
   * Get list of supported currencies
   * GET /exchange-rates/supported
   */
  @Get('supported')
  async getSupportedCurrencies(): Promise<{ currencies: string[] }> {
    return {
      currencies: this.exchangeRateService.getSupportedCurrencies()
    };
  }

  /**
   * Clear exchange rate cache (admin function)
   * POST /exchange-rates/clear-cache
   */
  @Get('clear-cache')
  async clearCache(): Promise<{ message: string }> {
    this.exchangeRateService.clearCache();
    return { message: 'Exchange rate cache cleared successfully' };
  }
}