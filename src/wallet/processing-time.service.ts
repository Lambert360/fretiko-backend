import { Injectable } from '@nestjs/common';

/**
 * Service to determine processing times for withdrawals based on currency and bank location
 */
@Injectable()
export class ProcessingTimeService {
  /**
   * Get processing time estimate in business days for a withdrawal
   * @param currency The currency code (e.g., 'NGN', 'USD', 'GBP')
   * @param bankCountry Optional bank country code for more accurate estimates
   * @returns Object with min and max business days
   */
  getProcessingTime(currency: string, bankCountry?: string): {
    minDays: number;
    maxDays: number;
    displayText: string;
  } {
    const currencyUpper = currency.toUpperCase();

    // Domestic transfers (same currency, same country) are typically faster
    const domesticCurrencies: Record<string, { min: number; max: number; country?: string }> = {
      'NGN': { min: 1, max: 2, country: 'NG' }, // Nigerian transfers within Nigeria
      'KES': { min: 1, max: 2, country: 'KE' }, // Kenyan transfers within Kenya
      'GHS': { min: 1, max: 2, country: 'GH' }, // Ghanaian transfers within Ghana
      'ZAR': { min: 1, max: 2, country: 'ZA' }, // South African transfers within South Africa
      'USD': { min: 1, max: 3, country: 'US' }, // US domestic transfers
      'GBP': { min: 1, max: 2, country: 'GB' }, // UK domestic transfers
      'EUR': { min: 1, max: 2, country: 'EU' }, // Eurozone transfers
    };

    // International/Cross-border transfers take longer
    const internationalCurrencies: Record<string, { min: number; max: number }> = {
      'NGN': { min: 2, max: 5 }, // Nigerian transfers (often international)
      'KES': { min: 2, max: 5 },
      'GHS': { min: 2, max: 5 },
      'ZAR': { min: 2, max: 5 },
      'UGX': { min: 2, max: 5 },
      'TZS': { min: 2, max: 5 },
      'XAF': { min: 2, max: 5 },
      'XOF': { min: 2, max: 5 },
      'USD': { min: 1, max: 3 }, // USD often international but faster
      'GBP': { min: 1, max: 3 },
      'EUR': { min: 1, max: 3 },
      'CAD': { min: 2, max: 4 },
      'AUD': { min: 2, max: 4 },
    };

    // Check if it's a domestic transfer
    if (bankCountry && domesticCurrencies[currencyUpper]?.country) {
      // Simplified: If bank country matches currency country, treat as domestic
      // In production, you'd have a more sophisticated mapping
      const currencyCountry = domesticCurrencies[currencyUpper].country;
      if (bankCountry.toUpperCase() === currencyCountry || 
          (currencyCountry === 'EU' && ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'].includes(bankCountry.toUpperCase()))) {
        const time = domesticCurrencies[currencyUpper];
        return {
          minDays: time.min,
          maxDays: time.max,
          displayText: `${time.min}-${time.max} business day${time.max > 1 ? 's' : ''}`,
        };
      }
    }

    // Default to international/standard processing time
    const time = internationalCurrencies[currencyUpper] || { min: 2, max: 5 };
    return {
      minDays: time.min,
      maxDays: time.max,
      displayText: `${time.min}-${time.max} business days`,
    };
  }

  /**
   * Get a user-friendly processing time message
   */
  getProcessingTimeMessage(currency: string, bankCountry?: string): string {
    const time = this.getProcessingTime(currency, bankCountry);
    return `Funds will be processed within ${time.displayText}.`;
  }
}
