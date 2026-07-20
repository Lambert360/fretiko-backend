import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { FlutterwaveService } from '../wallet/flutterwave.service';
import { BankAccountService } from '../wallet/bank-account.service';

export interface PartnerWallet {
  id: string;
  partnerId: string;
  availableBalance: number;
  pendingWithdrawal: number;
  totalEarned: number;
  totalWithdrawn: number;
  preferredCurrency: string;
  updatedAt: string;
}

export interface PartnerBankAccount {
  id: string;
  partnerId: string;
  accountName: string;
  bankName: string;
  bankCode?: string;
  accountNumber: string;
  accountType: string;
  currency: string;
  country: string;
  isDefault: boolean;
  isVerified: boolean;
  createdAt: string;
}

export interface PartnerWithdrawal {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reference?: string;
  requestedAt: string;
  processedAt?: string;
  bankAccount?: { accountName: string; bankName: string; accountNumber: string } | null;
}

@Injectable()
export class PartnersWalletService {
  private readonly logger = new Logger(PartnersWalletService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private flutterwaveService: FlutterwaveService,
    private bankAccountService: BankAccountService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * GET /partners/wallet/banks/:country
   * Fetches bank list for country from Flutterwave.
   */
  async getBanks(country: string) {
    return this.flutterwaveService.getBanks(country.toUpperCase());
  }

  /**
   * POST /partners/wallet/bank-accounts/preview
   * Resolves account name from Flutterwave — read-only, nothing saved.
   */
  async previewBankAccount(accountNumber: string, bankCode: string) {
    return this.bankAccountService.previewAccountName(accountNumber, bankCode);
  }

  /**
   * Ensure a wallet row exists for the partner (idempotent — safe to call anytime).
   */
  async ensureWalletExists(partnerId: string, currency = 'NGN'): Promise<void> {
    const { error } = await this.supabase
      .from('partner_wallets')
      .upsert(
        { partner_id: partnerId, preferred_currency: currency },
        { onConflict: 'partner_id', ignoreDuplicates: true }
      );
    if (error) this.logger.warn('ensureWalletExists error:', error.message);
  }

  /**
   * GET /partners/wallet
   */
  async getWallet(partnerId: string): Promise<{ wallet: PartnerWallet; recentWithdrawals: PartnerWithdrawal[] }> {
    await this.ensureWalletExists(partnerId);

    const { data: wallet, error } = await this.supabase
      .from('partner_wallets')
      .select('*')
      .eq('partner_id', partnerId)
      .single();

    if (error || !wallet) throw new NotFoundException('Wallet not found');

    const { data: withdrawals } = await this.supabase
      .from('partner_withdrawals')
      .select(`
        id, amount, currency, status, reference, requested_at, processed_at,
        partner_bank_accounts ( account_name, bank_name, account_number )
      `)
      .eq('partner_id', partnerId)
      .order('requested_at', { ascending: false })
      .limit(20);

    return {
      wallet: this.mapWallet(wallet),
      recentWithdrawals: (withdrawals || []).map(this.mapWithdrawal),
    };
  }

  /**
   * GET /partners/wallet/bank-accounts
   */
  async getBankAccounts(partnerId: string): Promise<PartnerBankAccount[]> {
    const { data, error } = await this.supabase
      .from('partner_bank_accounts')
      .select('*')
      .eq('partner_id', partnerId)
      .eq('is_active', true)
      .order('is_default', { ascending: false });

    if (error) throw new BadRequestException('Failed to fetch bank accounts');
    return (data || []).map(this.mapBankAccount);
  }

  /**
   * POST /partners/wallet/bank-accounts
   */
  async addBankAccount(
    partnerId: string,
    dto: {
      accountName?: string;
      bankName: string;
      bankCode?: string;
      accountNumber: string;
      accountType?: string;
      currency?: string;
      country?: string;
      isDefault?: boolean;
      preVerifiedAccountName?: string;
    }
  ): Promise<PartnerBankAccount> {
    if (!dto.bankCode) throw new BadRequestException('Bank code is required.');

    // Use pre-verified name (from preview step) or fall back to Flutterwave live lookup
    let resolvedName: string;
    if (dto.preVerifiedAccountName?.trim()) {
      resolvedName = dto.preVerifiedAccountName.trim();
    } else if (dto.accountName?.trim()) {
      resolvedName = dto.accountName.trim();
    } else {
      const preview = await this.bankAccountService.previewAccountName(dto.accountNumber, dto.bankCode);
      resolvedName = preview.accountName;
    }

    if (dto.isDefault) {
      await this.supabase
        .from('partner_bank_accounts')
        .update({ is_default: false })
        .eq('partner_id', partnerId);
    }

    // Check if this is first account — make it default automatically
    const { count } = await this.supabase
      .from('partner_bank_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('partner_id', partnerId)
      .eq('is_active', true);
    const isFirst = (count ?? 0) === 0;

    const { data, error } = await this.supabase
      .from('partner_bank_accounts')
      .insert({
        partner_id: partnerId,
        account_name: resolvedName,
        bank_name: dto.bankName,
        bank_code: dto.bankCode,
        account_number: dto.accountNumber,
        account_type: dto.accountType || 'savings',
        currency: dto.currency || 'NGN',
        country: dto.country || 'NG',
        is_default: isFirst ? true : (dto.isDefault ?? false),
        is_verified: true,
      })
      .select()
      .single();

    if (error) throw new BadRequestException('Failed to add bank account');
    return this.mapBankAccount(data);
  }

  /**
   * PATCH /partners/wallet/bank-accounts/:id/default — set as default
   */
  async setDefaultBankAccount(partnerId: string, accountId: string): Promise<{ success: boolean }> {
    await this.supabase
      .from('partner_bank_accounts')
      .update({ is_default: false })
      .eq('partner_id', partnerId);

    const { error } = await this.supabase
      .from('partner_bank_accounts')
      .update({ is_default: true })
      .eq('id', accountId)
      .eq('partner_id', partnerId);

    if (error) throw new BadRequestException('Failed to set default account');
    return { success: true };
  }

  /**
   * DELETE /partners/wallet/bank-accounts/:id
   */
  async deleteBankAccount(partnerId: string, accountId: string): Promise<{ success: boolean }> {
    const { error } = await this.supabase
      .from('partner_bank_accounts')
      .update({ is_active: false })
      .eq('id', accountId)
      .eq('partner_id', partnerId);

    if (error) throw new BadRequestException('Failed to remove bank account');
    return { success: true };
  }

  /**
   * POST /partners/wallet/withdraw
   */
  async requestWithdrawal(
    partnerId: string,
    dto: { amount: number; bankAccountId: string }
  ): Promise<{ success: boolean; message: string; withdrawal?: PartnerWithdrawal }> {
    const { data: wallet, error: wErr } = await this.supabase
      .from('partner_wallets')
      .select('id, available_balance, preferred_currency')
      .eq('partner_id', partnerId)
      .single();

    if (wErr || !wallet) return { success: false, message: 'Wallet not found.' };
    if (dto.amount <= 0) return { success: false, message: 'Amount must be greater than zero.' };
    if (dto.amount > wallet.available_balance) {
      return { success: false, message: `Insufficient balance. Available: ${wallet.preferred_currency} ${wallet.available_balance.toFixed(2)}` };
    }

    const { data: bankAccount } = await this.supabase
      .from('partner_bank_accounts')
      .select('id')
      .eq('id', dto.bankAccountId)
      .eq('partner_id', partnerId)
      .eq('is_active', true)
      .single();

    if (!bankAccount) return { success: false, message: 'Bank account not found.' };

    // Fetch current pending_withdrawal so we can increment it
    const currentPending = parseFloat(wallet.pending_withdrawal ?? 0);

    // Deduct from available, add to pending
    await this.supabase
      .from('partner_wallets')
      .update({
        available_balance: wallet.available_balance - dto.amount,
        pending_withdrawal: currentPending + dto.amount,
        updated_at: new Date().toISOString(),
      })
      .eq('partner_id', partnerId);

    const reference = `PWD-${Date.now()}-${partnerId.substring(0, 8).toUpperCase()}`;

    const { data: withdrawal, error: wdErr } = await this.supabase
      .from('partner_withdrawals')
      .insert({
        partner_id: partnerId,
        wallet_id: wallet.id,
        bank_account_id: dto.bankAccountId,
        amount: dto.amount,
        currency: wallet.preferred_currency,
        status: 'pending',
        reference,
      })
      .select()
      .single();

    if (wdErr) return { success: false, message: 'Failed to create withdrawal request.' };

    return {
      success: true,
      message: 'Withdrawal request submitted. Funds will be transferred within 1–3 business days.',
      withdrawal: this.mapWithdrawal(withdrawal),
    };
  }

  /**
   * Called after a delivery is completed.
   * If the rider belongs to a logistics partner company, credits the partner's
   * real-money wallet and returns { credited: true }.
   * If the rider is independent, returns { credited: false } so the caller
   * falls back to the normal Freti rider payment.
   */
  async creditPartnerForDelivery(
    riderId: string,
    amount: number,
    description: string,
  ): Promise<{ credited: boolean; partnerId?: string }> {
    try {
      const { data: rider } = await this.supabase
        .from('verified_riders')
        .select('company_id')
        .eq('user_id', riderId)
        .eq('verification_status', 'active')
        .single();

      if (!rider?.company_id) return { credited: false };

      await this.ensureWalletExists(rider.company_id);

      const { data: wallet } = await this.supabase
        .from('partner_wallets')
        .select('available_balance, total_earned')
        .eq('partner_id', rider.company_id)
        .single();

      if (!wallet) return { credited: false };

      const { error } = await this.supabase
        .from('partner_wallets')
        .update({
          available_balance: parseFloat(wallet.available_balance) + amount,
          total_earned: parseFloat(wallet.total_earned) + amount,
          updated_at: new Date().toISOString(),
        })
        .eq('partner_id', rider.company_id);

      if (error) {
        this.logger.error(`Failed to credit partner wallet (rider ${riderId}): ${error.message}`);
        return { credited: false };
      }

      this.logger.log(`✅ Credited partner ${rider.company_id} wallet: +${amount} — ${description}`);
      return { credited: true, partnerId: rider.company_id };
    } catch (err: any) {
      this.logger.error(`creditPartnerForDelivery error: ${err.message}`);
      return { credited: false };
    }
  }

  // ── Mappers ──────────────────────────────────────────────────────────────

  private mapWallet = (w: any): PartnerWallet => ({
    id: w.id,
    partnerId: w.partner_id,
    availableBalance: parseFloat(w.available_balance) || 0,
    pendingWithdrawal: parseFloat(w.pending_withdrawal) || 0,
    totalEarned: parseFloat(w.total_earned) || 0,
    totalWithdrawn: parseFloat(w.total_withdrawn) || 0,
    preferredCurrency: w.preferred_currency || 'NGN',
    updatedAt: w.updated_at,
  });

  private mapBankAccount = (a: any): PartnerBankAccount => ({
    id: a.id,
    partnerId: a.partner_id,
    accountName: a.account_name,
    bankName: a.bank_name,
    bankCode: a.bank_code,
    accountNumber: a.account_number,
    accountType: a.account_type,
    currency: a.currency,
    country: a.country,
    isDefault: a.is_default,
    isVerified: a.is_verified,
    createdAt: a.created_at,
  });

  private mapWithdrawal = (w: any): PartnerWithdrawal => ({
    id: w.id,
    amount: parseFloat(w.amount) || 0,
    currency: w.currency,
    status: w.status,
    reference: w.reference,
    requestedAt: w.requested_at,
    processedAt: w.processed_at,
    bankAccount: w.partner_bank_accounts
      ? {
          accountName: w.partner_bank_accounts.account_name,
          bankName: w.partner_bank_accounts.bank_name,
          accountNumber: w.partner_bank_accounts.account_number,
        }
      : null,
  });
}
