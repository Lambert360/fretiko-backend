import { Injectable, Logger } from '@nestjs/common';
import { FlutterwaveService } from './flutterwave.service';

export interface ExchangeRate {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  timestamp: Date;
  provider: string;
}

export interface RateProvider {
  name: string;
  priority: number;
  getExchangeRate(from: string, to: string, amount?: number): Promise<ExchangeRate>;
  isHealthy(): Promise<boolean>;
}

@Injectable()
export class RateProviderService {
  private readonly logger = new Logger(RateProviderService.name);
  private providers: RateProvider[] = [];
  private cache = new Map<string, { rate: ExchangeRate; expiry: Date }>();
  private readonly CACHE_TTL = 300000; // 5 minutes

  constructor(private flutterwaveService: FlutterwaveService) {
    this.initializeProviders();
  }

  private initializeProviders() {
    // Add providers in priority order (lower number = higher priority)
    this.providers = [
      new FlutterwaveRateProvider(this.flutterwaveService, 1),
      new FrankfurterProvider(2),
      new ExchangeRateHostProvider(3),
    ];
    
    this.logger.log(`🔧 Initialized ${this.providers.length} rate providers`);
  }

  async getExchangeRate(
    fromCurrency: string,
    toCurrency: string,
    amount?: number
  ): Promise<ExchangeRate> {
    const cacheKey = `${fromCurrency}-${toCurrency}-${amount || 1}`;
    
    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiry.getTime()) {
      this.logger.log(`📦 Using cached rate: ${cached.rate.rate} (${cached.rate.provider})`);
      return cached.rate;
    }

    // Try providers in priority order
    for (const provider of this.providers) {
      try {
        const isHealthy = await provider.isHealthy();
        if (!isHealthy) {
          this.logger.warn(`⚠️ Provider ${provider.name} is unhealthy, skipping`);
          continue;
        }

        const rate = await provider.getExchangeRate(fromCurrency, toCurrency, amount);
        
        if (this.isValidRate(rate)) {
          // Cache the valid rate
          this.cache.set(cacheKey, {
            rate,
            expiry: new Date(Date.now() + this.CACHE_TTL),
          });
          
          this.logger.log(`✅ Got rate from ${provider.name}: ${rate.rate}`);
          return rate;
        }
      } catch (error) {
        this.logger.warn(`❌ Provider ${provider.name} failed: ${error.message}`);
      }
    }

    // If all providers fail, throw error
    throw new Error(`Failed to get exchange rate from ${fromCurrency} to ${toCurrency}. All providers failed.`);
  }

  private isValidRate(rate: ExchangeRate): boolean {
    return (
      rate &&
      typeof rate.rate === 'number' &&
      rate.rate > 0 &&
      rate.rate < 1000000 && // Prevent extremely high rates
      typeof rate.fromCurrency === 'string' &&
      typeof rate.toCurrency === 'string' &&
      rate.fromCurrency.length === 3 &&
      rate.toCurrency.length === 3
    );
  }

  clearCache(): void {
    this.cache.clear();
    this.logger.log('🧹 Rate cache cleared');
  }

  getCacheStats(): { size: number; expired: number; valid: number } {
    const now = new Date();
    let expired = 0;
    let valid = 0;

    this.cache.forEach((cached) => {
      if (now > cached.expiry) {
        expired++;
      } else {
        valid++;
      }
    });

    return {
      size: this.cache.size,
      expired,
      valid,
    };
  }

  async getProviderHealth(): Promise<{ name: string; healthy: boolean; priority: number }[]> {
    const health: { name: string; healthy: boolean; priority: number }[] = [];
    
    for (const provider of this.providers) {
      try {
        const isHealthy = await provider.isHealthy();
        health.push({
          name: provider.name,
          healthy: isHealthy,
          priority: provider.priority,
        });
      } catch (error) {
        health.push({
          name: provider.name,
          healthy: false,
          priority: provider.priority,
        });
      }
    }

    return health;
  }
}

// Flutterwave Provider - Primary provider
class FlutterwaveRateProvider implements RateProvider {
  name = 'Flutterwave';
  priority: number;

  constructor(private flutterwaveService: FlutterwaveService, priority: number) {
    this.priority = priority;
  }

  async getExchangeRate(from: string, to: string, amount?: number): Promise<ExchangeRate> {
    try {
      const response = await this.flutterwaveService.getExchangeRate(from, to, amount || 1);
      
      return {
        fromCurrency: from,
        toCurrency: to,
        rate: response.rate,
        timestamp: new Date(),
        provider: this.name,
      };
    } catch (error) {
      throw new Error(`Flutterwave rate fetch failed: ${error.message}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Test with a simple USD to NGN conversion
      await this.flutterwaveService.getExchangeRate('USD', 'NGN', 1);
      return true;
    } catch {
      return false;
    }
  }
}

// Frankfurter Provider - Free, no API key required (ECB rates)
class FrankfurterProvider implements RateProvider {
  name = 'Frankfurter';
  priority: number;
  private readonly BASE_URL = 'https://api.frankfurter.app';

  constructor(priority: number) {
    this.priority = priority;
  }

  async getExchangeRate(from: string, to: string, amount?: number): Promise<ExchangeRate> {
    try {
      const response = await fetch(`${this.BASE_URL}/latest?from=${from}&to=${to}`);
      const data = await response.json();

      if (data.error) {
        throw new Error(`Frankfurter error: ${data.error}`);
      }

      const rate = data.rates[to];
      if (rate === undefined) {
        throw new Error(`Currency pair ${from}-${to} not supported`);
      }

      return {
        fromCurrency: from,
        toCurrency: to,
        rate: rate,
        timestamp: new Date(),
        provider: this.name,
      };
    } catch (error: any) {
      throw new Error(`Frankfurter provider failed: ${error.message}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.BASE_URL}/latest?from=USD&to=EUR`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

// Mock Provider - Development/testing fallback
class MockRateProvider implements RateProvider {
  name = 'Mock';
  priority: number;

  constructor(priority: number) {
    this.priority = priority;
  }

  async getExchangeRate(from: string, to: string, amount?: number): Promise<ExchangeRate> {
    // Mock rates for common currency pairs
    const mockRates: { [key: string]: number } = {
      'USD-NGN': 775.5,
      'NGN-USD': 0.00129,
      'USD-EUR': 0.92,
      'EUR-USD': 1.09,
      'GBP-USD': 1.27,
      'USD-GBP': 0.79,
    };

    const key = `${from}-${to}`;
    const rate = mockRates[key] || 1.0; // Default to 1:1 if no mock rate

    return {
      fromCurrency: from,
      toCurrency: to,
      rate,
      timestamp: new Date(),
      provider: this.name,
    };
  }

  async isHealthy(): Promise<boolean> {
    return true; // Mock provider is always healthy
  }
}

// ExchangeRateAPI Provider - Uses exchangerate-api.com (real-time rates)
class ExchangeRateAPIProvider implements RateProvider {
  name = 'ExchangeRateAPI';
  priority: number;
  private readonly API_KEY = process.env.EXCHANGERATE_API_KEY;
  private readonly BASE_URL = 'https://v6.exchangerate-api.com/v6';

  constructor(priority: number) {
    this.priority = priority;
  }

  async getExchangeRate(from: string, to: string, amount?: number): Promise<ExchangeRate> {
    if (!this.API_KEY) {
      throw new Error('EXCHANGERATE_API_KEY environment variable not set');
    }

    try {
      const response = await fetch(`${this.BASE_URL}/${this.API_KEY}/pair/${from}/${to}`);
      const data = await response.json();

      if (data.result === 'success') {
        return {
          fromCurrency: from,
          toCurrency: to,
          rate: data.conversion_rate,
          timestamp: new Date(),
          provider: this.name,
        };
      } else {
        throw new Error(`ExchangeRateAPI error: ${data['error-type']}`);
      }
    } catch (error: any) {
      throw new Error(`ExchangeRateAPI provider failed: ${error.message}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.BASE_URL}/latest/USD`);
      const data = await response.json();
      return data.result === 'success';
    } catch (error) {
      return false;
    }
  }
}

// ExchangeRateHost Provider - Free, no API key required
class ExchangeRateHostProvider implements RateProvider {
  name = 'ExchangeRateHost';
  priority: number;
  private readonly BASE_URL = 'https://api.exchangerate.host';

  constructor(priority: number) {
    this.priority = priority;
  }

  async getExchangeRate(from: string, to: string, amount?: number): Promise<ExchangeRate> {
    try {
      const response = await fetch(`${this.BASE_URL}/convert?from=${from}&to=${to}&amount=1`);
      const data = await response.json();

      if (!data.success) {
        throw new Error(`ExchangeRateHost error: ${data.error?.info || 'Unknown error'}`);
      }

      return {
        fromCurrency: from,
        toCurrency: to,
        rate: data.result,
        timestamp: new Date(),
        provider: this.name,
      };
    } catch (error: any) {
      throw new Error(`ExchangeRateHost provider failed: ${error.message}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.BASE_URL}/convert?from=USD&to=EUR&amount=1`);
      const data = await response.json();
      return data.success === true;
    } catch (error) {
      return false;
    }
  }
}

// OpenExchangeRates Provider - Uses openexchangerates.org (neutral worldwide rates)
class OpenExchangeRatesProvider implements RateProvider {
  name = 'OpenExchangeRates';
  priority: number;
  private readonly API_KEY = process.env.OPENEXCHANGE_API_KEY;
  private readonly BASE_URL = 'https://openexchangerates.org/api/v1';

  constructor(priority: number) {
    this.priority = priority;
  }

  async getExchangeRate(from: string, to: string, amount?: number): Promise<ExchangeRate> {
    if (!this.API_KEY) {
      throw new Error('OPENEXCHANGE_API_KEY environment variable not set');
    }

    try {
      const response = await fetch(`${this.BASE_URL}/latest.json?app_id=${this.API_KEY}&base=${from}&symbols=${to}`);
      const data = await response.json();

      if (data.error) {
        throw new Error(`OpenExchangeRates error: ${data.message}`);
      }

      const rate = data.rates[to];
      if (rate === undefined) {
        throw new Error(`Currency pair ${from}-${to} not supported`);
      }

      return {
        fromCurrency: from,
        toCurrency: to,
        rate: rate,
        timestamp: new Date(),
        provider: this.name,
      };
    } catch (error: any) {
      throw new Error(`OpenExchangeRates provider failed: ${error.message}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.BASE_URL}/latest.json?app_id=${this.API_KEY}`);
      const data = await response.json();
      return !data.error;
    } catch (error) {
      return false;
    }
  }
}

// Flutterwave Direct Provider - Uses Flutterwave's exchange rate API directly
class FlutterwaveDirectProvider implements RateProvider {
  name = 'FlutterwaveDirect';
  priority: number;
  private flutterwaveService: FlutterwaveService;

  constructor(priority: number, flutterwaveService: FlutterwaveService) {
    this.priority = priority;
    this.flutterwaveService = flutterwaveService;
  }

  async getExchangeRate(from: string, to: string, amount?: number): Promise<ExchangeRate> {
    try {
      const response = await this.flutterwaveService.getExchangeRate(from, to, amount || 1);
      return {
        fromCurrency: from,
        toCurrency: to,
        rate: response.rate,
        timestamp: new Date(),
        provider: this.name,
      };
    } catch (error: any) {
      throw new Error(`FlutterwaveDirect provider failed: ${error.message}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Test with a small amount to check if Flutterwave API is responsive
      await this.flutterwaveService.getExchangeRate('USD', 'NGN', 1);
      return true;
    } catch (error) {
      return false;
    }
  }
}
