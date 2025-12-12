import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface ExchangeRate {
  baseCurrency: string; // USD
  targetCurrency: string; // NGN, EUR, GBP, etc.
  rate: number;
  lastUpdated: string;
  source: string;
}

export interface CurrencyConversion {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
  toAmount: number;
  rate: number;
  timestamp: string;
}

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private readonly FRETI_USD_RATE = 1.0; // 1 Freti = 1 USD
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  
  // In-memory cache for exchange rates
  private rateCache = new Map<string, { rate: ExchangeRate; expiry: number }>();
  
  // No fallback rates - all rates must be fetched from APIs

  constructor(private configService: ConfigService) {}

  /**
   * Get exchange rate from USD to target currency
   */
  async getExchangeRate(targetCurrency: string): Promise<ExchangeRate> {
    if (targetCurrency === 'USD') {
      return {
        baseCurrency: 'USD',
        targetCurrency: 'USD',
        rate: 1.0,
        lastUpdated: new Date().toISOString(),
        source: 'fixed'
      };
    }

    // Check cache first
    const cacheKey = `USD_${targetCurrency}`;
    const cached = this.rateCache.get(cacheKey);
    
    if (cached && Date.now() < cached.expiry) {
      this.logger.debug(`Using cached rate for ${targetCurrency}`);
      return cached.rate;
    }

    try {
      // Try to fetch live rate
      const liveRate = await this.fetchLiveRate(targetCurrency);
      
      // Cache the result
      this.rateCache.set(cacheKey, {
        rate: liveRate,
        expiry: Date.now() + this.CACHE_DURATION
      });
      
      return liveRate;
    } catch (error: any) {
      this.logger.error(`Failed to fetch live rate for ${targetCurrency}:`, error.message);
      throw new Error(`Exchange rate service is temporarily unavailable. Unable to fetch rate for ${targetCurrency}. Please try again later.`);
    }
  }

  /**
   * Convert from one currency to another
   */
  async convertCurrency(
    fromCurrency: string,
    toCurrency: string,
    amount: number
  ): Promise<CurrencyConversion> {
    if (fromCurrency === toCurrency) {
      return {
        fromCurrency,
        toCurrency,
        fromAmount: amount,
        toAmount: amount,
        rate: 1.0,
        timestamp: new Date().toISOString()
      };
    }

    let rate: number;
    let convertedAmount: number;

    if (fromCurrency === 'USD') {
      // USD to target currency
      const exchangeRate = await this.getExchangeRate(toCurrency);
      rate = exchangeRate.rate;
      convertedAmount = amount * rate;
    } else if (toCurrency === 'USD') {
      // Target currency to USD
      const exchangeRate = await this.getExchangeRate(fromCurrency);
      rate = 1 / exchangeRate.rate;
      convertedAmount = amount / exchangeRate.rate;
    } else {
      // Cross-currency conversion (via USD)
      const fromRate = await this.getExchangeRate(fromCurrency);
      const toRate = await this.getExchangeRate(toCurrency);
      
      // Convert to USD first, then to target
      const usdAmount = amount / fromRate.rate;
      convertedAmount = usdAmount * toRate.rate;
      rate = toRate.rate / fromRate.rate;
    }

    return {
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount: Math.round(convertedAmount * 100) / 100, // Round to 2 decimal places
      rate,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Convert Freti to local currency
   */
  async convertFretiToLocal(fretiAmount: number, localCurrency: string): Promise<CurrencyConversion> {
    // Since 1 Freti = 1 USD, convert USD to local currency
    return this.convertCurrency('USD', localCurrency, fretiAmount * this.FRETI_USD_RATE);
  }

  /**
   * Convert local currency to Freti
   */
  async convertLocalToFreti(localAmount: number, localCurrency: string): Promise<CurrencyConversion> {
    // Convert local to USD, then to Freti (1:1 with USD)
    const conversion = await this.convertCurrency(localCurrency, 'USD', localAmount);
    
    return {
      fromCurrency: localCurrency,
      toCurrency: 'FRETI',
      fromAmount: localAmount,
      toAmount: conversion.toAmount / this.FRETI_USD_RATE,
      rate: conversion.rate / this.FRETI_USD_RATE,
      timestamp: conversion.timestamp
    };
  }

  /**
   * Get multiple exchange rates at once
   * Returns only successfully fetched rates (doesn't throw if some fail)
   */
  async getMultipleRates(targetCurrencies: string[]): Promise<Record<string, ExchangeRate>> {
    const rates: Record<string, ExchangeRate> = {};
    
    await Promise.allSettled(
      targetCurrencies.map(async (currency) => {
        try {
          rates[currency] = await this.getExchangeRate(currency);
        } catch (error: any) {
          this.logger.error(`Failed to get rate for ${currency}:`, error.message);
          // Skip this currency - don't include it in results
        }
      })
    );
    
    return rates;
  }

  /**
   * Get supported currencies
   * Note: This returns common currencies, but actual support depends on API availability
   */
  getSupportedCurrencies(): string[] {
    return ['USD', 'NGN', 'EUR', 'GBP', 'CAD', 'AUD', 'GHS', 'KES', 'ZAR', 'UGX', 'TZS', 'RWF', 'XAF', 'XOF'];
  }

  /**
   * Fetch live exchange rate from API
   */
  private async fetchLiveRate(targetCurrency: string): Promise<ExchangeRate> {
    // Try exchangerate-api.com first (free tier: 1500 requests/month)
    const apiKey = this.configService.get('EXCHANGE_RATE_API_KEY');
    const baseUrl = 'https://v6.exchangerate-api.com/v6';
    
    if (apiKey) {
      try {
        const response = await axios.get(
          `${baseUrl}/${apiKey}/pair/USD/${targetCurrency}`,
          { timeout: 5000 }
        );

        if (response.data.result === 'success') {
          return {
            baseCurrency: 'USD',
            targetCurrency,
            rate: response.data.conversion_rate,
            lastUpdated: new Date().toISOString(),
            source: 'exchangerate-api.com'
          };
        } else {
          throw new Error(`API returned error: ${response.data.error_type}`);
        }
      } catch (error: any) {
        this.logger.warn(`exchangerate-api.com failed for ${targetCurrency}, trying alternative:`, error.message);
        // Continue to alternative API
      }
    } else {
      this.logger.warn('No EXCHANGE_RATE_API_KEY configured, trying alternative API');
    }

    // Try alternative free API (exchangerate-api.com v4 - no API key required)
    return this.fetchFromAlternativeAPI(targetCurrency);
  }

  /**
   * Fallback to alternative free API (exchangerate-api.com v4 - no API key required)
   */
  private async fetchFromAlternativeAPI(targetCurrency: string): Promise<ExchangeRate> {
    try {
      // Using exchangerate-api.com v4 (free, no API key required)
      const response = await axios.get(
        `https://api.exchangerate-api.com/v4/latest/USD`,
        { timeout: 10000 }
      );

      if (response.data && response.data.rates && response.data.rates[targetCurrency]) {
        return {
          baseCurrency: 'USD',
          targetCurrency,
          rate: response.data.rates[targetCurrency],
          lastUpdated: new Date().toISOString(),
          source: 'exchangerate-api.com-v4'
        };
      } else {
        throw new Error(`Currency ${targetCurrency} not found in API response`);
      }
    } catch (error: any) {
      this.logger.error(`Alternative API also failed for ${targetCurrency}:`, error.message);
      throw new Error(`Exchange rate service is temporarily unavailable. Unable to fetch rate for ${targetCurrency}. Please try again later.`);
    }
  }


  /**
   * Clear rate cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.rateCache.clear();
    this.logger.log('Exchange rate cache cleared');
  }
}