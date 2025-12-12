/**
 * FRETIKO BACKEND - BANK ACCOUNT SERVICE
 * Handles user bank account management for withdrawals/payouts
 */

import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServiceSupabaseClient } from '../shared/supabase.client';

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

      // Check if this is the first account (should be default)
      const existingAccounts = await this.getUserBankAccounts(userId);
      const isFirstAccount = existingAccounts.length === 0;

      // Infer country from currency if not provided
      let country = dto.country;
      if (!country && dto.currency) {
        const currencyToCountry: Record<string, string> = {
          'NGN': 'NG', 'GHS': 'GH', 'KES': 'KE', 'ZAR': 'ZA', 'UGX': 'UG',
          'TZS': 'TZ', 'RWF': 'RW', 'XAF': 'CM', 'XOF': 'SN', 'USD': 'US',
          'EUR': 'EU', 'GBP': 'GB', 'CAD': 'CA', 'AUD': 'AU',
        };
        country = currencyToCountry[dto.currency.toUpperCase()];
      }

      const { data, error } = await this.supabase
        .from('user_bank_accounts')
        .insert({
          user_id: userId,
          account_name: dto.accountName,
          bank_name: dto.bankName,
          bank_code: dto.bankCode,
          account_number: dto.accountNumber,
          account_type: dto.accountType || 'savings',
          currency: dto.currency || 'NGN',
          country: country,
          swift_code: dto.swiftCode,
          iban: dto.iban,
          routing_number: dto.routingNumber,
          branch_name: dto.branchName,
          branch_code: dto.branchCode,
          is_default: isFirstAccount ? true : (dto.isDefault || false),
          is_active: true,
          // Auto-verify on creation since actual verification is not yet implemented
          // TODO: Replace with actual bank account verification when implemented
          is_verified: true,
          verification_method: 'auto_verified',
          verified_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to create bank account for user ${userId}:`, error);
        throw new BadRequestException('Failed to create bank account');
      }

      this.logger.log(`✅ Bank account created for user ${userId}: ${data.id}`);
      return this.mapToFrontend(data);
    } catch (error) {
      this.logger.error(`Error creating bank account for user ${userId}:`, error);
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
   * Verify bank account (placeholder for payment provider integration)
   */
  async verifyBankAccount(userId: string, accountId: string): Promise<{ success: boolean; message: string }> {
    try {
      // Verify ownership
      await this.getBankAccount(userId, accountId);

      // TODO: Implement actual verification with payment provider
      // For now, mark as verified manually
      const { error } = await this.supabase
        .from('user_bank_accounts')
        .update({
          is_verified: true,
          verification_method: 'manual',
          verified_at: new Date().toISOString(),
        })
        .eq('id', accountId)
        .eq('user_id', userId);

      if (error) {
        this.logger.error(`Failed to verify bank account ${accountId}:`, error);
        throw new BadRequestException('Failed to verify bank account');
      }

      this.logger.log(`✅ Bank account verified: ${accountId}`);
      return {
        success: true,
        message: 'Bank account verified successfully',
      };
    } catch (error) {
      this.logger.error(`Error verifying bank account ${accountId}:`, error);
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

