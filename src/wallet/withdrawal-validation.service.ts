/**
 * WITHDRAWAL VALIDATION SERVICE
 * Centralized validation utilities for withdrawal operations
 */

import { Injectable, BadRequestException, Logger } from '@nestjs/common';

@Injectable()
export class WithdrawalValidationService {
  private readonly logger = new Logger(WithdrawalValidationService.name);

  // Minimum transfer amounts (in USD/FRETI equivalent)
  private readonly MIN_TRANSFER_AMOUNTS: Record<string, number> = {
    'USD': 1.0,
    'NGN': 50.0,      // ~$0.03 USD at current rates, but Flutterwave minimum is usually higher
    'GHS': 1.0,
    'KES': 10.0,
    'ZAR': 10.0,
    'UGX': 1000.0,
    'TZS': 1000.0,
    'RWF': 500.0,
    'XAF': 500.0,
    'XOF': 500.0,
    'EUR': 1.0,
    'GBP': 1.0,
    'CAD': 1.0,
    'AUD': 1.0,
  };

  // Currencies that don't support decimal places
  private readonly NO_DECIMAL_CURRENCIES = [
    'NGN', 'JPY', 'KRW', 'VND', 'XOF', 'XAF', 'UGX', 'TZS', 'RWF',
    'CLP', 'ISK', 'UZS', 'VES', 'IDR'
  ];

  // Maximum beneficiary name length (Flutterwave limit)
  private readonly MAX_BENEFICIARY_NAME_LENGTH = 100;

  // Maximum narration length (Flutterwave limit)
  private readonly MAX_NARRATION_LENGTH = 150;

  // Minimum and maximum account number lengths by country
  private readonly ACCOUNT_NUMBER_LENGTHS: Record<string, { min: number; max: number }> = {
    'NG': { min: 10, max: 10 },    // Nigeria
    'GH': { min: 10, max: 15 },    // Ghana
    'KE': { min: 10, max: 15 },    // Kenya
    'ZA': { min: 10, max: 12 },    // South Africa
    'UG': { min: 10, max: 15 },    // Uganda
    'TZ': { min: 10, max: 15 },    // Tanzania
    'RW': { min: 10, max: 15 },    // Rwanda
    'US': { min: 4, max: 17 },     // USA
    'GB': { min: 8, max: 8 },      // UK (account number)
    'CA': { min: 7, max: 12 },     // Canada
    'AU': { min: 6, max: 9 },      // Australia
  };

  /**
   * Sanitize account number (remove spaces, dashes, special characters)
   */
  sanitizeAccountNumber(accountNumber: string): string {
    if (!accountNumber) {
      throw new BadRequestException('Account number is required');
    }

    // Remove all spaces, dashes, and special characters
    const sanitized = accountNumber.replace(/[\s\-_]/g, '');

    // Validate it contains only alphanumeric characters
    if (!/^[A-Z0-9]+$/i.test(sanitized)) {
      throw new BadRequestException(
        'Account number contains invalid characters. Only letters and numbers are allowed.'
      );
    }

    return sanitized;
  }

  /**
   * Validate account number format and length
   */
  validateAccountNumber(accountNumber: string, countryCode?: string): void {
    const sanitized = this.sanitizeAccountNumber(accountNumber);

    if (sanitized.length < 4 || sanitized.length > 30) {
      throw new BadRequestException(
        `Account number must be between 4 and 30 characters. Current length: ${sanitized.length}`
      );
    }

    // If country code is provided, validate against country-specific rules
    if (countryCode && this.ACCOUNT_NUMBER_LENGTHS[countryCode.toUpperCase()]) {
      const { min, max } = this.ACCOUNT_NUMBER_LENGTHS[countryCode.toUpperCase()];
      if (sanitized.length < min || sanitized.length > max) {
        throw new BadRequestException(
          `Account number for ${countryCode} must be between ${min} and ${max} characters. Current length: ${sanitized.length}`
        );
      }
    }
  }

  /**
   * Validate bank code format (Flutterwave expects numeric string)
   */
  validateBankCode(bankCode: string, countryCode?: string): void {
    if (!bankCode) {
      throw new BadRequestException('Bank code is required');
    }

    // Remove any whitespace
    const sanitized = bankCode.trim();

    // Flutterwave bank codes are typically 3-digit numeric strings (e.g., "058" for GTBank Nigeria)
    // Some countries might have different formats, but most are numeric
    if (!/^\d{2,6}$/.test(sanitized)) {
      throw new BadRequestException(
        `Bank code must be a numeric string (2-6 digits). Received: ${bankCode}`
      );
    }
  }

  /**
   * Validate minimum transfer amount for currency
   */
  validateMinimumAmount(amount: number, currency: string): void {
    const currencyUpper = currency.toUpperCase();
    const minAmount = this.MIN_TRANSFER_AMOUNTS[currencyUpper] || 1.0;

    // For non-USD currencies, convert minimum to USD equivalent
    // This is a rough estimate - in production, you'd want to fetch real-time rates
    let minAmountUSD = minAmount;
    if (currencyUpper !== 'USD') {
      // Use conservative conversion rates for minimum amounts
      // This ensures we don't allow amounts that are too small even if rates fluctuate
      const roughRates: Record<string, number> = {
        'NGN': 0.0007,  // ~1400 NGN = 1 USD
        'KES': 0.007,   // ~150 KES = 1 USD
        'GHS': 0.08,    // ~12 GHS = 1 USD
        'ZAR': 0.055,   // ~18 ZAR = 1 USD
        'EUR': 1.1,
        'GBP': 1.25,
      };
      const rate = roughRates[currencyUpper] || 0.01; // Conservative default
      minAmountUSD = minAmount * rate;
    }

    if (amount < minAmountUSD) {
      throw new BadRequestException(
        `Minimum withdrawal amount is ${minAmountUSD.toFixed(2)} FRETI (USD). You requested ${amount.toFixed(2)} FRETI.`
      );
    }
  }

  /**
   * Validate beneficiary name
   */
  validateBeneficiaryName(name: string): void {
    if (!name || !name.trim()) {
      throw new BadRequestException('Beneficiary name is required');
    }

    const trimmed = name.trim();

    if (trimmed.length < 2) {
      throw new BadRequestException('Beneficiary name must be at least 2 characters long');
    }

    if (trimmed.length > this.MAX_BENEFICIARY_NAME_LENGTH) {
      throw new BadRequestException(
        `Beneficiary name must be ${this.MAX_BENEFICIARY_NAME_LENGTH} characters or less. Current length: ${trimmed.length}`
      );
    }

    // Validate it contains valid characters (letters, spaces, hyphens, apostrophes)
    if (!/^[a-zA-Z\s\-'\.]+$/.test(trimmed)) {
      throw new BadRequestException(
        'Beneficiary name contains invalid characters. Only letters, spaces, hyphens, apostrophes, and periods are allowed.'
      );
    }
  }

  /**
   * Validate narration length
   */
  validateNarration(narration: string): void {
    if (!narration) {
      return; // Narration is optional
    }

    if (narration.length > this.MAX_NARRATION_LENGTH) {
      throw new BadRequestException(
        `Narration must be ${this.MAX_NARRATION_LENGTH} characters or less. Current length: ${narration.length}`
      );
    }
  }

  /**
   * Validate currency decimal places
   */
  validateCurrencyDecimals(amount: number, currency: string): void {
    const currencyUpper = currency.toUpperCase();

    if (this.NO_DECIMAL_CURRENCIES.includes(currencyUpper)) {
      // Check if amount has decimal places
      if (amount % 1 !== 0) {
        throw new BadRequestException(
          `${currencyUpper} does not support decimal places. Please enter a whole number.`
        );
      }
    } else {
      // For currencies that support decimals, limit to 2 decimal places
      const decimalPlaces = (amount.toString().split('.')[1] || '').length;
      if (decimalPlaces > 2) {
        throw new BadRequestException(
          `${currencyUpper} supports up to 2 decimal places.`
        );
      }
    }
  }

  /**
   * Get country code from currency (fallback if country not provided)
   */
  getCountryFromCurrency(currency: string): string | undefined {
    const currencyToCountry: Record<string, string> = {
      'NGN': 'NG',
      'GHS': 'GH',
      'KES': 'KE',
      'ZAR': 'ZA',
      'UGX': 'UG',
      'TZS': 'TZ',
      'RWF': 'RW',
      'XAF': 'CM', // Central African CFA (Cameroon is most common)
      'XOF': 'SN', // West African CFA (Senegal is most common)
      'USD': 'US',
      'EUR': 'EU',
      'GBP': 'GB',
      'CAD': 'CA',
      'AUD': 'AU',
    };

    return currencyToCountry[currency.toUpperCase()];
  }

  /**
   * Validate callback URL is publicly accessible
   */
  validateCallbackUrl(callbackUrl: string): void {
    if (!callbackUrl) {
      throw new BadRequestException('Callback URL is required');
    }

    // Check if URL is localhost or private IP
    const localhostPatterns = [
      /^https?:\/\/localhost/,
      /^https?:\/\/127\.0\.0\.1/,
      /^https?:\/\/0\.0\.0\.0/,
      /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/, // Private IP ranges
    ];

    for (const pattern of localhostPatterns) {
      if (pattern.test(callbackUrl)) {
        throw new BadRequestException(
          `Callback URL cannot be localhost or private IP. Flutterwave webhooks require a publicly accessible URL. Current URL: ${callbackUrl}`
        );
      }
    }

    // Ensure HTTPS in production (warn only for HTTP in development)
    if (!callbackUrl.startsWith('https://') && process.env.NODE_ENV === 'production') {
      this.logger.warn(
        `⚠️ Callback URL uses HTTP in production: ${callbackUrl}. HTTPS is strongly recommended.`
      );
    }
  }
}

