import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Flutterwave from 'flutterwave-node-v3';
import axios from 'axios';

export interface InitializePaymentDto {
  amount: number;
  currency: string;
  customerEmail: string;
  customerName?: string;
  txRef: string;
  redirectUrl?: string;
  meta?: Record<string, any>;
}

export interface PaymentResponse {
  status: string;
  message: string;
  data: {
    link: string;
    tx_ref: string;
  };
}

export interface VerifyPaymentResponse {
  status: string;
  message: string;
  data: {
    id: number;
    tx_ref: string;
    flw_ref: string;
    device_fingerprint: string;
    amount: number;
    currency: string;
    charged_amount: number;
    app_fee: number;
    merchant_fee: number;
    processor_response: string;
    auth_model: string;
    card: any;
    created_at: string;
    account_id: number;
    amount_settled: number;
    currency_settled: string;
    customer: {
      id: number;
      phone_number: string;
      name: string;
      email: string;
      created_at: string;
    };
    status: string;
    payment_type: string;
  };
}

export interface InitiateTransferDto {
  accountBank: string;
  accountNumber: string;
  amount: number;
  currency: string;
  destinationCurrency?: string;
  beneficiaryName: string;
  narration?: string;
  reference: string;
  callbackUrl?: string;
}

export interface TransferResponse {
  status: string;
  message: string;
  data: {
    id: number;
    account_number: string;
    bank_code: string;
    full_name: string;
    created_at: string;
    currency: string;
    debit_currency: string;
    amount: number;
    fee: number;
    status: string;
    reference: string;
    meta: any;
    narration: string;
    complete_message: string;
    requires_approval: number;
    is_approved: number;
    bank_name: string;
  };
}

export interface VerifyTransferResponse {
  status: string;
  message: string;
  data: {
    id: number;
    account_number: string;
    bank_code: string;
    full_name: string;
    date_created: string;
    currency: string;
    debit_currency: string;
    amount: number;
    fee: number;
    status: string;
    reference: string;
    meta: any;
    narration: string;
    complete_message: string;
    requires_approval: number;
    is_approved: number;
    bank_name: string;
    // Optional fields that may be present in webhook/response
    currency_settled?: string;
    amount_settled?: number;
  };
}

export interface Bank {
  id: number;
  code: string;
  name: string;
}

@Injectable()
export class FlutterwaveService {
  private readonly logger = new Logger(FlutterwaveService.name);
  private flw: Flutterwave | null = null;
  
  // Exchange rate cache: cache rates for 2 minutes (rates don't change every second)
  // Cache key format: "SOURCE_DESTINATION" (e.g., "NGN_USD")
  // Note: Exchange rates are amount-independent, so we cache by currency pair only
  private readonly RATE_CACHE_DURATION = 2 * 60 * 1000; // 2 minutes
  private rateCache = new Map<string, { 
    rate: number; 
    source: { currency: string; amount: number };
    destination: { currency: string; amount: number };
    expiry: number;
  }>();

  constructor(private configService: ConfigService) {
    const publicKey = this.configService.get<string>('FLW_PUBLIC_KEY');
    const secretKey = this.configService.get<string>('FLW_SECRET_KEY');
    const encryptionKey = this.configService.get<string>('FLW_ENCRYPTION_KEY');

    if (!publicKey || !secretKey) {
      this.logger.warn('⚠️ Flutterwave keys not configured. Payment features will not work.');
      this.logger.warn('⚠️ Add FLW_PUBLIC_KEY, FLW_SECRET_KEY, and FLW_ENCRYPTION_KEY to your .env file');
      // Initialize with empty strings to allow app to start, but methods will fail gracefully
      this.flw = null as any;
    } else {
      try {
        // Validate keys are not empty and properly formatted
        if (publicKey.trim().length === 0 || secretKey.trim().length === 0) {
          throw new Error('Flutterwave keys cannot be empty');
        }
        
        // Flutterwave SDK expects: new Flutterwave(publicKey, secretKey, encryptionKey)
        // Make sure we're passing strings, not undefined
        this.flw = new Flutterwave(
          publicKey.trim(), 
          secretKey.trim(), 
          encryptionKey?.trim() || ''
        );
        this.logger.log('✅ Flutterwave service initialized successfully');
      } catch (error: any) {
        this.logger.error('❌ Failed to initialize Flutterwave service:', error.message);
        this.logger.error('❌ Error details:', {
          publicKeyPresent: !!publicKey,
          secretKeyPresent: !!secretKey,
          encryptionKeyPresent: !!encryptionKey,
          publicKeyLength: publicKey?.length || 0,
          secretKeyLength: secretKey?.length || 0,
        });
        this.flw = null as any;
      }
    }
  }

  /**
   * Initialize payment for deposits
   * Uses Flutterwave Payment Links API to create a hosted payment page
   */
  async initializePayment(dto: InitializePaymentDto): Promise<PaymentResponse> {
    if (!this.flw) {
      throw new BadRequestException('Flutterwave is not configured. Please add FLW_PUBLIC_KEY and FLW_SECRET_KEY to your .env file');
    }

    try {
      this.logger.log(`Initializing payment: ${dto.amount} ${dto.currency} for ${dto.customerEmail}`);

      const publicKey = this.configService.get<string>('FLW_PUBLIC_KEY');
      const secretKey = this.configService.get<string>('FLW_SECRET_KEY');
      const baseUrl = this.configService.get<string>('FLW_BASE_URL') || 'https://api.flutterwave.com/v3';

      // Use Flutterwave Payment Links API directly via HTTP
      const payload = {
        tx_ref: dto.txRef,
        amount: dto.amount,
        currency: dto.currency,
        redirect_url: dto.redirectUrl || `fretiko://wallet/deposit/callback`,
        payment_options: 'card,account,ussd,banktransfer,mobilemoney',
        customer: {
          email: dto.customerEmail,
          name: dto.customerName || dto.customerEmail,
        },
        customizations: {
          title: 'Fretiko Wallet Deposit',
          description: `Deposit ${dto.amount} ${dto.currency} to your Fretiko wallet`,
          logo: this.configService.get<string>('APP_LOGO_URL') || '',
        },
        meta: dto.meta || {},
      };

      // Use Flutterwave Payments API (not payment-links)
      // The correct endpoint is /v3/payments for creating payment links
      const paymentUrl = `${baseUrl}/payments`;
      
      this.logger.debug('Sending request to Flutterwave:', {
        url: paymentUrl,
        payload: { ...payload, customer: { email: payload.customer.email, name: payload.customer.name } },
      });

      const response = await axios.post(
        paymentUrl,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000, // 30 second timeout
        }
      );

      const responseData = response.data;

      // Flutterwave Payments API returns data in responseData.data
      if (responseData.status === 'success') {
        // Payment link is in responseData.data.link or responseData.data.authorization_url
        const paymentLink = responseData.data?.link || responseData.data?.authorization_url;
        
        if (paymentLink) {
          this.logger.log(`✅ Payment initialized: ${paymentLink}`);
          return {
            status: 'success',
            message: responseData.message || 'Payment link created successfully',
            data: {
              link: paymentLink,
              tx_ref: responseData.data?.tx_ref || dto.txRef,
            },
          };
        } else {
          this.logger.error('Payment link not found in response:', JSON.stringify(responseData, null, 2));
          throw new BadRequestException('Payment link not found in Flutterwave response');
        }
      } else {
        this.logger.error('Flutterwave API returned non-success status:', JSON.stringify(responseData, null, 2));
        const errorMessage = responseData.message || responseData.data?.message || responseData.error || 'Failed to initialize payment';
        throw new BadRequestException(`Flutterwave API error: ${errorMessage}`);
      }
    } catch (error: any) {
      // Log the raw error to understand its structure
      this.logger.error('Raw error:', {
        message: error?.message,
        name: error?.name,
        code: error?.code,
        response: error?.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        } : 'no response',
        request: error?.request ? 'request exists' : 'no request',
      });

      if (error.response) {
        // Axios error with response
        const errorData = error.response.data || {};
        this.logger.error('Flutterwave API error response:', JSON.stringify(errorData, null, 2));
        const errorMessage = errorData.message || errorData.data?.message || errorData.error || error.message || 'Failed to initialize payment';
        throw new BadRequestException(`Flutterwave API error: ${errorMessage}`);
      } else if (error.request) {
        // Request made but no response
        this.logger.error('Flutterwave API request error (no response)');
        throw new BadRequestException('Failed to connect to Flutterwave API. Please check your network connection and API keys.');
      } else {
        // Error setting up request
        this.logger.error('Error setting up Flutterwave request:', error.message);
        throw new BadRequestException(error.message || 'Failed to initialize payment');
      }
    }
  }

  /**
   * Verify payment transaction
   * Uses direct API call instead of SDK to avoid URL construction issues
   */
  async verifyPayment(transactionId: string): Promise<VerifyPaymentResponse> {
    const secretKey = this.configService.get<string>('FLW_SECRET_KEY');
    if (!secretKey) {
      throw new BadRequestException('Flutterwave is not configured. Please add FLW_SECRET_KEY to your .env file');
    }

    try {
      this.logger.log(`Verifying payment: ${transactionId}`);

      // Use direct API call instead of SDK to avoid URL construction bugs
      const response = await axios.get(
        `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
        {
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000, // 30 second timeout
        }
      );

      const responseData = response.data;

      if (responseData.status === 'success') {
        this.logger.log(`✅ Payment verified: ${responseData.data?.status || 'unknown'}`);
        return {
          status: 'success',
          message: responseData.message || 'Payment verified successfully',
          data: responseData.data,
        };
      } else {
        this.logger.error('Flutterwave verification returned non-success status:', JSON.stringify(responseData, null, 2));
        const errorMessage = responseData.message || 'Failed to verify payment';
        throw new BadRequestException(`Flutterwave API error: ${errorMessage}`);
      }
    } catch (error: any) {
      // Log the raw error to understand its structure
      this.logger.error('Error verifying payment:', {
        message: error?.message,
        name: error?.name,
        code: error?.code,
        response: error?.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        } : 'no response',
        request: error?.request ? 'request exists' : 'no request',
      });

      if (error.response) {
        // Axios error with response
        const errorData = error.response.data || {};
        this.logger.error('Flutterwave API error response:', JSON.stringify(errorData, null, 2));
        const errorMessage = errorData.message || errorData.data?.message || errorData.error || error.message || 'Failed to verify payment';
        throw new BadRequestException(`Flutterwave API error: ${errorMessage}`);
      } else if (error.request) {
        // Request made but no response
        this.logger.error('Flutterwave API request error (no response)');
        throw new BadRequestException('Failed to connect to Flutterwave API. Please check your network connection and API keys.');
      } else {
        // Error setting up request
        this.logger.error('Error setting up Flutterwave request:', error.message);
        throw new BadRequestException(error.message || 'Failed to verify payment');
      }
    }
  }

  /**
   * Initiate bank transfer for withdrawals
   */
  async initiateTransfer(dto: InitiateTransferDto): Promise<TransferResponse> {
    if (!this.flw) {
      throw new BadRequestException('Flutterwave is not configured. Please add FLW_PUBLIC_KEY and FLW_SECRET_KEY to your .env file');
    }

    try {
      this.logger.log(
        `Initiating transfer: ${dto.amount} ${dto.currency} to ${dto.accountNumber} (${dto.accountBank})`
      );

      // Sanitize account number (remove spaces, dashes, etc.)
      const sanitizedAccountNumber = dto.accountNumber.replace(/[\s\-_]/g, '');
      
      const payload: any = {
        account_bank: dto.accountBank.trim(), // Ensure bank code is trimmed
        account_number: sanitizedAccountNumber, // Use sanitized account number
        amount: dto.amount,
        currency: dto.currency, // Source currency (USD for FRETI)
        beneficiary_name: dto.beneficiaryName.trim(), // Trim beneficiary name
        narration: (dto.narration || 'Withdrawal from Fretiko wallet').substring(0, 150), // Ensure within limit
        reference: dto.reference,
        callback_url: dto.callbackUrl || `${this.configService.get<string>('API_URL')}/wallet/webhooks/flutterwave`,
        debit_currency: dto.currency, // Source currency (USD for FRETI)
      };

      // Explicitly specify destination currency if different from source
      // Flutterwave's API auto-detects conversion based on bank account country,
      // but we log the conversion explicitly for clarity and debugging
      if (dto.destinationCurrency && dto.destinationCurrency !== dto.currency) {
        this.logger.log(`💱 Explicit currency conversion requested: ${dto.amount} ${dto.currency} → ${dto.destinationCurrency}`);
        this.logger.log(`💱 Flutterwave will auto-convert based on bank account country. Expected destination: ${dto.destinationCurrency}`);
        
        // Note: Flutterwave v3 transfers API handles currency conversion automatically
        // based on the bank code/country. The currency field represents the source currency.
        // If conversion is needed, Flutterwave will convert to the destination currency
        // based on the bank account's country. We include this info in metadata for tracking.
        payload.meta = {
          ...payload.meta,
          source_currency: dto.currency,
          destination_currency: dto.destinationCurrency,
          conversion_explicit: true,
        };
      } else {
        this.logger.log(`💰 Same currency transfer: ${dto.amount} ${dto.currency} (no conversion needed)`);
      }

      // Use direct API call instead of SDK to avoid URL construction bugs
      const secretKey = this.configService.get<string>('FLW_SECRET_KEY');
      if (!secretKey) {
        throw new BadRequestException('Flutterwave secret key is not configured');
      }

      this.logger.log(`Using direct API call for transfer initiation to avoid SDK URL parsing issues`);
      
      // Make direct HTTP call to Flutterwave API
      const response = await axios.post(
        'https://api.flutterwave.com/v3/transfers',
        payload,
        {
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000, // 30 second timeout
        }
      );

      const responseData = response.data;

      if (responseData.status === 'success') {
        this.logger.log(`✅ Transfer initiated via direct API: ${responseData.data.reference}`);
        return {
          status: 'success',
          message: responseData.message || 'Transfer initiated successfully',
          data: responseData.data,
        };
      } else {
        throw new BadRequestException(responseData.message || 'Failed to initiate transfer');
      }
    } catch (error: any) {
      this.logger.error('Error initiating transfer:', {
        message: error.message,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          data: error.response.data,
        } : null,
      });
      
      // Check if it's a URL parsing error (shouldn't happen with direct API calls, but check anyway)
      if (error.message?.includes('parse URL') || error.message?.includes('Invalid URL') || error.code === 'ERR_INVALID_URL') {
        this.logger.error('❌ URL parsing error detected. This should not happen with direct API calls.');
        this.logger.error('❌ Please check your FLW_SECRET_KEY format in .env file.');
        throw new BadRequestException(
          'Payment gateway configuration error. Please verify your Flutterwave API keys are correctly set in the environment variables. The secret key format should be: FLWSECK_TEST-... or FLWSECK-...'
        );
      }

      // Handle API errors
      if (error.response) {
        const errorData = error.response.data || {};
        const errorMessage = errorData.message || errorData.data?.message || error.message || 'Failed to initiate transfer';
        throw new BadRequestException(`Flutterwave API error: ${errorMessage}`);
      }
      
      throw new BadRequestException(error.message || 'Failed to initiate transfer');
    }
  }

  /**
   * Verify transfer status
   */
  async verifyTransfer(transferId: string): Promise<VerifyTransferResponse> {
    if (!this.flw) {
      throw new BadRequestException('Flutterwave is not configured. Please add FLW_PUBLIC_KEY and FLW_SECRET_KEY to your .env file');
    }

    try {
      this.logger.log(`Verifying transfer: ${transferId}`);

      const response = await this.flw.Transfer.get({ id: transferId });

      if (response.status === 'success') {
        this.logger.log(`✅ Transfer verified: ${response.data.status}`);
        return response;
      } else {
        throw new BadRequestException(response.message || 'Failed to verify transfer');
      }
    } catch (error: any) {
      this.logger.error('Error verifying transfer:', error);
      throw new BadRequestException(error.message || 'Failed to verify transfer');
    }
  }

  /**
   * Get list of supported banks
   */
  async getBanks(country: string = 'NG'): Promise<Bank[]> {
    if (!this.flw) {
      throw new BadRequestException('Flutterwave is not configured. Please add FLW_PUBLIC_KEY and FLW_SECRET_KEY to your .env file');
    }

    try {
      this.logger.log(`Fetching banks for country: ${country}`);

      const response = await this.flw.Bank.country({ country });

      if (response.status === 'success') {
        return response.data.map((bank: any) => ({
          id: bank.id,
          code: bank.code,
          name: bank.name,
        }));
      } else {
        throw new BadRequestException(response.message || 'Failed to fetch banks');
      }
    } catch (error: any) {
      this.logger.error('Error fetching banks:', error);
      throw new BadRequestException(error.message || 'Failed to fetch banks');
    }
  }

  /**
   * Verify webhook signature
   * Flutterwave sends the signature in the 'verif-hash' header
   * The signature is HMAC SHA256 of the raw request body
   */
  verifyWebhook(rawBody: string, signature: string): boolean {
    try {
      const webhookSecret = this.configService.get<string>('FLW_WEBHOOK_SECRET');
      
      if (!webhookSecret) {
        this.logger.warn('⚠️ FLW_WEBHOOK_SECRET not configured. Webhook verification skipped.');
        return true; // Allow if not configured (for development)
      }

      if (!signature) {
        this.logger.warn('⚠️ No signature provided in webhook request');
        return false;
      }

      // Flutterwave uses HMAC SHA256 of the raw request body (not JSON stringified)
      const crypto = require('crypto');
      const hash = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      const isValid = hash === signature;
      
      if (!isValid) {
        this.logger.warn('❌ Webhook signature verification failed', {
          expected: hash.substring(0, 20) + '...',
          received: signature.substring(0, 20) + '...',
          rawBodyLength: rawBody.length,
          rawBodyPreview: rawBody.substring(0, 100),
          secretLength: webhookSecret.length,
          secretPreview: webhookSecret.substring(0, 10) + '...',
        });
        console.log('🔍 DEBUG - Full expected hash:', hash);
        console.log('🔍 DEBUG - Full received signature:', signature);
      } else {
        this.logger.log('✅ Signature verification successful', {
          hashPreview: hash.substring(0, 20) + '...',
        });
      }

      return isValid;
    } catch (error: any) {
      this.logger.error('Error verifying webhook:', error);
      return false;
    }
  }

  /**
   * Get real-time exchange rate from Flutterwave
   * This shows users exactly what they'll receive before depositing
   * @param sourceCurrency - Currency user is paying in (e.g., 'NGN')
   * @param destinationCurrency - Currency to convert to (e.g., 'USD')
   * @param amount - Amount in source currency
   */
  /**
   * Get exchange rate from a third-party API (fallback when Flutterwave fails)
   * Uses exchangerate-api.com which is free and doesn't require an API key
   */
  private async getExchangeRateFromThirdParty(
    sourceCurrency: string,
    destinationCurrency: string,
    amount: number
  ): Promise<{
    rate: number;
    source: { currency: string; amount: number };
    destination: { currency: string; amount: number };
  }> {
    try {
      this.logger.debug(`Fetching exchange rate from third-party API: ${amount} ${sourceCurrency} → ${destinationCurrency}`);

      // exchangerate-api.com provides rates from USD to all currencies
      // We need to get rates for both source and destination currencies
      const response = await axios.get(
        `https://api.exchangerate-api.com/v4/latest/USD`,
        {
          timeout: 10000, // 10 second timeout
        }
      );

      if (!response.data || !response.data.rates) {
        throw new Error('Invalid response from exchange rate API');
      }

      const rates = response.data.rates;
      const sourceCurrencyUpper = sourceCurrency.toUpperCase();
      const destinationCurrencyUpper = destinationCurrency.toUpperCase();

      // If source is USD, we can directly use the destination rate
      if (sourceCurrencyUpper === 'USD') {
        const destinationRate = rates[destinationCurrencyUpper];
        if (!destinationRate) {
          throw new Error(`Currency ${destinationCurrencyUpper} not supported by exchange rate API`);
        }
        const destinationAmount = amount * destinationRate;
        return {
          rate: destinationRate,
          source: { currency: 'USD', amount },
          destination: { currency: destinationCurrencyUpper, amount: destinationAmount },
        };
      }

      // If destination is USD, we use the inverse of the source rate
      if (destinationCurrencyUpper === 'USD') {
        const sourceRate = rates[sourceCurrencyUpper];
        if (!sourceRate) {
          throw new Error(`Currency ${sourceCurrencyUpper} not supported by exchange rate API`);
        }
        // Rate from source to USD = 1 / (rate from USD to source)
        const rate = 1 / sourceRate;
        const usdAmount = amount / sourceRate;
        return {
          rate,
          source: { currency: sourceCurrencyUpper, amount },
          destination: { currency: 'USD', amount: usdAmount },
        };
      }

      // Both are non-USD: convert source -> USD -> destination
      const sourceRate = rates[sourceCurrencyUpper];
      const destinationRate = rates[destinationCurrencyUpper];
      
      if (!sourceRate || !destinationRate) {
        throw new Error(`One or both currencies (${sourceCurrencyUpper}, ${destinationCurrencyUpper}) not supported`);
      }

      // Convert: source -> USD -> destination
      const usdAmount = amount / sourceRate;
      const destinationAmount = usdAmount * destinationRate;
      const rate = destinationRate / sourceRate;

      return {
        rate,
        source: { currency: sourceCurrencyUpper, amount },
        destination: { currency: destinationCurrencyUpper, amount: destinationAmount },
      };
    } catch (error: any) {
      this.logger.error('❌ Error fetching exchange rate from third-party API:', {
        error: error.message,
        sourceCurrency,
        destinationCurrency,
        amount,
        statusCode: error.response?.status,
        responseData: error.response?.data,
      });
      throw error;
    }
  }

  async getExchangeRate(
    sourceCurrency: string,
    destinationCurrency: string,
    amount: number
  ): Promise<{
    rate: number;
    source: { currency: string; amount: number };
    destination: { currency: string; amount: number };
  }> {
    // Check cache first (rates don't change every second, so caching is safe)
    const cacheKey = `${sourceCurrency.toUpperCase()}_${destinationCurrency.toUpperCase()}`;
    const cached = this.rateCache.get(cacheKey);
    
    // Only use cache for conversions to/from USD (most common case)
    // Cross-currency conversions need fresh API calls for accuracy
    const sourceUpper = sourceCurrency.toUpperCase();
    const destUpper = destinationCurrency.toUpperCase();
    const isToOrFromUSD = sourceUpper === 'USD' || destUpper === 'USD';
    
    if (cached && Date.now() < cached.expiry && isToOrFromUSD) {
      // Use cached rate, but recalculate amounts based on the new amount
      const cachedRate = cached.rate;
      let sourceAmount: number;
      let destinationAmount: number;
      
      if (destUpper === 'USD') {
        // Converting to USD: destinationAmount = sourceAmount / rate
        // Rate is from source to USD, so: USD = source / rate
        sourceAmount = amount;
        destinationAmount = amount / cachedRate;
      } else {
        // Converting from USD: destinationAmount = sourceAmount * rate
        // Rate is from USD to destination, so: destination = USD * rate
        sourceAmount = amount;
        destinationAmount = amount * cachedRate;
      }
      
      this.logger.debug(`✅ Using cached exchange rate: ${cacheKey} (rate: ${cachedRate.toFixed(4)})`);
      return {
        rate: cachedRate,
        source: {
          currency: sourceUpper,
          amount: sourceAmount,
        },
        destination: {
          currency: destUpper,
          amount: destinationAmount,
        },
      };
    } else if (!isToOrFromUSD) {
      // Cross-currency conversion - bypass cache and make fresh API call
      this.logger.debug(`⚠️ Cross-currency conversion (${sourceUpper} → ${destUpper}), making fresh API call for accuracy`);
    }

    let flutterwaveError: any = null;

    // Try Flutterwave first
    try {
      const secretKey = this.configService.get<string>('FLW_SECRET_KEY');
      if (secretKey) {
        this.logger.debug(`Attempting to fetch exchange rate from Flutterwave: ${amount} ${sourceCurrency} → ${destinationCurrency}`);

        const requestBody = {
          source: {
            currency: sourceCurrency.toUpperCase(),
            amount: amount.toString(),
          },
          destination: {
            currency: destinationCurrency.toUpperCase(),
          },
        };

        const response = await axios.post(
          `https://api.flutterwave.com/v3/transfers/rates`,
          requestBody,
          {
            headers: {
              Authorization: `Bearer ${secretKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000, // 15 second timeout
          }
        );

        if (response.data.status === 'success' && response.data.data) {
          const rateData = response.data.data;
          
          if (rateData.rate && rateData.source && rateData.destination) {
            const rate = parseFloat(rateData.rate);
            const result = {
              rate,
              source: {
                currency: rateData.source.currency,
                amount: parseFloat(rateData.source.amount),
              },
              destination: {
                currency: rateData.destination.currency,
                amount: parseFloat(rateData.destination.amount),
              },
            };
            
            // Cache the rate (amount-independent, so we can reuse for different amounts)
            this.rateCache.set(cacheKey, {
              ...result,
              expiry: Date.now() + this.RATE_CACHE_DURATION,
            });
            
            this.logger.debug(`✅ Exchange rate fetched from Flutterwave and cached: ${rate} (${rateData.source.currency} → ${rateData.destination.currency})`);
            
            return result;
          }
        }
      }
    } catch (error: any) {
      flutterwaveError = error;
      this.logger.warn(`⚠️ Flutterwave exchange rate API failed, trying fallback: ${error.message}`);
      // Continue to fallback
    }

    // Fallback to third-party API
    try {
      this.logger.debug(`Attempting to fetch exchange rate from third-party API: ${amount} ${sourceCurrency} → ${destinationCurrency}`);
      const result = await this.getExchangeRateFromThirdParty(sourceCurrency, destinationCurrency, amount);
      
      // Cache the rate from third-party API as well
      this.rateCache.set(cacheKey, {
        ...result,
        expiry: Date.now() + this.RATE_CACHE_DURATION,
      });
      
      this.logger.debug(`✅ Exchange rate fetched from third-party API and cached: ${result.rate} (${result.source.currency} → ${result.destination.currency})`);
      return result;
    } catch (thirdPartyError: any) {
      this.logger.error('❌ Both Flutterwave and third-party exchange rate APIs failed:', {
        flutterwaveError: flutterwaveError?.message || 'N/A',
        thirdPartyError: thirdPartyError.message,
        sourceCurrency,
        destinationCurrency,
        amount,
      });

      // If both fail, throw a user-friendly error
      throw new BadRequestException(
        'Deposit service is temporarily unavailable. We are unable to fetch current exchange rates. Please try again later.'
      );
    }
  }
}

