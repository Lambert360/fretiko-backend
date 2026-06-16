/**
 * FRETIKO BACKEND - BANK ACCOUNT SERVICE
 * Handles user bank account management for withdrawals/payouts
 */

import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import axios from 'axios';

export interface BankAccount {
  id: string;
  userId: string;
  accountName: string;
  bankName: string;
  bankCode?: string;
  accountNumber: string;
  accountType: 'savings' | 'checking' | 'current';
  currency: string;
  country?: string; // ISO country code (e.g., 'NG', 'GH', 'US')
  isVerified: boolean;
  verificationMethod?: string;
  verifiedAt?: string;
  isDefault: boolean;
  swiftCode?: string;
  iban?: string;
  routingNumber?: string;
  branchName?: string;
  branchCode?: string;
  isActive: boolean;
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBankAccountDto {
  accountName: string;
  bankName: string;
  bankCode?: string;
  accountNumber: string;
  accountType?: 'savings' | 'checking' | 'current';
  currency?: string;
  country?: string; // ISO country code (e.g., 'NG', 'GH', 'US')
  swiftCode?: string;
  iban?: string;
  routingNumber?: string;
  branchName?: string;
  branchCode?: string;
  isDefault?: boolean;
  preVerifiedAccountName?: string; // If set, skip Flutterwave re-verification (e.g. after admin panel preview)
}

export interface UpdateBankAccountDto {
  accountName?: string;
  bankName?: string;
  bankCode?: string;
  accountType?: 'savings' | 'checking' | 'current';
  branchName?: string;
  branchCode?: string;
  isDefault?: boolean;
}

@Injectable()
export class BankAccountService {
  private readonly logger = new Logger(BankAccountService.name);
  private readonly supabase: SupabaseClient;

  // Countries where Flutterwave account resolution is reliable
  // Tier 1: Fully supported for real-time verification
  private readonly SUPPORTED_RESOLUTION_COUNTRIES = [
    'NG', // Nigeria
    'GH', // Ghana
    'KE', // Kenya
    'UG', // Uganda
    'TZ', // Tanzania
    'ZA', // South Africa
    'RW', // Rwanda
    'ZM', // Zambia
    'MW', // Malawi
    'BW', // Botswana
    'MZ', // Mozambique
  ];

  constructor(private readonly configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Get all bank accounts for a user
   */
  async getUserBankAccounts(userId: string): Promise<BankAccount[]> {
    try {
      const { data, error } = await this.supabase
        .from('user_bank_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) {
        this.logger.error(`Failed to fetch bank accounts for user ${userId}:`, error);
        throw new BadRequestException('Failed to fetch bank accounts');
      }

      return (data || []).map(this.mapToFrontend);
    } catch (error) {
      this.logger.error(`Error fetching bank accounts for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get a specific bank account
   */
  async getBankAccount(userId: string, accountId: string): Promise<BankAccount> {
    try {
      const { data, error } = await this.supabase
        .from('user_bank_accounts')
        .select('*')
        .eq('id', accountId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      if (error || !data) {
        throw new NotFoundException('Bank account not found');
      }

      return this.mapToFrontend(data);
    } catch (error) {
      this.logger.error(`Error fetching bank account ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Get default bank account
   */
  async getDefaultBankAccount(userId: string): Promise<BankAccount | null> {
    try {
      const { data, error } = await this.supabase
        .from('user_bank_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('is_default', true)
        .eq('is_active', true)
        .single();

      if (error || !data) {
        return null;
      }

      return this.mapToFrontend(data);
    } catch (error) {
      this.logger.error(`Error fetching default bank account for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Create a new bank account
   */
  async createBankAccount(userId: string, dto: CreateBankAccountDto): Promise<BankAccount> {
    try {
      // Validate required fields
      if (!dto.accountName || !dto.bankName || !dto.accountNumber) {
        throw new BadRequestException('Account name, bank name, and account number are required');
      }

      // Bank code is required for withdrawals (Flutterwave needs it)
      if (!dto.bankCode) {
        throw new BadRequestException(
          'Bank code is required. The bank code is needed to process withdrawals. Please provide your bank\'s code.'
        );
      }

      // Determine country for verification support check
      const effectiveCountry = dto.country?.toUpperCase() || 'NG';

      // Check if country supports real-time account verification
      if (!this.SUPPORTED_RESOLUTION_COUNTRIES.includes(effectiveCountry)) {
        throw new BadRequestException(
          `Bank account verification is not yet available in your country (${effectiveCountry}). ` +
          `We currently support: Nigeria, Ghana, Kenya, Uganda, Tanzania, South Africa, Rwanda, Zambia, Malawi, Botswana, and Mozambique. ` +
          `Please contact support for assistance.`
        );
      }

      // Check if this is the first account (should be default)
      const existingAccounts = await this.getUserBankAccounts(userId);
      const isFirstAccount = existingAccounts.length === 0;

      // Platform user can choose any country/currency combination
      const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000002';
      let country = dto.country;

      if (userId === PLATFORM_USER_ID) {
        // For platform user, use provided country or default to US
        country = dto.country || 'US';
      } else {
        // For regular users, infer country from currency if not provided
        if (!country && dto.currency) {
          const currencyToCountry: Record<string, string> = {
            // Major International Currencies
            'USD': 'US', 'EUR': 'EU', 'GBP': 'GB', 'CAD': 'CA', 'AUD': 'AU',
            
            // African Currencies (Flutterwave's primary market)
            'NGN': 'NG', 'GHS': 'GH', 'KES': 'KE', 'ZAR': 'ZA', 'UGX': 'UG',
            'TZS': 'TZ', 'RWF': 'RW', 'XAF': 'CM', 'XOF': 'SN', 'MWK': 'MW',
            'ZMW': 'ZM', 'EGP': 'EG', 'MAD': 'MA', 'SLL': 'SL', 'BWP': 'BW',
            'ETB': 'ET', 'MZN': 'MZ', 'MGA': 'MG', 'AOA': 'AO', 'SCR': 'SC',
            'MUR': 'MU', 'SZL': 'SZ', 'LSL': 'LS', 'NAD': 'NA', 'BIF': 'BI',
            'DJF': 'DJ', 'SOS': 'SO', 'SDG': 'SD', 'SSP': 'SS', 'STN': 'ST',
            'CDF': 'CD', 'LRD': 'LR', 'GMD': 'GM', 'GNF': 'GN', 'TND': 'TN',
            'DZD': 'DZ', 'MRU': 'MR',
          };
          country = currencyToCountry[dto.currency.toUpperCase()];
        }

        // For regular users, ensure we have a valid country
        if (!country) {
          country = 'NG'; // Default fallback for regular users
        }
      }

      // Verify the account before saving — either use a pre-verified name (already confirmed via
      // the preview endpoint) or call Flutterwave directly.
      let resolvedAccountName: string;
      if (dto.preVerifiedAccountName?.trim()) {
        resolvedAccountName = dto.preVerifiedAccountName.trim();
        this.logger.log(`✅ Using pre-verified account name: ${resolvedAccountName}`);
      } else {
        try {
          const resolvedAccount = await this.resolveAccountWithFlutterwave(
            dto.accountNumber,
            dto.bankCode,
          );
          resolvedAccountName = resolvedAccount.account_name;
          this.logger.log(`✅ Account verified with Flutterwave: ${resolvedAccountName}`);
        } catch (verifyError) {
          this.logger.error(`❌ Account verification failed during creation:`, verifyError);
          throw new BadRequestException(
            'Bank account verification failed. Please check your account number and bank code.'
          );
        }
      }

      // Create bank account with verified data
      const { data, error } = await this.supabase
        .from('user_bank_accounts')
        .insert({
          user_id: userId,
          account_name: resolvedAccountName, // Use the REAL name from Flutterwave
          bank_name: dto.bankName,
          bank_code: dto.bankCode,
          account_number: dto.accountNumber,
          account_type: dto.accountType || 'savings',
          currency: userId === PLATFORM_USER_ID ? (dto.currency || 'USD') : (dto.currency || 'NGN'),
          country: country,
          swift_code: dto.swiftCode,
          iban: dto.iban,
          routing_number: dto.routingNumber,
          branch_name: dto.branchName,
          branch_code: dto.branchCode,
          is_default: isFirstAccount ? true : (dto.isDefault || false),
          is_active: true,
          // Only verified accounts are stored - verification happens above
          is_verified: true,
          verification_method: 'flutterwave',
          verified_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to create bank account for user ${userId}:`, error);
        throw new BadRequestException('Failed to create bank account');
      }

      // AUDIT LOG: Bank account created with verification
      this.logger.log(`✅ [AUDIT] Bank account created with Flutterwave verification`, {
        timestamp: new Date().toISOString(),
        action: 'bank_account_created',
        userId,
        accountId: data.id,
        bankName: dto.bankName,
        bankCode: dto.bankCode,
        accountNumber: dto.accountNumber.substring(0, 4) + '****' + dto.accountNumber.slice(-4),
        verificationMethod: 'flutterwave',
        resolvedAccountName: resolvedAccountName,
      });

      return this.mapToFrontend(data);
    } catch (error) {
      // AUDIT LOG: Creation failed
      this.logger.error(`❌ [AUDIT] Bank account creation failed`, {
        timestamp: new Date().toISOString(),
        action: 'bank_account_creation_failed',
        userId,
        bankCode: dto.bankCode,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update a bank account
   */
  async updateBankAccount(userId: string, accountId: string, dto: UpdateBankAccountDto): Promise<BankAccount> {
    try {
      // Verify ownership
      await this.getBankAccount(userId, accountId);

      const { data, error } = await this.supabase
        .from('user_bank_accounts')
        .update({
          account_name: dto.accountName,
          bank_name: dto.bankName,
          bank_code: dto.bankCode,
          account_type: dto.accountType,
          branch_name: dto.branchName,
          branch_code: dto.branchCode,
          is_default: dto.isDefault,
        })
        .eq('id', accountId)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to update bank account ${accountId}:`, error);
        throw new BadRequestException('Failed to update bank account');
      }

      this.logger.log(`✅ Bank account updated: ${accountId}`);
      return this.mapToFrontend(data);
    } catch (error) {
      this.logger.error(`Error updating bank account ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Set default bank account
   */
  async setDefaultBankAccount(userId: string, accountId: string): Promise<BankAccount> {
    try {
      // Verify ownership
      await this.getBankAccount(userId, accountId);

      // Update the account (trigger will handle unsetting others)
      const { data, error } = await this.supabase
        .from('user_bank_accounts')
        .update({ is_default: true })
        .eq('id', accountId)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to set default bank account ${accountId}:`, error);
        throw new BadRequestException('Failed to set default bank account');
      }

      this.logger.log(`✅ Default bank account set: ${accountId}`);
      return this.mapToFrontend(data);
    } catch (error) {
      this.logger.error(`Error setting default bank account ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Delete (deactivate) a bank account
   */
  async deleteBankAccount(userId: string, accountId: string): Promise<{ success: boolean; message: string }> {
    try {
      // Verify ownership
      const account = await this.getBankAccount(userId, accountId);

      // Don't allow deleting the default account if there are other accounts
      if (account.isDefault) {
        const allAccounts = await this.getUserBankAccounts(userId);
        if (allAccounts.length > 1) {
          throw new BadRequestException('Cannot delete default account. Please set another account as default first.');
        }
      }

      // Soft delete (deactivate)
      const { error } = await this.supabase
        .from('user_bank_accounts')
        .update({
          is_active: false,
          deactivated_at: new Date().toISOString(),
          deactivation_reason: 'User requested deletion',
        })
        .eq('id', accountId)
        .eq('user_id', userId);

      if (error) {
        this.logger.error(`Failed to delete bank account ${accountId}:`, error);
        throw new BadRequestException('Failed to delete bank account');
      }

      this.logger.log(`✅ Bank account deleted: ${accountId}`);
      return {
        success: true,
        message: 'Bank account deleted successfully',
      };
    } catch (error) {
      this.logger.error(`Error deleting bank account ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Resolve bank account via Flutterwave to get verified account name
   * This is the REAL verification - hits Flutterwave API to confirm account exists
   */
  async resolveAccountWithFlutterwave(
    accountNumber: string,
    bankCode: string,
  ): Promise<{ account_name: string; account_number: string; bank_code: string }> {
    // AUDIT CONTEXT: Declare outside try block for catch block access
    const auditContext = {
      timestamp: new Date().toISOString(),
      action: 'account_resolution_attempt',
      accountNumber: accountNumber.substring(0, 4) + '****' + accountNumber.slice(-4), // Masked for security
      bankCode,
      source: 'flutterwave_api',
    };

    try {
      const secretKey = this.configService.get<string>('FLW_SECRET_KEY') || process.env.FLW_SECRET_KEY;
      
      if (!secretKey) {
        throw new BadRequestException('Flutterwave configuration missing');
      }

      // AUDIT LOG: Account resolution attempt
      this.logger.log(`🔍 [AUDIT] Account resolution initiated`, auditContext);

      const response = await axios.post(
        'https://api.flutterwave.com/v3/accounts/resolve',
        {
          account_number: accountNumber,
          account_bank: bankCode,
        },
        {
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const responseData = response.data;

      if (responseData.status === 'success' && responseData.data) {
        // AUDIT LOG: Successful resolution
        this.logger.log(`✅ [AUDIT] Account resolved successfully`, {
          ...auditContext,
          action: 'account_resolution_success',
          resolvedAccountName: responseData.data.account_name,
          resolvedBankCode: responseData.data.bank_code,
        });
        return {
          account_name: responseData.data.account_name,
          account_number: responseData.data.account_number,
          bank_code: responseData.data.bank_code,
        };
      } else {
        // AUDIT LOG: API returned error
        this.logger.warn(`⚠️ [AUDIT] Account resolution API error`, {
          ...auditContext,
          action: 'account_resolution_api_error',
          apiMessage: responseData.message,
        });
        throw new BadRequestException(
          responseData.message || 'Failed to resolve account'
        );
      }
    } catch (error: any) {
      // AUDIT LOG: Resolution failed
      this.logger.error('❌ [AUDIT] Account resolution failed', {
        ...auditContext,
        action: 'account_resolution_failed',
        errorMessage: error.message,
        errorResponse: error.response?.data,
        errorStatus: error.response?.status,
      });

      if (error.response?.data?.message?.includes('invalid account number')) {
        throw new BadRequestException(
          'Invalid account number. Please check your account number and bank code.'
        );
      }

      if (error.response?.data?.message?.includes('invalid bank code')) {
        throw new BadRequestException(
          'Invalid bank code. Please select a valid bank from the list.'
        );
      }

      throw new BadRequestException(
        error.response?.data?.message || 'Failed to verify account with bank'
      );
    }
  }

  /**
   * Verify bank account using Flutterwave account resolution
   * This replaces the manual verification placeholder
   */
  async verifyBankAccount(userId: string, accountId: string): Promise<{ 
    success: boolean; 
    message: string;
    accountName?: string;
  }> {
    try {
      // Get bank account details
      const bankAccount = await this.getBankAccount(userId, accountId);

      if (!bankAccount.bankCode) {
        throw new BadRequestException('Bank code is required for verification');
      }

      // Perform real verification with Flutterwave
      const resolvedAccount = await this.resolveAccountWithFlutterwave(
        bankAccount.accountNumber,
        bankAccount.bankCode,
      );

      // Update bank account with verified information
      const { error } = await this.supabase
        .from('user_bank_accounts')
        .update({
          account_name: resolvedAccount.account_name, // Store the REAL name from bank
          is_verified: true,
          verification_method: 'flutterwave',
          verified_at: new Date().toISOString(),
        })
        .eq('id', accountId)
        .eq('user_id', userId);

      if (error) {
        this.logger.error(`Failed to save verified bank account ${accountId}:`, error);
        throw new BadRequestException('Failed to save verified bank account');
      }

      this.logger.log(`✅ Bank account verified via Flutterwave: ${accountId}`);
      return {
        success: true,
        message: 'Bank account verified successfully',
        accountName: resolvedAccount.account_name,
      };
    } catch (error) {
      this.logger.error(`Error verifying bank account ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Preview account name before creating bank account
   * Allows users to verify the account details before saving
   */
  async previewAccountName(
    accountNumber: string,
    bankCode: string,
  ): Promise<{ accountName: string; accountNumber: string; bankCode: string }> {
    try {
      this.logger.log(`🔍 Previewing account: ${accountNumber} with bank: ${bankCode}`);

      // Resolve account with Flutterwave (read-only, doesn't save anything)
      const resolvedAccount = await this.resolveAccountWithFlutterwave(
        accountNumber,
        bankCode,
      );

      return {
        accountName: resolvedAccount.account_name,
        accountNumber: resolvedAccount.account_number,
        bankCode: resolvedAccount.bank_code,
      };
    } catch (error) {
      this.logger.error(`Error previewing account ${accountNumber}:`, error);
      throw error;
    }
  }

  /**
   * Map database record to frontend format
   */
  private mapToFrontend(data: any): BankAccount {
    return {
      id: data.id,
      userId: data.user_id,
      accountName: data.account_name,
      bankName: data.bank_name,
      bankCode: data.bank_code,
      accountNumber: data.account_number,
      accountType: data.account_type,
      currency: data.currency,
      country: data.country,
      isVerified: data.is_verified,
      verificationMethod: data.verification_method,
      verifiedAt: data.verified_at,
      isDefault: data.is_default,
      swiftCode: data.swift_code,
      iban: data.iban,
      routingNumber: data.routing_number,
      branchName: data.branch_name,
      branchCode: data.branch_code,
      isActive: data.is_active,
      metadata: data.metadata,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
}

