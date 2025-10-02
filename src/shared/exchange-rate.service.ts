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
  
  // Fallback rates (updated manually as backup)
  private fallbackRates: Record<string, number> = {
    'NGN': 1600.00,  // 1 USD = 1600 NGN (approximate)
    'EUR': 0.85,     // 1 USD = 0.85 EUR
    'GBP': 0.73,     // 1 USD = 0.73 GBP
    'CAD': 1.25,     // 1 USD = 1.25 CAD
    'AUD': 1.35,     // 1 USD = 1.35 AUD
  };

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
    } catch (error) {
      this.logger.warn(`Failed to fetch live rate for ${targetCurrency}, using fallback`);
      return this.getFallbackRate(targetCurrency);
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
   */
  async getMultipleRates(targetCurrencies: string[]): Promise<Record<string, ExchangeRate>> {
    const rates: Record<string, ExchangeRate> = {};
    
    await Promise.all(
      targetCurrencies.map(async (currency) => {
        try {
          rates[currency] = await this.getExchangeRate(currency);
        } catch (error) {
          this.logger.error(`Failed to get rate for ${currency}:`, error);
          rates[currency] = this.getFallbackRate(currency);
        }
      })
    );
    
    return rates;
  }

  /**
   * Get supported currencies
   */
  getSupportedCurrencies(): string[] {
    return ['USD', ...Object.keys(this.fallbackRates)];
  }

  /**
   * Fetch live exchange rate from API
   */
  private async fetchLiveRate(targetCurrency: string): Promise<ExchangeRate> {
    // Using exchangerate-api.com (free tier: 1500 requests/month)
    const apiKey = this.configService.get('EXCHANGE_RATE_API_KEY');
    const baseUrl = 'https://v6.exchangerate-api.com/v6';
    
    if (!apiKey) {
      this.logger.warn('No exchange rate API key configured, using fallback rates');
      return this.getFallbackRate(targetCurrency);
    }

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
    } catch (error) {
      // Try alternative free API
      return this.fetchFromAlternativeAPI(targetCurrency);
    }
  }

  /**
   * Fallback to alternative free API
   */
  private async fetchFromAlternativeAPI(targetCurrency: string): Promise<ExchangeRate> {
    try {
      // Using fixer.io free tier as fallback
      const response = await axios.get(
        `https://api.fixer.io/latest?access_key=${this.configService.get('FIXER_API_KEY')}&base=USD&symbols=${targetCurrency}`,
        { timeout: 5000 }
      );

      if (response.data.success && response.data.rates[targetCurrency]) {
        return {
          baseCurrency: 'USD',
          targetCurrency,
          rate: response.data.rates[targetCurrency],
          lastUpdated: new Date().toISOString(),
          source: 'fixer.io'
        };
      }
    } catch (error) {
      this.logger.warn(`Alternative API also failed for ${targetCurrency}`);
    }

    // Final fallback to static rates
    return this.getFallbackRate(targetCurrency);
  }

  /**
   * Get fallback rate when APIs fail
   */
  private getFallbackRate(targetCurrency: string): ExchangeRate {
    const rate = this.fallbackRates[targetCurrency];
    
    if (!rate) {
      this.logger.error(`No fallback rate configured for ${targetCurrency}`);
      throw new Error(`Unsupported currency: ${targetCurrency}`);
    }

    this.logger.warn(`Using fallback rate for ${targetCurrency}: ${rate}`);
    
    return {
      baseCurrency: 'USD',
      targetCurrency,
      rate,
      lastUpdated: new Date().toISOString(),
      source: 'fallback'
    };
  }

  /**
   * Clear rate cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.rateCache.clear();
    this.logger.log('Exchange rate cache cleared');
  }
}