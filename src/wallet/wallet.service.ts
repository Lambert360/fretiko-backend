import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { Cron, CronExpression } from '@nestjs/schedule';

import { createServiceSupabaseClient } from '../shared/supabase.client';

import { NotificationHelperService } from '../notifications/notification-helper.service';

import { FlutterwaveService } from './flutterwave.service';

import { BankAccountService } from './bank-account.service';

import { ReconciliationService } from './reconciliation.service';

import { ProcessingTimeService } from './processing-time.service';

import { WithdrawalValidationService } from './withdrawal-validation.service';

import { WalletTransactionType, isValidTransactionType, getAllTransactionTypes } from './constants/transaction-types';

import { randomUUID } from 'crypto';

import { 

  WalletResponseDto, 

  DepositRequestDto, 

  WithdrawRequestDto,

  TransactionHistoryQueryDto,

  LedgerEntryDto,

  WalletStatsDto,

  TrustScoreDto,

  EscrowBypassCheckDto,

  EscrowBypassResponseDto,

  PayoutRequestResponseDto,

  DepositResponseDto

} from './dto/wallet.dto';

import { Wallet, WalletLedger, PayoutRequest, Deposit, TrustScore, RiskFlag } from './entities/wallet.entity';



@Injectable()

export class WalletService {

  private readonly logger = new Logger(WalletService.name);

  private supabase;

  

  // Constants

  private readonly FRETI_USD_RATE = 1.0; // 1 Freti = 1 USD (invariant)

  private readonly MIN_TRUST_SCORE = 750; // Minimum for escrow bypass

  private readonly HIGH_RISK_CATEGORIES = ['electronics', 'jewelry', 'cash'];

  private readonly AUTO_RELEASE_HOURS = 72; // Auto-release escrow after 72 hours



  // ✅ TASK 3.2: Wallet balance cache (in-memory with TTL)

  // ✅ BUG FIX: Make cache TTL configurable via environment variable

  private readonly BALANCE_CACHE_TTL: number;

  private balanceCache = new Map<string, { data: WalletResponseDto; expiry: number }>();

  // ✅ BUG FIX: Cache locks to prevent race conditions in concurrent requests

  private cacheLocks = new Map<string, Promise<WalletResponseDto>>();



  // ✅ BUG FIX: Configurable security alert thresholds (initialized in constructor)

  private readonly SECURITY_ALERT_THRESHOLD: number;

  private readonly SECURITY_ALERT_TIME_WINDOW: string;



  constructor(

    private configService: ConfigService,

    private notificationHelper: NotificationHelperService,

    private flutterwaveService: FlutterwaveService,

    private bankAccountService: BankAccountService,

    private reconciliationService: ReconciliationService,

    private processingTimeService: ProcessingTimeService,

    private withdrawalValidation: WithdrawalValidationService

  ) {

    this.supabase = createServiceSupabaseClient(this.configService);

    

    // ✅ BUG FIX: Initialize configurable security alert thresholds

    this.SECURITY_ALERT_THRESHOLD = this.configService.get<number>('WALLET_SECURITY_ALERT_THRESHOLD', 10);

    this.SECURITY_ALERT_TIME_WINDOW = this.configService.get<string>('WALLET_SECURITY_ALERT_TIME_WINDOW', '5 minutes');

    

    // ✅ BUG FIX: Initialize configurable cache TTL (default: 30 seconds, can be increased for high-traffic scenarios)

    const cacheTtlSeconds = this.configService.get<number>('WALLET_CACHE_TTL_SECONDS', 30);

    this.BALANCE_CACHE_TTL = cacheTtlSeconds * 1000;

    

    // ✅ TASK 4.1: Ensure platform wallet exists on service startup

    this.ensurePlatformWallet().catch(error => {

      this.logger.error('Failed to ensure platform wallet exists:', error);

      // Don't throw - service can still start, but log the error

    });

  }



  /**

   * Ensure platform wallet exists (called on service startup)

   * Platform wallet is used to receive platform commissions

   * ✅ BUG FIX: Preserves existing balances when wallet already exists

   * ✅ BUG FIX: Only creates wallet if it doesn't exist, never resets balances

   */

  private async ensurePlatformWallet(): Promise<void> {

    const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000002';

    

    try {

      // First, check if wallet already exists

      const { data: existingWallet, error: fetchError } = await this.supabase

        .from('wallets')

        .select('id, kyc_status, daily_deposit_limit, daily_withdrawal_limit')

        .eq('user_id', PLATFORM_USER_ID)

        .single();



      if (fetchError && fetchError.code !== 'PGRST116') {

        // PGRST116 = not found, which is expected if wallet doesn't exist

        // Any other error is a real problem

        this.logger.error('Failed to check platform wallet existence:', fetchError);

        return;

      }



      if (existingWallet) {

        // Wallet exists - only update non-balance fields if needed

        const updates: any = {};

        let needsUpdate = false;



        if (existingWallet.kyc_status !== 'approved') {

          updates.kyc_status = 'approved';

          needsUpdate = true;

        }



        if (existingWallet.daily_deposit_limit !== 999999999.0) {

          updates.daily_deposit_limit = 999999999.0;

          needsUpdate = true;

        }



        if (existingWallet.daily_withdrawal_limit !== 999999999.0) {

          updates.daily_withdrawal_limit = 999999999.0;

          needsUpdate = true;

        }



        if (needsUpdate) {

          updates.updated_at = new Date().toISOString();

          const { error: updateError } = await this.supabase

            .from('wallets')

            .update(updates)

            .eq('id', existingWallet.id);



          if (updateError) {

            this.logger.error('Failed to update platform wallet settings:', updateError);

          } else {

            this.logger.log(`✅ Platform wallet settings updated (preserved balances): ${existingWallet.id}`);

          }

        } else {

          this.logger.debug('Platform wallet already exists with correct settings (balances preserved)');

        }

      } else {

        // Wallet doesn't exist - create it with default values

        const { data: newWallet, error: insertError } = await this.supabase

          .from('wallets')

          .insert({

            user_id: PLATFORM_USER_ID,

            available_balance: 0.0,

            escrow_balance: 0.0,

            pending_withdrawal: 0.0,

            preferred_currency: 'USD',

            kyc_status: 'approved',

            daily_deposit_limit: 999999999.0,

            daily_withdrawal_limit: 999999999.0,

          })

          .select()

          .single();



        if (insertError) {

          // If insert fails due to race condition (another instance created it), that's okay

          if (insertError.code === '23505') {

            // Unique constraint violation - wallet was created by another instance

            this.logger.debug('Platform wallet was created by another instance (race condition handled)');

          } else {

            this.logger.error('Failed to create platform wallet:', insertError);

          }

        } else if (newWallet) {

          this.logger.log(`✅ Platform wallet created: ${newWallet.id}`);

        }

      }

    } catch (error: any) {

      this.logger.error('Error ensuring platform wallet exists:', error);

      // Don't throw - this is a non-critical initialization check

    }

  }



  // ================================

  // WALLET OPERATIONS

  // ================================



  /**

   * Helper function to safely call process_wallet_transaction RPC

   * Validates both Supabase error and RPC return value success field

   * Includes retry logic with exponential backoff for transient failures

   * 

   * @param maxRetries Maximum number of retry attempts (default: 3)

   * @returns Object with success flag, transactionId if successful, or error message

   */

  async processWalletTransaction(

    userId: string,

    transactionType: string,

    amount: number,

    description: string,

    referenceId?: string,

    referenceType?: string,

    maxRetries: number = 3

  ): Promise<{ success: boolean; transactionId?: string; error?: string; idempotent?: boolean }> {

    // ✅ BUG FIX: Validate transaction type before processing

    if (!isValidTransactionType(transactionType)) {

      const error = `Invalid transaction type: ${transactionType}. Valid types: ${getAllTransactionTypes().join(', ')}`;

      this.logger.error(`[processWalletTransaction] ${error} (user: ${userId})`);

      return { success: false, error };

    }



    // ✅ BUG FIX: Validate amount is a valid number and not zero

    if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount)) {

      const error = `Invalid amount: must be a valid number, got ${amount}`;

      this.logger.error(`[processWalletTransaction] ${error} (user: ${userId})`);

      return { success: false, error };

    }



    if (amount === 0) {

      const error = `Invalid amount: cannot be zero for transaction type ${transactionType}`;

      this.logger.error(`[processWalletTransaction] ${error} (user: ${userId})`);

      return { success: false, error };

    }



    // ✅ BUG FIX: Validate amount is positive for credit transactions and negative for debit transactions

    // Note: Some transaction types can be positive or negative (e.g., ADMIN_ADJUSTMENT)

    // For most transactions, we validate based on their nature

    const creditTypes = [

      WalletTransactionType.DEPOSIT_MINT,

      WalletTransactionType.ESCROW_RELEASE,

      WalletTransactionType.ESCROW_REFUND,

      WalletTransactionType.REWARD_CREDIT,

      WalletTransactionType.DELIVERY_PAYMENT,

      WalletTransactionType.PLATFORM_COMMISSION,

    ];

    

    const debitTypes = [

      WalletTransactionType.WITHDRAWAL_BURN,

      WalletTransactionType.FEE_DEDUCTION,

    ];



    // ADMIN_ADJUSTMENT and PURCHASE_HOLD can be positive or negative

    if (creditTypes.includes(transactionType as WalletTransactionType) && amount < 0) {

      const error = `Invalid amount for credit transaction type ${transactionType}: amount must be positive, got ${amount}`;

      this.logger.error(`[processWalletTransaction] ${error} (user: ${userId})`);

      return { success: false, error };

    }



    if (debitTypes.includes(transactionType as WalletTransactionType) && amount > 0) {

      const error = `Invalid amount for debit transaction type ${transactionType}: amount must be negative, got ${amount}`;

      this.logger.error(`[processWalletTransaction] ${error} (user: ${userId})`);

      return { success: false, error };

    }



    let lastError: string | undefined;

    let lastException: any;



    for (let attempt = 0; attempt <= maxRetries; attempt++) {

      // Add delay before retry (exponential backoff: 1s, 2s, 4s)

      if (attempt > 0) {

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000); // Max 4 seconds

        this.logger.warn(

          `Retrying wallet transaction (attempt ${attempt + 1}/${maxRetries + 1}): ` +

          `${transactionType} for user ${userId}, waiting ${delay}ms`

        );

        await new Promise(resolve => setTimeout(resolve, delay));

      }



      try {

        // 🔥 FIX: Ensure reference_id is either a valid UUID string or null (not empty string, not undefined)

        const normalizedReferenceId = (referenceId && typeof referenceId === 'string' && referenceId.trim() !== '') 

          ? referenceId.trim() 

          : null;

        const normalizedReferenceType = (referenceType && typeof referenceType === 'string' && referenceType.trim() !== '') 

          ? referenceType.trim() 

          : null;

        

        const { data: rawData, error } = await this.supabase.rpc('process_wallet_transaction', {

          p_user_id: userId,

          p_transaction_type: transactionType,

          p_amount: amount,

          p_description: description,

          p_reference_id: normalizedReferenceId,

          p_reference_type: normalizedReferenceType,

        });



        // 🔧 FIX: Supabase RPC returns array for RETURNS TABLE functions, extract first element

        const data = Array.isArray(rawData) && rawData.length > 0 ? rawData[0] : rawData;



        // Check for Supabase RPC call error

        if (error) {

          const errorMsg = error.message || 'RPC call failed';

          lastError = errorMsg;



          // ✅ TASK 3.1: Log negative balance attempts from RPC errors

          if (errorMsg.toLowerCase().includes('insufficient')) {

            await this.logSecurityEvent({

              type: 'insufficient_balance_attempt',

              userId,

              transactionType,

              amount,

              currentBalance: null, // RPC error doesn't provide balance info

              errorMessage: errorMsg,

              timestamp: new Date().toISOString(),

            });



            // Check for suspicious pattern

            const recentAttempts = await this.getRecentFailedAttempts(userId, this.SECURITY_ALERT_TIME_WINDOW);

            if (recentAttempts.length > this.SECURITY_ALERT_THRESHOLD) {

              await this.triggerSecurityAlert({

                severity: 'medium',

                event: 'repeated_insufficient_balance_attempts',

                userId,

                attemptCount: recentAttempts.length,

                timeWindow: this.SECURITY_ALERT_TIME_WINDOW,

              });

            }

          }



          // Check if this is a retryable error

          if (this.isRetryableError(error, errorMsg)) {

            this.logger.warn(

              `Retryable RPC error for ${transactionType} (user: ${userId}, attempt ${attempt + 1}):`,

              errorMsg

            );

            continue; // Retry

          } else {

            // Non-retryable error - return immediately

            this.logger.error(`Non-retryable RPC error for ${transactionType} (user: ${userId}):`, errorMsg);

            // ✅ BUG FIX: Invalidate cache on RPC error to prevent stale data

            this.invalidateWalletCache(userId);

            return { success: false, error: errorMsg };

          }

        }



        // Check for RPC function return value (data.success)

        if (!data || !data.success) {

          // 🔍 DEBUG: Log the actual RPC response to see what's being returned

          this.logger.error(`🔍 RPC Response Debug for ${transactionType}:`, JSON.stringify(data, null, 2));

          

          const errorMsg = data?.error || data?.error_message || 'Transaction failed without error message';

          lastError = errorMsg;

          

          // ✅ PHASE 2: Log idempotent transaction detection (duplicate prevented)

          // The RPC function now checks for duplicates and returns existing transaction



          // ✅ TASK 3.1: Log negative balance attempts for security monitoring

          if (errorMsg.toLowerCase().includes('insufficient')) {

            await this.logSecurityEvent({

              type: 'insufficient_balance_attempt',

              userId,

              transactionType,

              amount,

              currentBalance: data?.previous_available || null,

              errorMessage: errorMsg,

              timestamp: new Date().toISOString(),

            });



            // Check for suspicious pattern (multiple rapid attempts)

            const recentAttempts = await this.getRecentFailedAttempts(userId, this.SECURITY_ALERT_TIME_WINDOW);

            if (recentAttempts.length > this.SECURITY_ALERT_THRESHOLD) {

              await this.triggerSecurityAlert({

                severity: 'medium',

                event: 'repeated_insufficient_balance_attempts',

                userId,

                attemptCount: recentAttempts.length,

                timeWindow: this.SECURITY_ALERT_TIME_WINDOW,

              });

            }

          }



          // Check if this is a retryable error

          if (this.isRetryableError(null, errorMsg)) {

            this.logger.warn(

              `Retryable transaction failure for ${transactionType} (user: ${userId}, attempt ${attempt + 1}):`,

              errorMsg

            );

            continue; // Retry

          } else {

            // Non-retryable error - return immediately

            this.logger.error(`Non-retryable transaction failure for ${transactionType} (user: ${userId}):`, errorMsg);

            

            // ✅ BUG FIX: Invalidate cache on failure to prevent stale data

            this.invalidateWalletCache(userId);

            

            return { success: false, error: errorMsg };

          }

        }



        // Success - return transaction details

        // ✅ PHASE 2: Log idempotent transaction detection (duplicate prevented)

        if (data.idempotent) {

          this.logger.warn(

            `⚠️ IDEMPOTENT: Duplicate transaction prevented for ${transactionType} (user: ${userId}, reference: ${normalizedReferenceId}, referenceType: ${normalizedReferenceType}). Returning existing transaction ${data.transaction_id}`

          );

          // Log to reconciliation_alerts for monitoring

          try {

            await this.supabase

              .from('reconciliation_alerts')

              .insert({

                user_id: userId,

                alert_type: 'duplicate_transaction_prevented',

                alert_severity: 'low',

                alert_reason: `Idempotent check prevented duplicate ${transactionType} transaction with reference ${normalizedReferenceId}`,

                status: 'resolved', // Already handled by idempotency check

                local_amount: amount,

                local_currency: 'USD',

                metadata: {

                  transaction_type: transactionType,

                  reference_id: normalizedReferenceId,

                  reference_type: normalizedReferenceType,

                  existing_transaction_id: data.transaction_id,

                  timestamp: new Date().toISOString(),

                },

              });

          } catch (alertError) {

            // Don't throw - alerting failure shouldn't block transaction processing

            this.logger.warn('Failed to log duplicate transaction alert:', alertError);

          }

        } else if (attempt > 0) {

          this.logger.log(

            `✅ Wallet transaction successful after ${attempt} retries: ${transactionType} for user ${userId}, amount: ${amount}`

          );

        } else {

          this.logger.log(`✅ Wallet transaction successful: ${transactionType} for user ${userId}, amount: ${amount}`);

        }



        // ✅ TASK 3.2: Invalidate cache after successful transaction

        this.invalidateWalletCache(userId);



        return { 

          success: true, 

          transactionId: data.transaction_id,

          idempotent: data.idempotent || false

        };

      } catch (error: any) {

        lastException = error;

        const errorMsg = error.message || 'Unexpected error in wallet transaction';

        lastError = errorMsg;



        // Check if this is a retryable exception

        if (this.isRetryableError(error, errorMsg)) {

          this.logger.warn(

            `Retryable exception in processWalletTransaction (attempt ${attempt + 1}):`,

            errorMsg

          );

          continue; // Retry

        } else {

          // Non-retryable exception - return immediately

          this.logger.error(`Non-retryable exception in processWalletTransaction:`, error);

          

          // ✅ BUG FIX: Invalidate cache on failure to prevent stale data

          this.invalidateWalletCache(userId);

          

          return { success: false, error: errorMsg };

        }

      }

    }



    // All retries exhausted

    const finalError = lastError || 'Transaction failed after all retries';

    this.logger.error(

      `❌ Wallet transaction failed after ${maxRetries + 1} attempts: ${transactionType} for user ${userId}:`,

      finalError

    );

    

    // ✅ BUG FIX: Invalidate cache on final failure

    this.invalidateWalletCache(userId);

    

    return { success: false, error: finalError };

  }



  /**

   * Log security event for monitoring and alerting

   */

  private async logSecurityEvent(event: {

    type: string;

    userId: string;

    transactionType?: string;

    amount?: number;

    currentBalance?: number | null;

    errorMessage?: string;

    timestamp: string;

  }): Promise<void> {

    try {

      // Log to wallet_audit_log table

      await this.supabase

        .from('wallet_audit_log')

        .insert({

          user_id: event.userId,

          operation: event.type,

          table_name: 'wallets',

          old_values: {

            current_balance: event.currentBalance,

            transaction_type: event.transactionType,

            amount: event.amount,

          },

          new_values: {

            error_message: event.errorMessage,

            timestamp: event.timestamp,

          },

          created_at: event.timestamp,

        });



      this.logger.warn(

        `🔒 Security event logged: ${event.type} for user ${event.userId} ` +

        `(Balance: ${event.currentBalance || 'unknown'}, Amount: ${event.amount || 'N/A'})`

      );

    } catch (error: any) {

      // Don't throw - logging failures shouldn't break the flow

      this.logger.error('Failed to log security event:', error);

    }

  }



  /**

   * Get recent failed attempts for a user within a time window

   * ✅ BUG FIX: Properly parse time window strings like "5 minutes"

   */

  private async getRecentFailedAttempts(

    userId: string,

    timeWindow: string = '5 minutes'

  ): Promise<any[]> {

    try {

      // Parse time window string (e.g., "5 minutes" -> 5 minutes in milliseconds)

      let windowMs = 5 * 60 * 1000; // Default: 5 minutes

      const timeWindowLower = timeWindow.toLowerCase().trim();

      

      if (timeWindowLower.includes('minute')) {

        const minutes = parseInt(timeWindowLower) || 5;

        windowMs = minutes * 60 * 1000;

      } else if (timeWindowLower.includes('hour')) {

        const hours = parseInt(timeWindowLower) || 1;

        windowMs = hours * 60 * 60 * 1000;

      } else if (timeWindowLower.includes('second')) {

        const seconds = parseInt(timeWindowLower) || 30;

        windowMs = seconds * 1000;

      } else {

        // Fallback: try to parse as number of minutes

        const parsed = parseInt(timeWindowLower);

        if (!isNaN(parsed)) {

          windowMs = parsed * 60 * 1000;

        }

      }

      

      const cutoffTime = new Date(Date.now() - windowMs).toISOString();



      const { data } = await this.supabase

        .from('wallet_audit_log')

        .select('*')

        .eq('user_id', userId)

        .eq('operation', 'insufficient_balance_attempt')

        .gte('created_at', cutoffTime)

        .order('created_at', { ascending: false });



      return data || [];

    } catch (error: any) {

      this.logger.error('Failed to get recent failed attempts:', error);

      return [];

    }

  }



  /**

   * Trigger security alert for suspicious activity

   */

  private async triggerSecurityAlert(alert: {

    severity: 'low' | 'medium' | 'high' | 'critical';

    event: string;

    userId: string;

    attemptCount?: number;

    timeWindow?: string;

  }): Promise<void> {

    try {

      this.logger.error(

        `🚨 SECURITY ALERT [${alert.severity.toUpperCase()}]: ${alert.event} ` +

        `for user ${alert.userId} (${alert.attemptCount || 'N/A'} attempts in ${alert.timeWindow || 'N/A'})`

      );



      // Log to reconciliation_alerts for admin visibility

      await this.supabase

        .from('reconciliation_alerts')

        .insert({

          user_id: alert.userId,

          alert_type: 'security_alert',

          alert_severity: alert.severity,

          alert_reason: `${alert.event}: ${alert.attemptCount || 'multiple'} attempts detected`,

          status: 'pending',

          local_amount: 0,

          local_currency: 'USD',

          metadata: {

            event: alert.event,

            attemptCount: alert.attemptCount,

            timeWindow: alert.timeWindow,

            timestamp: new Date().toISOString(),

          },

        });



      // TODO: Send notification to admin team (email, Slack, etc.)

      // For now, just log the alert

    } catch (error: any) {

      this.logger.error('Failed to trigger security alert:', error);

      // Don't throw - alerting failures shouldn't break the flow

    }

  }



  /**

   * Determines if an error is retryable (transient failure)

   * Retries are only attempted for network/timeout/database connection issues

   * Business logic errors (insufficient balance, invalid types) are not retried

   */

  private isRetryableError(error: any, errorMessage: string): boolean {

    if (!errorMessage) return false;



    const message = errorMessage.toLowerCase();

    const code = error?.code?.toLowerCase() || '';



    // Non-retryable: Business logic errors

    const nonRetryablePatterns = [

      'insufficient',

      'unknown transaction type',

      'validation',

      'invalid',

      'not found',

      'already exists',

      'duplicate',

      'unauthorized',

      'forbidden',

      'bad request',

    ];



    for (const pattern of nonRetryablePatterns) {

      if (message.includes(pattern)) {

        return false;

      }

    }



    // Retryable: Network/database/transient errors

    const retryablePatterns = [

      'timeout',

      'connection',

      'network',

      'econnreset',

      'etimedout',

      'enotfound',

      'econnrefused',

      'database',

      'pg_',

      'pgrst',

      'service unavailable',

      'internal server error',

      'temporary',

      'retry',

    ];



    // Check error codes

    const retryableCodes = [

      'pgrst100', // Connection error

      'pgrst101', // Timeout

      'pgrst102', // Service unavailable

      '08', // PostgreSQL connection exception class

      '53', // PostgreSQL insufficient resources

      '57', // PostgreSQL operator intervention

    ];



    for (const codePattern of retryableCodes) {

      if (code.includes(codePattern)) {

        return true;

      }

    }



    for (const pattern of retryablePatterns) {

      if (message.includes(pattern)) {

        return true;

      }

    }



    // Default: Don't retry unknown errors (safer to fail fast)

    return false;

  }



  async getWallet(userId: string): Promise<WalletResponseDto> {

    // ✅ TASK 3.2: Check cache first

    const cacheKey = `wallet:${userId}`;

    const cached = this.balanceCache.get(cacheKey);

    

    if (cached && Date.now() < cached.expiry) {

      this.logger.debug(`Cache hit for wallet ${userId}`);

      return cached.data;

    }



    // ✅ BUG FIX: Check if there's an in-flight request for this user

    // This prevents multiple concurrent requests from all hitting the database

    if (this.cacheLocks.has(cacheKey)) {

      this.logger.debug(`Waiting for in-flight wallet fetch for user ${userId}`);

      try {

        return await this.cacheLocks.get(cacheKey)!;

      } catch (error) {

        // If the in-flight request failed, we'll retry below

        this.logger.warn(`In-flight wallet fetch failed for user ${userId}, retrying...`);

      }

    }



    // Create a promise for this fetch operation

    const fetchPromise = this.fetchWalletFromDB(userId, cacheKey);

    this.cacheLocks.set(cacheKey, fetchPromise);



    try {

      const result = await fetchPromise;

      return result;

    } finally {

      // Always remove the lock when done (success or failure)

      this.cacheLocks.delete(cacheKey);

    }

  }



  /**

   * Internal method to fetch wallet from database and update cache

   * Separated to allow proper lock management

   */

  private async fetchWalletFromDB(userId: string, cacheKey: string): Promise<WalletResponseDto> {

        

    const { data, error } = await this.supabase

      .from('wallets')

      .select('*')

      .eq('user_id', userId)

      .single();



    

    if (error) {

      console.error('❌ Wallet query error:', error);

      if (error.code === 'PGRST116') {

        // Wallet not found - create one automatically

                return await this.createWalletForUser(userId);

      }

      throw new Error(`Database error: ${error.message}`);

    }



    // ✅ QUERY PENDING ESCROW BALANCES (vendor/rider earnings)

    const pendingEscrows = await this.getPendingEscrowBalances(userId);



    const walletDto = this.mapWalletToDto(data);

    

    // Add pending escrow data to response

    const walletResponse = {

      ...walletDto,

      pendingVendorEarnings: pendingEscrows.vendorAmount,

      pendingRiderEarnings: pendingEscrows.riderAmount,

      totalPendingEarnings: pendingEscrows.totalPending,

    };



    // ✅ TASK 3.2: Cache the result

    this.balanceCache.set(cacheKey, {

      data: walletResponse,

      expiry: Date.now() + this.BALANCE_CACHE_TTL,

    });



    return walletResponse;

  }



  /**

   * Invalidate wallet balance cache for a user

   * Called after any wallet transaction to ensure cache consistency

   * ✅ BUG FIX: Made public so reconciliation service can call it

   */

  invalidateWalletCache(userId: string): void {

    try {

      const cacheKey = `wallet:${userId}`;

      this.balanceCache.delete(cacheKey);

      this.logger.debug(`Cache invalidated for wallet ${userId}`);

    } catch (error: any) {

      // ✅ BUG FIX: Add error handling for cache operations

      this.logger.error(`Failed to invalidate cache for wallet ${userId}:`, error);

      // Don't throw - cache invalidation failure shouldn't break the flow

    }

  }



  /**

   * Clean up expired cache entries to prevent memory leaks

   * ✅ BUG FIX: Periodic cleanup prevents memory from growing unbounded

   */

  private cleanupExpiredCache(): void {

    try {

      const now = Date.now();

      let cleanedCount = 0;

      

      for (const [key, value] of this.balanceCache.entries()) {

        if (now >= value.expiry) {

          this.balanceCache.delete(key);

          cleanedCount++;

        }

      }



      if (cleanedCount > 0) {

        this.logger.debug(`Cleaned up ${cleanedCount} expired cache entries`);

      }

    } catch (error: any) {

      this.logger.error('Error cleaning up expired cache:', error);

    }

  }



  /**

   * Scheduled job: Clean up expired cache entries every 5 minutes

   * ✅ BUG FIX: Prevents memory leak from expired cache entries

   */

  @Cron('*/5 * * * *', {

    name: 'wallet-cache-cleanup',

  })

  private scheduledCacheCleanup(): void {

    this.cleanupExpiredCache();

  }



  private async createWalletForUser(userId: string): Promise<WalletResponseDto> {

    const newWallet = {

      id: randomUUID(),

      user_id: userId,

      available_balance: 0.0,

      escrow_balance: 0.0,

      pending_withdrawal: 0.0,

      preferred_currency: 'USD',

      kyc_status: 'pending',

      daily_deposit_limit: 1000.0,

      daily_withdrawal_limit: 500.0,

      created_at: new Date().toISOString(),

      updated_at: new Date().toISOString()

    };



    

    const { data, error } = await this.supabase

      .from('wallets')

      .insert(newWallet)

      .select()

      .single();



    if (error) {

      console.error('❌ Failed to create wallet:', error);

      throw new Error(`Failed to create wallet: ${error.message}`);

    }



        return this.mapWalletToDto(data);

  }



  async getWalletStats(userId: string): Promise<WalletStatsDto> {

        

    // Get wallet and trust scores in parallel

    const [wallet, trustScore] = await Promise.all([

      this.getWallet(userId),

      this.getTrustScore(userId)

    ]);

    

    // Get transaction counts and amounts (last 30 days)

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    

    const [

      { count: recentTransactionCount },

      { data: spendingData },

      { data: depositData },

      { count: activeRiskFlags }

    ] = await Promise.all([

      // Recent transaction count

      this.supabase

        .from('wallet_ledger')

        .select('*', { count: 'exact', head: true })

        .eq('user_id', userId)

        .gte('created_at', thirtyDaysAgo),

      

      // Monthly spending

      this.supabase

        .from('wallet_ledger')

        .select('available_delta')

        .eq('user_id', userId)

        .in('transaction_type', ['purchase_hold', 'fee_deduction'])

        .gte('created_at', thirtyDaysAgo),

      

      // Monthly deposits

      this.supabase

        .from('wallet_ledger')

        .select('available_delta')

        .eq('user_id', userId)

        .eq('transaction_type', 'deposit_mint')

        .gte('created_at', thirtyDaysAgo),

        

      // Active risk flags count

      this.supabase

        .from('risk_flags')

        .select('*', { count: 'exact', head: true })

        .eq('user_id', userId)

        .eq('is_active', true)

    ]);



    const monthlySpending = Math.abs(spendingData?.reduce((sum, tx) => sum + Math.abs(tx.available_delta), 0) || 0);

    const monthlyDeposits = depositData?.reduce((sum, tx) => sum + tx.available_delta, 0) || 0;

    const totalBalance = wallet.availableBalance + wallet.escrowBalance;



    return {

      totalBalance,

      availableBalance: wallet.availableBalance,

      escrowBalance: wallet.escrowBalance,

      pendingWithdrawal: wallet.pendingWithdrawal,

      localCurrencyEquivalent: {

        currency: wallet.preferredCurrency,

        available: wallet.availableBalance * this.FRETI_USD_RATE,

        total: totalBalance * this.FRETI_USD_RATE,

        escrow: wallet.escrowBalance * this.FRETI_USD_RATE,

        pending: wallet.pendingWithdrawal * this.FRETI_USD_RATE,

      },

      recentTransactionCount: recentTransactionCount || 0,

      monthlySpending,

      monthlyDeposits,

      // Enhanced stats from the view equivalent

      vendorTrustScore: trustScore.vendorTrustScore || 0,

      riderTrustScore: trustScore.riderTrustScore || 0,

      buyerTrustScore: trustScore.buyerTrustScore || 0,

      activeRiskFlags: activeRiskFlags || 0,

    };

  }



  // ================================

  // DEPOSIT OPERATIONS

  // ================================



  async createDepositRequest(userId: string, dto: DepositRequestDto): Promise<DepositResponseDto> {

    // Validate that at least one amount is provided

    if (!dto.localAmount && !dto.fretiAmount) {

      throw new BadRequestException('Either localAmount or fretiAmount must be provided');

    }



    // Get user email for Flutterwave

    // Try to get email from user_profiles first, then fallback to auth.users

    let userEmail: string | null = null;

    let userName: string | null = null;



    // First, try user_profiles table

    const { data: userProfile } = await this.supabase

      .from('user_profiles')

      .select('email, first_name, last_name, username')

      .eq('id', userId)

      .single();



    if (userProfile?.email) {

      userEmail = userProfile.email;

      userName = `${userProfile.first_name || ''} ${userProfile.last_name || ''}`.trim() || userProfile.username || userEmail;

    } else {

      // Fallback: Get email from auth.users using admin API

      try {

        const { data: authUser, error: authError } = await this.supabase.auth.admin.getUserById(userId);

        if (authUser?.user?.email) {

          userEmail = authUser.user.email;

          userName = authUser.user.email;

        }

      } catch (error) {

        this.logger.warn('Could not fetch user email from auth.users:', error);

      }

    }



    if (!userEmail) {

      throw new BadRequestException('User email not found. Please ensure your account has a verified email address.');

    }



    // Calculate local amount and currency

    // User provides either localAmount (in their currency) or fretiAmount (in FRETI/USD)

    const localCurrency = dto.localCurrency || 'USD';

    let localAmount: number;

    let estimatedFretiAmount: number;

    let estimatedExchangeRate: number = this.FRETI_USD_RATE; // Default: 1 USD = 1 FRETI



    if (dto.localAmount) {

      // User provided local currency amount

      localAmount = dto.localAmount;

      

      // If user also provided fretiAmount, use it; otherwise estimate

      if (dto.fretiAmount) {

        estimatedFretiAmount = dto.fretiAmount;

        estimatedExchangeRate = localAmount / estimatedFretiAmount; // Calculate rate from user's estimate

      } else if (localCurrency === 'USD') {

        estimatedFretiAmount = localAmount;

        estimatedExchangeRate = 1.0;

      } else {

        // Fetch real-time exchange rate from Flutterwave

        try {

          this.logger.log(`💱 Fetching real-time exchange rate from Flutterwave: ${localAmount} ${localCurrency} → USD`);

          const rateInfo = await this.flutterwaveService.getExchangeRate(localCurrency, 'USD', localAmount);

          

          // Use destination.amount directly (this is the actual USD amount Flutterwave calculated)

          estimatedFretiAmount = rateInfo.destination.amount; // USD amount = FRETI amount

          // Calculate the rate from the actual conversion

          estimatedExchangeRate = localAmount / estimatedFretiAmount;

          

          this.logger.log(`✅ Fetched live exchange rate for deposit: ${localAmount} ${localCurrency} → ${estimatedFretiAmount.toFixed(2)} USD/FRETI (Rate: ${estimatedExchangeRate.toFixed(4)} ${localCurrency}/USD)`);

        } catch (rateError: any) {

          this.logger.error(`❌ Could not fetch live exchange rate for ${localCurrency}:`, {

            error: rateError.message,

            localAmount,

            localCurrency,

            stack: rateError.stack,

          });

          // If exchange rate API fails, we cannot proceed with deposit

          // The error message from getExchangeRate is user-friendly

          throw rateError;

        }

      }

    } else if (dto.fretiAmount) {

      // User provided FRETI amount

      estimatedFretiAmount = dto.fretiAmount;

      localAmount = estimatedFretiAmount * this.FRETI_USD_RATE; // 1 FRETI = 1 USD

      estimatedExchangeRate = 1.0;

    } else {

      throw new BadRequestException('Either localAmount or fretiAmount must be provided');

    }



    // Validate daily limits (using estimated FRETI amount)

    await this.validateDailyDepositLimit(userId, estimatedFretiAmount);

    

    const depositId = randomUUID();

    const idempotencyKey = dto.idempotencyKey || `deposit_${userId}_${Date.now()}`;



    // Create deposit record

    // NOTE: exchange_rate stored here is an estimate. The webhook will verify with Flutterwave

    // and update with the exact rate used for the conversion.

    const { data: depositData, error } = await this.supabase

      .from('deposits')

      .insert({

        id: depositId,

        user_id: userId,

        freti_amount: estimatedFretiAmount, // Estimated, will be updated from webhook with exact amount

        local_amount: localAmount,

        local_currency: localCurrency,

        exchange_rate: estimatedExchangeRate, // Estimated, will be updated from webhook with exact rate

        status: 'pending',

        metadata: {

          idempotency_key: idempotencyKey,

          created_from: 'app'

        }

      })

      .select()

      .single();



    if (error) {

      if (error.code === '23505') { // Unique constraint violation

        throw new ConflictException('Duplicate deposit request');

      }

      throw new Error(`Failed to create deposit: ${error.message}`);

    }



    // Initialize Flutterwave payment

    try {

      const paymentResponse = await this.flutterwaveService.initializePayment({

        amount: localAmount,

        currency: localCurrency,

        customerEmail: userEmail,

        customerName: userName || userEmail,

        txRef: depositId,

        redirectUrl: `fretiko://wallet/deposit/callback?deposit_id=${depositId}`,

        meta: {

          deposit_id: depositId,

          user_id: userId,

          idempotency_key: idempotencyKey,

        },

      });



      // Update deposit with payment link

      const { data: updatedDeposit } = await this.supabase

        .from('deposits')

        .update({

          metadata: {

            ...depositData.metadata,

            payment_link: paymentResponse.data.link,

            tx_ref: paymentResponse.data.tx_ref,

          }

        })

        .eq('id', depositId)

        .select()

        .single();



      

      // Return deposit with payment link

      const depositDto = this.mapDepositToDto(updatedDeposit || depositData);

      return {

        ...depositDto,

        paymentLink: paymentResponse.data.link,

      };

    } catch (error: any) {

            // Update deposit status to failed

      await this.supabase

        .from('deposits')

        .update({

          status: 'failed',

          failure_reason: error.message || 'Failed to initialize payment',

        })

        .eq('id', depositId);

      

      throw new BadRequestException(`Failed to initialize payment: ${error.message}`);

    }

  }



  async getDepositHistory(userId: string, params?: {

    status?: string;

    limit?: number;

    offset?: number;

  }): Promise<DepositResponseDto[]> {

    let query = this.supabase

      .from('deposits')

      .select('*')

      .eq('user_id', userId)

      .order('created_at', { ascending: false });



    // Apply filters

    if (params?.status) {

      query = query.eq('status', params.status);

    }



    // Apply pagination

    const limit = params?.limit || 20;

    const offset = params?.offset || 0;

    query = query.range(offset, offset + limit - 1);



    const { data, error } = await query;



    if (error) {

      throw new Error(`Failed to fetch deposit history: ${error.message}`);

    }



    return (data || []).map(d => this.mapDepositToDto(d));

  }



  // ================================

  // WITHDRAWAL OPERATIONS

  // ================================



  async createWithdrawRequest(userId: string, dto: WithdrawRequestDto): Promise<PayoutRequestResponseDto> {

    const payoutId = randomUUID();

    const idempotencyKey = dto.idempotencyKey || `withdraw_${userId}_${Date.now()}`;



    // CRITICAL: Check idempotency FIRST before any balance operations

    // This prevents unnecessary balance checks and potential race conditions

    const { data: existingLedger } = await this.supabase

      .from('wallet_ledger')

      .select('id, reference_id')

      .eq('idempotency_key', `${idempotencyKey}_hold`)

      .single();



    if (existingLedger) {

      // Idempotent request - fetch existing payout

      this.logger.log(`Idempotent withdrawal request detected: ${idempotencyKey}`);

      const { data: existingPayout } = await this.supabase

        .from('payout_requests')

        .select('*')

        .eq('id', existingLedger.reference_id)

        .single();



      if (existingPayout) {

        return this.mapPayoutToDto(existingPayout);

      }

    }



    // Validate daily limits atomically (using database function)

    const { data: limitValidation, error: limitError } = await this.supabase.rpc('validate_daily_limit', {

      p_user_id: userId,

      p_amount: dto.fretiAmount,

      p_limit_type: 'withdrawal',

      p_transaction_type: WalletTransactionType.WITHDRAWAL_BURN

    });



    if (limitError) {

      this.logger.error('Daily limit validation error:', limitError);

      throw new Error(`Failed to validate daily withdrawal limit: ${limitError.message}`);

    }



    if (!limitValidation || limitValidation.length === 0 || !limitValidation[0].is_valid) {

      const errorMsg = limitValidation?.[0]?.error_message || 'Daily withdrawal limit exceeded';

      throw new BadRequestException(errorMsg);

    }



    // Get bank account details first (no need to lock for this)

    const bankAccount = await this.bankAccountService.getBankAccount(userId, dto.bankAccountId);

    if (!bankAccount.isActive) {

      throw new BadRequestException('Bank account is not active');

    }

    if (!bankAccount.isVerified) {

      throw new BadRequestException(

        'Bank account must be verified before withdrawal. Please verify your bank account first or create a new one.'

      );

    }

    if (!bankAccount.bankCode) {

      throw new BadRequestException('Bank code is required for withdrawal');

    }



    const localCurrency = bankAccount.currency; // Use bank account's currency

    

    // Validate withdrawal amount and currency

    this.withdrawalValidation.validateMinimumAmount(dto.fretiAmount, 'USD'); // Validate minimum in USD/FRETI

    this.withdrawalValidation.validateCurrencyDecimals(dto.fretiAmount, localCurrency);

    

    // Validate bank account details

    this.withdrawalValidation.validateAccountNumber(bankAccount.accountNumber, bankAccount.country);

    this.withdrawalValidation.validateBankCode(bankAccount.bankCode, bankAccount.country);

    this.withdrawalValidation.validateBeneficiaryName(bankAccount.accountName);



    // Validate that currency conversion is supported

    // Check if this is a supported currency for withdrawals

    const supportedCurrencies = ['USD', 'NGN', 'EUR', 'GBP', 'CAD', 'AUD', 'GHS', 'KES', 'ZAR', 'UGX', 'TZS', 'RWF', 'XAF', 'XOF'];

    if (!supportedCurrencies.includes(localCurrency.toUpperCase())) {

      this.logger.warn(`⚠️ Withdrawal requested for potentially unsupported currency: ${localCurrency}`);

      // Still proceed, but log a warning - Flutterwave will reject if truly unsupported

    }



    // Fetch real-time exchange rate estimate: USD → localCurrency

    // This gives users an accurate estimate before withdrawal

    let estimatedLocalAmount: number;

    let estimatedExchangeRate: number = this.FRETI_USD_RATE; // Default: 1:1 if same currency



    if (localCurrency !== 'USD') {

      try {

        this.logger.log(`💱 Fetching real-time exchange rate for withdrawal: ${dto.fretiAmount} USD → ${localCurrency}`);

        const rateInfo = await this.flutterwaveService.getExchangeRate('USD', localCurrency, dto.fretiAmount);

        

        // Use destination.amount directly (this is the actual local currency amount Flutterwave calculated)

        estimatedLocalAmount = rateInfo.destination.amount;

        // Calculate the rate from the actual conversion

        estimatedExchangeRate = estimatedLocalAmount / dto.fretiAmount;

        

        this.logger.log(`✅ Fetched live exchange rate for withdrawal: ${dto.fretiAmount} USD → ${estimatedLocalAmount.toFixed(2)} ${localCurrency} (Rate: ${estimatedExchangeRate.toFixed(4)} ${localCurrency}/USD)`);

      } catch (rateError: any) {

        this.logger.error(`❌ Could not fetch live exchange rate for withdrawal ${localCurrency}:`, {

          error: rateError.message,

          fretiAmount: dto.fretiAmount,

          localCurrency,

          stack: rateError.stack,

        });

        // Don't silently fallback - inform user that rate service is unavailable

        throw new BadRequestException(

          `Unable to fetch exchange rate for ${localCurrency}. The exchange rate service is temporarily unavailable. Please try again in a few moments.`

        );

      }

    } else {

      // Same currency (USD → USD), no conversion needed

      estimatedLocalAmount = dto.fretiAmount;

      estimatedExchangeRate = 1.0;

    }



    // Get wallet ID (needed for ledger entry reference, but locking happens in RPC)

    // Note: Balance validation happens atomically in createLedgerEntry via atomic_wallet_operation

    const userWallet = await this.getWallet(userId);

    

    // ✅ BUG FIX: Removed redundant balance check - atomic_wallet_operation validates atomically

    // This prevents race conditions where balance could change between check and operation



    // Move funds from available to pending withdrawal (atomic operation with locking)

    // Note: createLedgerEntry now uses atomic_wallet_operation which handles locking and idempotency

    await this.createLedgerEntry({

      walletId: userWallet.id,

      transactionType: 'withdrawal_burn',

      availableDelta: -dto.fretiAmount,

      escrowDelta: 0,

      pendingWithdrawalDelta: dto.fretiAmount,

      referenceType: 'payout_request',

      referenceId: payoutId,

      idempotencyKey: `${idempotencyKey}_hold`,

      description: 'Withdrawal request - funds held pending'

    }, userId);



    // Create payout request

    const { data: payoutData, error } = await this.supabase

      .from('payout_requests')

      .insert({

        id: payoutId,

        user_id: userId,

        freti_amount: dto.fretiAmount,

        estimated_local_amount: estimatedLocalAmount, // Real-time estimate, will be confirmed by webhook

        local_currency: localCurrency,

        status: 'requested',

        metadata: {

          idempotency_key: idempotencyKey,

          created_from: 'app',

          bank_account_id: dto.bankAccountId,

          estimated_exchange_rate: estimatedExchangeRate,

          exchange_rate_fetched_at: new Date().toISOString(),

        }

      })

      .select()

      .single();



    if (error) {

      throw new Error(`Failed to create payout request: ${error.message}`);

    }



    // Initiate Flutterwave transfer

    try {

      // Initiate transfer with explicit currency conversion

      // Flutterwave will convert USD (FRETI) to the destination currency (bank account currency)

      const transferResponse = await this.flutterwaveService.initiateTransfer({

        accountBank: bankAccount.bankCode,

        accountNumber: bankAccount.accountNumber,

        amount: dto.fretiAmount, // USD amount (FRETI = USD)

        currency: 'USD', // Source currency is always USD for FRETI

        destinationCurrency: localCurrency, // Bank account's currency - Flutterwave will convert

        beneficiaryName: bankAccount.accountName,

        narration: (() => {

          const baseNarration = `Withdrawal from Fretiko wallet - ${dto.fretiAmount} FRETI (${estimatedLocalAmount.toFixed(2)} ${localCurrency})`;

          // Validate narration length before sending

          try {

            this.withdrawalValidation.validateNarration(baseNarration);

            return baseNarration;

          } catch (error: any) {

            // Truncate if too long

            const maxLen = 150;

            return baseNarration.length > maxLen 

              ? baseNarration.substring(0, maxLen - 3) + '...'

              : baseNarration;

          }

        })(),

        reference: payoutId,

        callbackUrl: (() => {

          // Get callback URL and validate it's publicly accessible

          const apiUrl = this.configService.get<string>('API_URL');

          const callbackUrl = `${apiUrl}/wallet/webhooks/flutterwave`;

          

          // Validate callback URL (will throw if localhost/private IP)

          try {

            this.withdrawalValidation.validateCallbackUrl(callbackUrl);

          } catch (error: any) {

            this.logger.error(`❌ Invalid callback URL: ${error.message}`);

            // In development, allow it but log warning

            if (process.env.NODE_ENV !== 'production') {

              this.logger.warn('⚠️ Allowing localhost callback URL in development mode. Webhooks will not work.');

            } else {

              throw new BadRequestException(

                `Invalid API_URL configuration: ${error.message}. Please set API_URL to a publicly accessible HTTPS URL.`

              );

            }

          }

          

          return callbackUrl;

        })(),

      });



      // Update payout request with Flutterwave transfer ID

      await this.supabase

        .from('payout_requests')

        .update({

          external_payout_id: transferResponse.data.id.toString(),

          status: transferResponse.data.status === 'NEW' ? 'processing' : 'pending',

          metadata: {

            ...payoutData.metadata,

            transfer_id: transferResponse.data.id,

            transfer_reference: transferResponse.data.reference,

          }

        })

        .eq('id', payoutId);



            

      // Get processing time estimate

      // Note: BankAccount interface may not have country field yet, so we pass undefined

      // ProcessingTimeService will use currency-based defaults

      const processingTime = this.processingTimeService.getProcessingTime(

        localCurrency,

        undefined // bankAccount.country - can be added later if needed

      );



      const mappedPayout = this.mapPayoutToDto({

        ...payoutData,

        external_payout_id: transferResponse.data.id.toString(),

        status: transferResponse.data.status === 'NEW' ? 'processing' : 'pending',

      });



      // Add processing time to response (extend the DTO)

      return {

        ...mappedPayout,

        processingTime: {

          minDays: processingTime.minDays,

          maxDays: processingTime.maxDays,

          displayText: processingTime.displayText,

        },

      } as any; // Type assertion since DTO doesn't include this yet

    } catch (error: any) {

      console.error('❌ Failed to initiate Flutterwave transfer:', error);

      this.logger.error('Withdrawal transfer initiation failed:', {

        payoutId,

        userId,

        error: error.message,

        stack: error.stack,

      });

      

      try {

        // Refund funds from pending_withdrawal back to available_balance (atomic operation)

        // This uses atomic_wallet_operation which handles locking and idempotency

        // Get wallet for refund (no need to lock as RPC handles it)

        const walletForRefund = await this.getWallet(userId);

        

        // Check if refund already exists (idempotency check)

        // Use different reference_type to avoid unique constraint violation

        // The unique constraint is on (user_id, transaction_type, reference_type, reference_id)

        // So we use 'payout_request_refund' as reference_type instead of 'payout_request'

        const { data: existingRefund } = await this.supabase

          .from('wallet_ledger')

          .select('id')

          .eq('user_id', userId)

          .eq('transaction_type', 'withdrawal_burn')

          .eq('reference_type', 'payout_request_refund')

          .eq('reference_id', payoutId)

          .single();

        

        if (!existingRefund) {

          // Use different reference_type ('payout_request_refund') to avoid unique constraint violation

          // The initial withdrawal uses 'payout_request', refund uses 'payout_request_refund'

          // This allows us to use the same payoutId as reference_id (which is a UUID)

          await this.createLedgerEntry({

            walletId: walletForRefund.id,

            transactionType: 'withdrawal_burn',

            availableDelta: dto.fretiAmount, // Refund

            escrowDelta: 0,

            pendingWithdrawalDelta: -dto.fretiAmount, // Remove from pending

            referenceType: 'payout_request_refund', // Different reference_type to avoid constraint violation

            referenceId: payoutId, // Same payoutId (valid UUID)

            idempotencyKey: `${idempotencyKey}_refund`,

            description: 'Withdrawal failed - funds refunded to available balance'

          }, userId);

          this.logger.log(`✅ Funds refunded for failed withdrawal: ${payoutId}`);

        } else {

          this.logger.log(`Refund already processed for withdrawal ${payoutId} (idempotent)`);

        }



        // Update payout status to failed (idempotent - safe to call multiple times)

        await this.supabase

          .from('payout_requests')

          .update({

            status: 'failed',

            failure_reason: error.message || 'Failed to initiate transfer',

            metadata: {

              ...payoutData.metadata,

              error_details: error.message,

              refunded_at: new Date().toISOString(),

            }

          })

          .eq('id', payoutId);



        // Send notification about failure

        await this.notificationHelper.notifySystemUpdate(

          userId,

          'Withdrawal Failed',

          `Your withdrawal of ₣${dto.fretiAmount} FRETI could not be processed. Funds have been refunded to your available balance. Error: ${error.message?.includes('URL') || error.message?.includes('parse') ? 'Payment gateway configuration issue' : error.message || 'Unknown error'}`,

          { payoutId, amount: dto.fretiAmount, type: 'wallet_withdrawal_failed' }

        );

      } catch (refundError: any) {

        // Check if this is an idempotency error (refund already processed)

        const isIdempotencyError = refundError.message?.includes('idempotency') || 

                                   refundError.message?.includes('duplicate key') ||

                                   refundError.message?.includes('already exists');

        

        if (isIdempotencyError) {

          // Refund was already processed - this is OK, just log and continue

          this.logger.log(`Refund already processed for withdrawal ${payoutId} (idempotent operation detected)`);

          

          // Update payout status to failed (if not already updated)

          await this.supabase

            .from('payout_requests')

            .update({

              status: 'failed',

              failure_reason: error.message || 'Failed to initiate transfer',

              metadata: {

                ...payoutData.metadata,

                error_details: error.message,

                refunded_at: new Date().toISOString(),

                refund_idempotent: true,

              }

            })

            .eq('id', payoutId);



          // Send notification about failure (funds already refunded)

          await this.notificationHelper.notifySystemUpdate(

            userId,

            'Withdrawal Failed',

            `Your withdrawal of ₣${dto.fretiAmount} FRETI could not be processed. Funds have been refunded to your available balance. Error: ${error.message?.includes('URL') || error.message?.includes('parse') ? 'Payment gateway configuration issue' : error.message || 'Unknown error'}`,

            { payoutId, amount: dto.fretiAmount, type: 'wallet_withdrawal_failed' }

          );



          // Provide user-friendly error message

          const errorMessage = error.message?.includes('URL') || error.message?.includes('parse')

            ? 'Payment gateway configuration error. Please contact support or check your Flutterwave API keys in the .env file.'

            : error.message || 'Failed to initiate withdrawal';

          

          throw new BadRequestException(errorMessage);

        }

        

        // CRITICAL: If refund fails for other reasons, funds are stuck in pending_withdrawal

        this.logger.error(`❌ CRITICAL: Failed to refund withdrawal ${payoutId}. Funds may be stuck in pending_withdrawal!`, {

          payoutId,

          userId,

          amount: dto.fretiAmount,

          refundError: refundError.message,

          refundErrorStack: refundError.stack,

          originalError: error.message,

        });

        

        // Still try to update payout status, but mark as failed with critical error

        try {

          await this.supabase

            .from('payout_requests')

            .update({

              status: 'failed',

              failure_reason: `Transfer initiation failed AND refund failed: ${error.message || 'Unknown error'}. Refund error: ${refundError.message}`,

              metadata: {

                ...payoutData.metadata,

                error_details: error.message,

                refund_failed: true,

                refund_error: refundError.message,

                refund_attempted_at: new Date().toISOString(),

                critical: true, // Flag for manual intervention

              }

            })

            .eq('id', payoutId);



          // Send critical notification

          await this.notificationHelper.notifySystemUpdate(

            userId,

            'Withdrawal Failed - Manual Review Required',

            `Your withdrawal of ₣${dto.fretiAmount} FRETI could not be processed. There was an issue refunding the funds. Please contact support immediately.`,

            { payoutId, amount: dto.fretiAmount, type: 'wallet_withdrawal_failed_critical', requiresSupport: true }

          );

        } catch (updateError: any) {

          this.logger.error(`❌ Failed to update payout status after refund failure: ${updateError.message}`);

        }



        // Re-throw to surface the critical error

        throw new Error(`CRITICAL: Withdrawal ${payoutId} failed and refund also failed. Funds may be stuck in pending_withdrawal. Please investigate.`);

      }



      // Provide user-friendly error message

      const errorMessage = error.message?.includes('URL') || error.message?.includes('parse')

        ? 'Payment gateway configuration error. Please contact support or check your Flutterwave API keys in the .env file.'

        : error.message || 'Failed to initiate withdrawal';

      

      throw new BadRequestException(errorMessage);

    }

  }



  async getPayoutHistory(userId: string, params?: {

    status?: string;

    limit?: number;

    offset?: number;

  }): Promise<PayoutRequestResponseDto[]> {

    let query = this.supabase

      .from('payout_requests')

      .select('*')

      .eq('user_id', userId)

      .order('requested_at', { ascending: false });



    // Apply filters

    if (params?.status) {

      query = query.eq('status', params.status);

    }



    // Apply pagination

    const limit = params?.limit || 20;

    const offset = params?.offset || 0;

    query = query.range(offset, offset + limit - 1);



    const { data, error } = await query;



    if (error) {

      throw new Error(`Failed to fetch payout history: ${error.message}`);

    }



    return (data || []).map(p => this.mapPayoutToDto(p));

  }



  // ================================

  // TRANSACTION HISTORY (removed - see new implementation below in sales section)

  // ================================



  // ================================

  // ESCROW OPERATIONS

  // ================================



  async checkEscrowBypass(buyerId: string, dto: EscrowBypassCheckDto): Promise<EscrowBypassResponseDto> {

    // Get trust scores

    const [buyerTrust, vendorTrust, riderTrust] = await Promise.all([

      this.getTrustScore(buyerId),

      this.getTrustScore(dto.vendorId),

      dto.riderId ? this.getTrustScore(dto.riderId) : null

    ]);



    // Check risk flags

    const riskFlags = await this.getActiveRiskFlags(buyerId);



    // Evaluate bypass eligibility

    const vendorTrusted = vendorTrust.vendorTrustScore >= this.MIN_TRUST_SCORE;

    const riderTrusted = !dto.riderId || (riderTrust !== null && riderTrust.riderTrustScore >= this.MIN_TRUST_SCORE);

    const buyerEligible = buyerTrust.buyerTrustScore >= 500 && riskFlags.length === 0;

    const categoryAllowed = !dto.category || !this.HIGH_RISK_CATEGORIES.includes(dto.category.toLowerCase());

    

    const canBypass = vendorTrusted && riderTrusted && buyerEligible && categoryAllowed;

    

    let reason = '';

    if (!vendorTrusted) reason += 'Vendor trust score too low. ';

    if (!riderTrusted) reason += 'Rider trust score too low. ';

    if (!buyerEligible) reason += 'Buyer not eligible or has active risk flags. ';

    if (!categoryAllowed) reason += 'High-risk category requires escrow. ';

    if (canBypass) reason = 'All requirements met for escrow bypass.';



    return {

      canBypass,

      reason: reason.trim(),

      vendorTrusted,

      riderTrusted,

      buyerEligible,

      riskFlags: riskFlags.map(flag => flag.flagType)

    };

  }



  async getRemainingDailyLimits(userId: string): Promise<{

    dailyDepositLimit: number;

    dailyWithdrawalLimit: number;

    remainingDepositLimit: number;

    remainingWithdrawalLimit: number;

    kycStatus: string;

  }> {

    const wallet = await this.getWallet(userId);

    const today = new Date().toISOString().split('T')[0];



    // Calculate deposits made today

    const { data: depositsToday } = await this.supabase

      .from('deposits')

      .select('freti_amount')

      .eq('user_id', userId)

      .gte('created_at', `${today}T00:00:00Z`)

      .lt('created_at', `${today}T23:59:59Z`);



    const dailyDepositUsed = depositsToday?.reduce((sum, d) => sum + parseFloat(d.freti_amount), 0) || 0;



    // Calculate withdrawals made today

    const { data: withdrawalsToday } = await this.supabase

      .from('payout_requests')

      .select('freti_amount')

      .eq('user_id', userId)

      .gte('requested_at', `${today}T00:00:00Z`)

      .lt('requested_at', `${today}T23:59:59Z`);



    const dailyWithdrawalUsed = withdrawalsToday?.reduce((sum, w) => sum + parseFloat(w.freti_amount), 0) || 0;



    const remainingDepositLimit = Math.max(0, wallet.dailyDepositLimit - dailyDepositUsed);

    const remainingWithdrawalLimit = Math.max(0, wallet.dailyWithdrawalLimit - dailyWithdrawalUsed);



    return {

      dailyDepositLimit: wallet.dailyDepositLimit,

      dailyWithdrawalLimit: wallet.dailyWithdrawalLimit,

      remainingDepositLimit,

      remainingWithdrawalLimit,

      kycStatus: wallet.kycStatus,

    };

  }



  // ================================

  // PRIVATE HELPER METHODS

  // ================================



  /**

   * Create ledger entry (public for admin operations)

   * Now uses atomic database function for concurrency safety

   */

  async createLedgerEntry(entry: LedgerEntryDto, userId: string): Promise<void> {

    // Use atomic wallet operation RPC function for concurrency safety

    // This function handles idempotency checking, row-level locking, and balance validation

    const { data, error } = await this.supabase.rpc('atomic_wallet_operation', {

      p_user_id: userId,

      p_available_delta: entry.availableDelta,

      p_escrow_delta: entry.escrowDelta || 0,

      p_pending_withdrawal_delta: entry.pendingWithdrawalDelta || 0,

      p_transaction_type: entry.transactionType,

      p_reference_type: entry.referenceType,

      p_reference_id: entry.referenceId,

      p_idempotency_key: entry.idempotencyKey,

      p_description: entry.description,

      p_metadata: entry.metadata || {},

      p_created_by: userId

    });



    if (error) {

      this.logger.error('Atomic wallet operation failed:', error);

      throw new Error(`Failed to create ledger entry: ${error.message}`);

    }



    if (!data || data.length === 0) {

      throw new Error('No data returned from atomic wallet operation');

    }



    const result = data[0];



    if (!result.success) {

      // Handle idempotency - if duplicate, that's OK, just return

      if (result.error_message?.includes('idempotency') || result.error_message?.includes('Duplicate')) {

        this.logger.log(`Idempotent transaction detected: ${entry.idempotencyKey}`);

        return; // Idempotent operation - already processed

      }



      // Handle insufficient balance

      if (result.error_message?.includes('Insufficient balance')) {

        throw new BadRequestException(result.error_message);

      }



      throw new Error(result.error_message || 'Atomic wallet operation failed');

    }



    // Success - balances updated atomically via trigger

    this.logger.log(`Ledger entry created atomically: ${result.ledger_entry_id}`);

    

    // ✅ BUG FIX: Invalidate cache after ledger entry creation (for deposits/withdrawals)

    this.invalidateWalletCache(userId);

  }



  private async validateDailyDepositLimit(userId: string, amount: number): Promise<void> {

    // Use atomic database function for limit validation

    const { data: limitValidation, error: limitError } = await this.supabase.rpc('validate_daily_limit', {

      p_user_id: userId,

      p_amount: amount,

      p_limit_type: 'deposit',

      p_transaction_type: WalletTransactionType.DEPOSIT_MINT

    });



    if (limitError) {

      this.logger.error('Daily limit validation error:', limitError);

      throw new Error(`Failed to validate daily deposit limit: ${limitError.message}`);

    }



    if (!limitValidation || limitValidation.length === 0 || !limitValidation[0].is_valid) {

      const errorMsg = limitValidation?.[0]?.error_message || 'Daily deposit limit exceeded';

      throw new BadRequestException(errorMsg);

    }

  }



  private async validateDailyWithdrawalLimit(userId: string, amount: number): Promise<void> {

    // Use atomic database function for limit validation

    const { data: limitValidation, error: limitError } = await this.supabase.rpc('validate_daily_limit', {

      p_user_id: userId,

      p_amount: amount,

      p_limit_type: 'withdrawal',

      p_transaction_type: WalletTransactionType.WITHDRAWAL_BURN

    });



    if (limitError) {

      this.logger.error('Daily limit validation error:', limitError);

      throw new Error(`Failed to validate daily withdrawal limit: ${limitError.message}`);

    }



    if (!limitValidation || limitValidation.length === 0 || !limitValidation[0].is_valid) {

      const errorMsg = limitValidation?.[0]?.error_message || 'Daily withdrawal limit exceeded';

      throw new BadRequestException(errorMsg);

    }

  }



  private async getTrustScore(userId: string): Promise<TrustScore> {

    const { data, error } = await this.supabase

      .from('trust_scores')

      .select('*')

      .eq('user_id', userId)

      .single();



    if (error) {

      // Return default trust score if not found

      return {

        id: '',

        userId,

        vendorTrustScore: 0,

        riderTrustScore: 0,

        buyerTrustScore: 0,

        completedOrders: 0,

        successfulDeliveries: 0,

        disputeCount: 0,

        refundRate: 0,

        kycVerified: false,

        phoneVerified: false,

        emailVerified: false,

        lastCalculatedAt: new Date().toISOString(),

        createdAt: new Date().toISOString(),

        updatedAt: new Date().toISOString()

      };

    }



    return data;

  }



  private async getActiveRiskFlags(userId: string): Promise<RiskFlag[]> {

    const { data, error } = await this.supabase

      .from('risk_flags')

      .select('*')

      .eq('user_id', userId)

      .eq('is_active', true);



    if (error) {

      throw new Error(`Failed to fetch risk flags: ${error.message}`);

    }



    return data || [];

  }



  // ================================

  // ESCROW BALANCE QUERY

  // ================================



  /**

   * Get pending escrow balances for a user (as vendor or rider)

   * These amounts are "locked" until escrow is released

   */

  async getPendingEscrowBalances(userId: string): Promise<{

    vendorAmount: number;

    riderAmount: number;

    totalPending: number;

  }> {

    try {

      // Use JOIN to get vendor earnings from escrows

      const { data: vendorEscrows, error: vendorError } = await this.supabase

        .from('escrows')

        .select('vendor_amount, orders!inner(vendor_id)')

        .eq('status', 'held')

        .eq('orders.vendor_id', userId);



      if (vendorError) {

              }



      // Use JOIN to get rider earnings from escrows

      const { data: riderEscrows, error: riderError } = await this.supabase

        .from('escrows')

        .select('rider_amount, orders!inner(rider_id)')

        .eq('status', 'held')

        .eq('orders.rider_id', userId);



      if (riderError) {

              }



      const vendorAmount = vendorEscrows?.reduce((sum, e) => sum + parseFloat(e.vendor_amount || '0'), 0) || 0;

      const riderAmount = riderEscrows?.reduce((sum, e) => sum + parseFloat(e.rider_amount || '0'), 0) || 0;



      

      return {

        vendorAmount,

        riderAmount,

        totalPending: vendorAmount + riderAmount,

      };

    } catch (error) {

            return {

        vendorAmount: 0,

        riderAmount: 0,

        totalPending: 0,

      };

    }

  }



  // ================================

  // MAPPING FUNCTIONS

  // ================================



  private mapWalletToDto(data: any): WalletResponseDto {

    return {

      id: data.id,

      userId: data.user_id,

      availableBalance: parseFloat(data.available_balance),

      escrowBalance: parseFloat(data.escrow_balance),

      pendingWithdrawal: parseFloat(data.pending_withdrawal),

      preferredCurrency: data.preferred_currency,

      kycStatus: data.kyc_status,

      dailyDepositLimit: parseFloat(data.daily_deposit_limit),

      dailyWithdrawalLimit: parseFloat(data.daily_withdrawal_limit),

      createdAt: data.created_at,

      updatedAt: data.updated_at,

      // Sales tracking

      totalVendorSales: data.total_vendor_sales ? parseFloat(data.total_vendor_sales) : 0,

      totalRiderEarnings: data.total_rider_earnings ? parseFloat(data.total_rider_earnings) : 0,

      lifetimeRevenue: data.lifetime_revenue ? parseFloat(data.lifetime_revenue) : 0,

    };

  }



  private mapDepositToDto(data: any): DepositResponseDto {

    return {

      id: data.id,

      userId: data.user_id,

      fretiAmount: parseFloat(data.freti_amount),

      localAmount: parseFloat(data.local_amount),

      localCurrency: data.local_currency,

      exchangeRate: data.exchange_rate ? parseFloat(data.exchange_rate) : undefined,

      status: data.status,

      externalPaymentId: data.external_payment_id,

      paymentLink: data.metadata?.payment_link || undefined,

      initiatedAt: data.initiated_at,

      completedAt: data.completed_at,

      failureReason: data.failure_reason,

      createdAt: data.created_at,

      updatedAt: data.updated_at,

    };

  }



  private mapPayoutToDto(data: any): PayoutRequestResponseDto {

    return {

      id: data.id,

      userId: data.user_id,

      fretiAmount: parseFloat(data.freti_amount),

      estimatedLocalAmount: data.estimated_local_amount ? parseFloat(data.estimated_local_amount) : undefined,

      localCurrency: data.local_currency,

      status: data.status,

      externalPayoutId: data.external_payout_id,

      requestedAt: data.requested_at,

      processedAt: data.processed_at,

      paidAt: data.paid_at,

      failureReason: data.failure_reason,

      retryCount: data.retry_count,

      createdAt: data.created_at,

      updatedAt: data.updated_at,

    };

  }



  // ================================

  // WEBHOOK HANDLERS

  // ================================



  /**

   * Handle deposit webhook from Flutterwave

   */

  async handleDepositWebhook(webhookData: any): Promise<void> {

    const startTime = Date.now();

    // Support both Flutterwave v2 (event) and v3 (type) formats

    const event = webhookData.type || webhookData.event;

    const data = webhookData.data || webhookData;

    

    try {

      console.log('📥 Processing deposit webhook:', {

        event,

        eventType: typeof event,

        hasData: !!data,

        txRef: data?.tx_ref || data?.txRef || webhookData?.tx_ref || webhookData?.txRef,

        status: data?.status,

        amount: data?.amount,

        currency: data?.currency,

        paymentId: data?.id || data?.flw_ref,

        fullWebhookKeys: Object.keys(webhookData || {}),

        dataKeys: data ? Object.keys(data) : [],

      });



      // Find deposit by tx_ref

      // Flutterwave sends tx_ref which matches the deposit id we sent during payment initialization

      const txRef = data.tx_ref || data.txRef || webhookData.tx_ref || webhookData.txRef;

      if (!txRef) {

        console.error('❌ No tx_ref found in webhook data');

        console.error('📦 Webhook data keys:', Object.keys(data || {}));

        console.error('📦 Full webhook data:', JSON.stringify(webhookData, null, 2).substring(0, 500));

        return;

      }



      console.log(`🔍 Looking up deposit with tx_ref/id: ${txRef}`);



      // Try to find deposit by id (which should match tx_ref from Flutterwave)

      let { data: deposit, error: depositError } = await this.supabase

        .from('deposits')

        .select('*')

        .eq('id', txRef)

        .single();



      // If not found by id, try by external_payment_id (in case webhook arrives before deposit is created)

      if (depositError || !deposit) {

        const externalPaymentId = data.id?.toString() || data.flw_ref;

        if (externalPaymentId) {

          console.log(`🔍 Deposit not found by id, trying external_payment_id: ${externalPaymentId}`);

          const result = await this.supabase

            .from('deposits')

            .select('*')

            .eq('external_payment_id', externalPaymentId)

            .single();

          

          if (result.data) {

            deposit = result.data;

            depositError = null;

            console.log(`✅ Found deposit by external_payment_id: ${externalPaymentId}`);

          }

        }

      }



      if (depositError || !deposit) {

        console.error('❌ Deposit not found with tx_ref/id:', txRef);

        console.error('❌ Deposit error:', depositError);

        console.error('📦 Webhook data:', JSON.stringify({ txRef, data: data?.id || data?.flw_ref }, null, 2));

        return;

      }



      console.log(`✅ Found deposit: ${deposit.id}, status: ${deposit.status}, user: ${deposit.user_id}`);



      // Check if already processed (idempotency check)

      const externalPaymentId = data.id?.toString() || data.flw_ref;

      if (deposit.status === 'completed') {

        // Verify it's the same payment (prevent duplicate processing)

        if (deposit.external_payment_id === externalPaymentId) {

          console.log('⚠️ Deposit already processed:', txRef);

          return;

        } else {

          console.warn('⚠️ Deposit completed but with different payment ID. Possible duplicate webhook.');

          return;

        }

      }



      // Additional idempotency: Check if external_payment_id already exists

      if (externalPaymentId) {

        const { data: existingDeposit } = await this.supabase

          .from('deposits')

          .select('id, status')

          .eq('external_payment_id', externalPaymentId)

          .neq('id', txRef)

          .single();



        if (existingDeposit) {

          console.warn('⚠️ Payment ID already processed for different deposit:', externalPaymentId);

          return;

        }

      }



      if (event === 'charge.completed' && data.status === 'successful') {

        // Payment successful

        // CRITICAL: Verify the payment with Flutterwave to get the exact USD amount

        // The webhook may not include amount_settled, so we need to verify to get accurate conversion

        const localAmount = data.amount; // Amount in local currency (e.g., 19200 NGN)

        const localCurrency = data.currency || deposit.local_currency || 'USD'; // Currency (e.g., NGN)

        

        let usdAmount: number;

        let exchangeRate: number;

        

        // Get the transaction ID from webhook

        const transactionId = data.id?.toString() || data.flw_ref;

        

        if (transactionId) {

          try {

            // Verify payment with Flutterwave to get exact USD amount

            console.log(`🔍 Verifying payment with Flutterwave to get exact USD amount: ${transactionId}`);

            const verificationResult = await this.flutterwaveService.verifyPayment(transactionId);

            

            if (verificationResult.status === 'success' && verificationResult.data) {

              const paymentData = verificationResult.data;

              

              // Log the full payment data for debugging

              this.logger.debug(`🔍 Flutterwave payment verification response:`, JSON.stringify({

                amount: paymentData.amount,

                currency: paymentData.currency,

                amount_settled: paymentData.amount_settled,

                currency_settled: (paymentData as any).currency_settled,

              }, null, 2));

              

              // SIMPLIFIED APPROACH: Always use paymentData.amount and paymentData.currency from Flutterwave

              // Convert whatever currency Flutterwave gives us to USD using our exchange rate API

              // This works for ALL currencies uniformly and is more reliable than guessing what amount_settled means

              const flutterwaveAmount = paymentData.amount; // Amount from Flutterwave

              const flutterwaveCurrency = paymentData.currency; // Currency from Flutterwave

              

              if (flutterwaveCurrency === 'USD') {

                // Already in USD

                usdAmount = flutterwaveAmount;

                exchangeRate = 1.0;

                console.log(`✅ Payment in USD: ${usdAmount} USD`);

              } else {

                // Convert from Flutterwave's currency to USD using our exchange rate API

                this.logger.log(`💱 Converting Flutterwave payment: ${flutterwaveAmount} ${flutterwaveCurrency} → USD`);

                try {

                  const rateInfo = await this.flutterwaveService.getExchangeRate(flutterwaveCurrency, 'USD', flutterwaveAmount);

                  usdAmount = rateInfo.destination.amount; // USD amount from exchange rate API

                  exchangeRate = rateInfo.rate;

                  console.log(`✅ Converted payment: ${flutterwaveAmount} ${flutterwaveCurrency} → ${usdAmount} USD (rate: ${exchangeRate.toFixed(4)})`);

                } catch (rateError: any) {

                  this.logger.error(`❌ Could not convert Flutterwave payment amount: ${rateError.message}`);

                  // Cannot process deposit without exchange rate

                  await this.supabase

                    .from('deposits')

                    .update({

                      status: 'failed',

                      failure_reason: 'Unable to convert payment to USD. Exchange rate service temporarily unavailable.',

                      webhook_data: webhookData,

                    })

                    .eq('id', txRef);



                  await this.notificationHelper.notifySystemUpdate(

                    deposit.user_id,

                    'Deposit Processing Failed',

                    `Your deposit of ${flutterwaveAmount} ${flutterwaveCurrency} could not be processed due to exchange rate service unavailability. Please try again later.`,

                    { depositId: txRef, type: 'wallet_deposit_failed' }

                  );



                  this.logger.error(`❌ Deposit ${txRef} marked as failed due to exchange rate conversion error`);

                  return; // Exit early

                }

              }

              

              // If there was a previous fallback rate used, update the reconciliation alert with actual data

              // Check if deposit had a different exchange rate (indicating fallback was used)

              if (deposit.exchange_rate && Math.abs(deposit.exchange_rate - exchangeRate) > 0.01) {

                await this.reconciliationService.updateReconciliationAlertWithActualData(

                  txRef,

                  usdAmount,

                  exchangeRate

                );

              }

            } else {

              throw new Error('Verification returned non-success status');

            }

          } catch (verifyError: any) {

            console.error('❌ Failed to verify payment with Flutterwave:', verifyError.message);

            // Verification failed - use webhook data and convert using exchange rate API

            const webhookAmount = data.amount || localAmount;

            const webhookCurrency = data.currency || localCurrency;

            

            if (webhookCurrency === 'USD') {

              usdAmount = webhookAmount;

              exchangeRate = 1.0;

              console.warn(`⚠️ Using webhook amount as USD (verification failed): ${usdAmount} USD`);

            } else {

              // Convert webhook amount to USD using exchange rate API

              this.logger.log(`💱 Converting webhook payment (verification failed): ${webhookAmount} ${webhookCurrency} → USD`);

              try {

                const rateInfo = await this.flutterwaveService.getExchangeRate(webhookCurrency, 'USD', webhookAmount);

                usdAmount = rateInfo.destination.amount;

                exchangeRate = rateInfo.rate;

                console.log(`✅ Converted webhook payment: ${webhookAmount} ${webhookCurrency} → ${usdAmount} USD (rate: ${exchangeRate.toFixed(4)})`);

              } catch (rateError: any) {

                this.logger.error(`❌ Could not convert webhook payment: ${rateError.message}`);

                // Cannot process deposit without exchange rate

                await this.supabase

                  .from('deposits')

                  .update({

                    status: 'failed',

                    failure_reason: 'Unable to convert payment to USD. Exchange rate service temporarily unavailable.',

                    webhook_data: webhookData,

                  })

                  .eq('id', txRef);



                await this.notificationHelper.notifySystemUpdate(

                  deposit.user_id,

                  'Deposit Processing Failed',

                  `Your deposit of ${webhookAmount} ${webhookCurrency} could not be processed due to exchange rate service unavailability. Please try again later.`,

                  { depositId: txRef, type: 'wallet_deposit_failed' }

                );



                this.logger.error(`❌ Deposit ${txRef} marked as failed due to exchange rate conversion error (verification failed)`);

                return; // Exit early

              }

            }

            

            // Create reconciliation alert for verification failure

            await this.reconciliationService.createReconciliationAlert({

              depositId: txRef,

              userId: deposit.user_id,

              localAmount: webhookAmount,

              localCurrency: webhookCurrency,

              fallbackRateUsed: exchangeRate,

              estimatedFretiAmount: usdAmount,

              alertReason: `Flutterwave verification failed: ${verifyError.message}`,

              metadata: {

                verificationError: verifyError.message,

                transactionId: transactionId,

                usedWebhookData: true,

              },

            });

          }

        } else {

          // No transaction ID - use webhook data and convert using exchange rate API

          const webhookAmount = data.amount || localAmount;

          const webhookCurrency = data.currency || localCurrency;

          

          if (webhookCurrency === 'USD') {

            usdAmount = webhookAmount;

            exchangeRate = 1.0;

            console.warn(`⚠️ Using webhook amount as USD (no transaction ID): ${usdAmount} USD`);

          } else {

            // Convert webhook amount to USD using exchange rate API

            this.logger.log(`💱 Converting webhook payment (no transaction ID): ${webhookAmount} ${webhookCurrency} → USD`);

            try {

              const rateInfo = await this.flutterwaveService.getExchangeRate(webhookCurrency, 'USD', webhookAmount);

              usdAmount = rateInfo.destination.amount;

              exchangeRate = rateInfo.rate;

              console.log(`✅ Converted webhook payment: ${webhookAmount} ${webhookCurrency} → ${usdAmount} USD (rate: ${exchangeRate.toFixed(4)})`);

            } catch (rateError: any) {

              this.logger.error(`❌ Could not convert webhook payment: ${rateError.message}`);

              // Cannot process deposit without exchange rate

              await this.supabase

                .from('deposits')

                .update({

                  status: 'failed',

                  failure_reason: 'Unable to convert payment to USD. Exchange rate service temporarily unavailable.',

                  webhook_data: webhookData,

                })

                .eq('id', txRef);



              await this.notificationHelper.notifySystemUpdate(

                deposit.user_id,

                'Deposit Processing Failed',

                `Your deposit of ${webhookAmount} ${webhookCurrency} could not be processed due to exchange rate service unavailability. Please try again later.`,

                { depositId: txRef, type: 'wallet_deposit_failed' }

              );



              this.logger.error(`❌ Deposit ${txRef} marked as failed due to exchange rate conversion error (no transaction ID)`);

              return; // Exit early

            }

          }

          

          // Create reconciliation alert for no transaction ID case

          await this.reconciliationService.createReconciliationAlert({

            depositId: txRef,

            userId: deposit.user_id,

            localAmount: webhookAmount,

            localCurrency: webhookCurrency,

            fallbackRateUsed: exchangeRate,

            estimatedFretiAmount: usdAmount,

            alertReason: `No transaction ID available - used webhook data and exchange rate API`,

            metadata: {

              hasTransactionId: false,

              usedWebhookData: true,

            },

          });

        }

        

        // CRITICAL VALIDATION: Ensure usdAmount is correct (not equal to localAmount for non-USD)

        if (localCurrency !== 'USD') {

          // For non-USD currencies, usdAmount should be much smaller than localAmount

          // If they're equal or very close, something is wrong

          if (Math.abs(usdAmount - localAmount) < 1) {

            this.logger.error(`❌ CRITICAL ERROR: usdAmount (${usdAmount}) is too close to localAmount (${localAmount}) for ${localCurrency}!`);

            this.logger.error(`❌ This indicates incorrect conversion. Transaction: ${txRef}, exchangeRate: ${exchangeRate}`);

            

            // Try to recalculate using exchange rate API

            try {

              this.logger.log(`🔄 Attempting to recalculate using exchange rate API...`);

              const rateInfo = await this.flutterwaveService.getExchangeRate(localCurrency, 'USD', localAmount);

              usdAmount = rateInfo.destination.amount;

              exchangeRate = localAmount / usdAmount;

              this.logger.log(`✅ Recalculated: ${localAmount} ${localCurrency} → ${usdAmount} USD (rate: ${exchangeRate.toFixed(4)})`);

            } catch (recalcError: any) {

              this.logger.error(`❌ Recalculation failed: ${recalcError.message}`);

              // Mark deposit as failed

              await this.supabase

                .from('deposits')

                .update({

                  status: 'failed',

                  failure_reason: 'Invalid currency conversion detected. Please contact support.',

                  webhook_data: webhookData,

                })

                .eq('id', txRef);



              await this.notificationHelper.notifySystemUpdate(

                deposit.user_id,

                'Deposit Processing Failed',

                `Your deposit of ${localAmount} ${localCurrency} could not be processed due to conversion error. Please contact support.`,

                { depositId: txRef, type: 'wallet_deposit_failed' }

              );

              return;

            }

          }

        }

        

        const fretiAmount = usdAmount; // 1 USD = 1 FRETI



        console.log(`✅ Deposit successful: ${localAmount} ${localCurrency} → ${usdAmount.toFixed(2)} USD → ${fretiAmount.toFixed(2)} FRETI`);



        // Update deposit record

        await this.supabase

          .from('deposits')

          .update({

            freti_amount: fretiAmount,

            exchange_rate: exchangeRate,

            status: 'completed',

            external_payment_id: externalPaymentId,

            webhook_data: webhookData,

            completed_at: new Date().toISOString(),

          })

          .eq('id', txRef);



        // Get wallet

        const wallet = await this.getWallet(deposit.user_id);



        // Create ledger entry to credit wallet

        await this.createLedgerEntry({

          walletId: wallet.id,

          transactionType: 'deposit_mint',

          availableDelta: fretiAmount,

          escrowDelta: 0,

          pendingWithdrawalDelta: 0,

          referenceType: 'deposit',

          referenceId: txRef,

          idempotencyKey: `deposit_${txRef}_${Date.now()}`,

          description: `Deposit: ${data.amount} ${data.currency} → ₣${fretiAmount} FRETI`,

        }, deposit.user_id);



        // Send notification

        await this.notificationHelper.notifySystemUpdate(

          deposit.user_id,

          'Deposit Successful',

          `Your deposit of ${data.amount} ${data.currency} has been credited as ₣${fretiAmount} FRETI to your wallet.`,

          { depositId: txRef, amount: fretiAmount, type: 'wallet_deposit_completed' }

        );



        const processingTime = Date.now() - startTime;

        console.log(`✅ Deposit processed and wallet credited: ${txRef} (${processingTime}ms)`);

        

        // Log for audit

        this.logger.log(`Deposit completed: ${txRef}`, {

          userId: deposit.user_id,

          amount: fretiAmount,

          currency: data.currency,

          processingTime,

        });

      } else if (event === 'charge.failed' || (event === 'charge.completed' && data.status !== 'successful')) {

        // Payment failed

        const failureReason = data.processor_response || data.message || 'Payment failed';

        console.log(`❌ Deposit failed: ${txRef} - ${failureReason}`);

        

        // Log for audit

        this.logger.warn(`Deposit failed: ${txRef}`, {

          userId: deposit.user_id,

          reason: failureReason,

          webhookData: data,

        });



        await this.supabase

          .from('deposits')

          .update({

            status: 'failed',

            failure_reason: data.processor_response || data.message || 'Payment failed',

            webhook_data: webhookData,

          })

          .eq('id', txRef);



        // Send notification

        await this.notificationHelper.notifySystemUpdate(

          deposit.user_id,

          'Deposit Failed',

          `Your deposit of ${data.amount} ${data.currency} could not be processed. Please try again.`,

          { depositId: txRef, type: 'wallet_deposit_failed' }

        );

      }

    } catch (error: any) {

      const processingTime = Date.now() - startTime;

      console.error('❌ Error processing deposit webhook:', {

        error: error.message,

        stack: error.stack,

        processingTime,

        webhookData: webhookData.event,

      });

      throw error;

    }

  }



  /**

   * Manually verify and process a deposit by checking Flutterwave

   * Useful when webhook wasn't received

   */

  async verifyDepositManually(depositId: string, userId: string): Promise<void> {

    try {

      console.log(`🔍 Manually verifying deposit: ${depositId}`);



      // Get deposit record

      const { data: deposit, error: depositError } = await this.supabase

        .from('deposits')

        .select('*')

        .eq('id', depositId)

        .eq('user_id', userId)

        .single();



      if (depositError || !deposit) {

        throw new BadRequestException('Deposit not found');

      }



      // Check if already processed

      if (deposit.status === 'completed') {

        // Check if ledger entry exists

        const { data: existingLedger } = await this.supabase

          .from('wallet_ledger')

          .select('id')

          .eq('reference_type', 'deposit')

          .eq('reference_id', depositId)

          .single();



        if (existingLedger) {

          console.log('✅ Deposit already processed');

          return;

        } else {

          // Deposit marked as completed but no ledger entry - create it

          console.log('⚠️ Deposit marked completed but no ledger entry found. Creating ledger entry...');

          const wallet = await this.getWallet(userId);

          await this.createLedgerEntry({

            walletId: wallet.id,

            transactionType: 'deposit_mint',

            availableDelta: parseFloat(deposit.freti_amount.toString()),

            escrowDelta: 0,

            pendingWithdrawalDelta: 0,

            referenceType: 'deposit',

            referenceId: depositId,

            idempotencyKey: `deposit_${depositId}_manual_${Date.now()}`,

            description: `Deposit: ${deposit.local_amount} ${deposit.local_currency} → ₣${deposit.freti_amount} FRETI`,

          }, userId);

          console.log('✅ Ledger entry created');

          return;

        }

      }



      // Verify payment with Flutterwave

      if (!deposit.external_payment_id) {

        throw new BadRequestException('No external payment ID found. Cannot verify.');

      }



      const verificationResult = await this.flutterwaveService.verifyPayment(deposit.external_payment_id);



      if (verificationResult.status === 'success' && verificationResult.data.status === 'successful') {

        // Payment successful - process it

        const paymentData = verificationResult.data;

        

        // CRITICAL: Use amount_settled (USD equivalent) if available, otherwise calculate from amount and currency

        let usdAmount: number;

        let exchangeRate: number;

        const localCurrency = paymentData.currency || deposit.local_currency || 'USD';

        const localAmount = paymentData.amount; // Amount in local currency from Flutterwave

        

        if (paymentData.amount_settled) {

          // amount_settled is the USD equivalent - use it directly

          usdAmount = paymentData.amount_settled;

          exchangeRate = localAmount / usdAmount;

          console.log(`✅ Deposit verified: ${localAmount} ${localCurrency} → ${usdAmount} USD (rate: ${exchangeRate.toFixed(4)})`);

        } else if (localCurrency === 'USD') {

          // Already in USD

          usdAmount = localAmount;

          exchangeRate = 1.0;

          console.log(`✅ Deposit verified: ${localAmount} USD (already in USD)`);

        } else {

          // amount_settled not available and not USD - try to fetch current rate

          console.warn(`⚠️ amount_settled not available for ${localCurrency} deposit. Attempting to fetch rate.`);

          const storedRate = deposit.exchange_rate;

          if (storedRate && storedRate !== 1 && storedRate > 0) {

            // Use stored rate if valid

            exchangeRate = storedRate;

            usdAmount = localAmount / exchangeRate;

            console.warn(`⚠️ Using stored rate ${exchangeRate.toFixed(4)}: ${localAmount} ${localCurrency} → ${usdAmount} USD`);

          } else {

            // Try to fetch from exchange rate service (Flutterwave + third-party fallback)

            try {

              const rateInfo = await this.flutterwaveService.getExchangeRate(localCurrency, 'USD', localAmount);

              usdAmount = rateInfo.destination.amount;

              exchangeRate = rateInfo.rate;

              console.log(`✅ Fetched rate for manual verification: ${localAmount} ${localCurrency} → ${usdAmount} USD (rate: ${exchangeRate.toFixed(4)})`);

            } catch (rateError: any) {

              // Cannot proceed without exchange rate

              console.error(`❌ Could not get exchange rate for manual verification: ${rateError.message}`);

              throw new BadRequestException(

                'Cannot verify deposit: Exchange rate service is unavailable. Please try again later or contact support.'

              );

            }

          }

        }

        

        const fretiAmount = usdAmount; // 1 USD = 1 FRETI

        console.log(`✅ Deposit verified: ${localAmount} ${localCurrency} → ${usdAmount} USD → ${fretiAmount.toFixed(2)} FRETI`);



        // Update deposit record

        await this.supabase

          .from('deposits')

          .update({

            freti_amount: fretiAmount,

            exchange_rate: exchangeRate,

            status: 'completed',

            external_payment_id: deposit.external_payment_id,

            completed_at: new Date().toISOString(),

          })

          .eq('id', depositId);



        // Get wallet

        const wallet = await this.getWallet(userId);



        // Create ledger entry

        await this.createLedgerEntry({

          walletId: wallet.id,

          transactionType: 'deposit_mint',

          availableDelta: fretiAmount,

          escrowDelta: 0,

          pendingWithdrawalDelta: 0,

          referenceType: 'deposit',

          referenceId: depositId,

          idempotencyKey: `deposit_${depositId}_manual_${Date.now()}`,

          description: `Deposit: ${paymentData.amount} ${paymentData.currency} → ₣${fretiAmount} FRETI`,

        }, userId);



        // Send notification

        await this.notificationHelper.notifySystemUpdate(

          userId,

          'Deposit Verified',

          `Your deposit of ${paymentData.amount} ${paymentData.currency} has been verified and credited as ₣${fretiAmount} FRETI to your wallet.`,

          { depositId, amount: fretiAmount, type: 'wallet_deposit_completed' }

        );



        console.log(`✅ Deposit manually verified and processed: ${depositId}`);

      } else {

        // Payment not successful

        const failureReason = verificationResult.data?.processor_response || 'Payment verification failed';

        console.log(`❌ Deposit verification failed: ${depositId} - ${failureReason}`);



        await this.supabase

          .from('deposits')

          .update({

            status: 'failed',

            failure_reason: failureReason,

          })

          .eq('id', depositId);



        throw new BadRequestException(`Deposit verification failed: ${failureReason}`);

      }

    } catch (error: any) {

      console.error('❌ Error manually verifying deposit:', error);

      this.logger.error(`Manual deposit verification error: ${error.message}`, {

        depositId,

        userId,

        error: error.message,

        stack: error.stack,

      });

      throw error;

    }

  }



  /**

   * Manually verify and process a withdrawal by checking Flutterwave

   * Useful when webhook wasn't received

   */

  async verifyWithdrawalManually(payoutId: string, userId: string): Promise<void> {

    try {

      console.log(`🔍 Manually verifying withdrawal: ${payoutId}`);



      // Get payout record

      const { data: payout, error: payoutError } = await this.supabase

        .from('payout_requests')

        .select('*')

        .eq('id', payoutId)

        .eq('user_id', userId)

        .single();



      if (payoutError || !payout) {

        throw new BadRequestException('Payout not found');

      }



      // Check if already processed

      if (payout.status === 'paid') {

        // Check if ledger entry exists

        const { data: existingLedger } = await this.supabase

          .from('wallet_ledger')

          .select('id')

          .eq('reference_type', 'payout_request')

          .eq('reference_id', payoutId)

          .eq('transaction_type', 'withdrawal_burn')

          .like('description', '%completed%')

          .single();



        if (existingLedger) {

          console.log('✅ Withdrawal already processed');

          return;

        } else {

          // Payout marked as paid but no ledger entry - create it

          console.log('⚠️ Payout marked paid but no ledger entry found. Creating ledger entry...');

          const wallet = await this.getWallet(userId);

          await this.createLedgerEntry({

            walletId: wallet.id,

            transactionType: 'withdrawal_burn',

            availableDelta: 0,

            escrowDelta: 0,

            pendingWithdrawalDelta: -payout.freti_amount, // Remove from pending

            referenceType: 'payout_request',

            referenceId: payoutId,

            idempotencyKey: `withdrawal_${payoutId}_manual_${Date.now()}`,

            description: `Withdrawal completed: ₣${payout.freti_amount} FRETI → ${payout.estimated_local_amount || payout.freti_amount} ${payout.local_currency}`,

          }, userId);

          console.log('✅ Ledger entry created');

          return;

        }

      }



      // Verify transfer with Flutterwave

      if (!payout.external_payout_id) {

        throw new BadRequestException('No external payout ID found. Cannot verify.');

      }



      const verificationResult = await this.flutterwaveService.verifyTransfer(payout.external_payout_id);



      if (verificationResult.status === 'success' && verificationResult.data.status === 'SUCCESSFUL') {

        // Transfer successful - process it

        const transferData = verificationResult.data;

        

        // Extract amounts and currency from Flutterwave verification response

        const usdAmount = transferData.amount || payout.freti_amount;

        let localAmount: number;

        let localCurrency: string;

        let exchangeRate: number;



        // Flutterwave transfer response may include settled currency/amount

        if (transferData.currency_settled && transferData.amount_settled) {

          // Best case: Flutterwave explicitly provides converted currency and amount

          localCurrency = transferData.currency_settled;

          localAmount = transferData.amount_settled;

          exchangeRate = localAmount / usdAmount;

        } else if (transferData.currency && transferData.currency !== 'USD') {

          // Fallback: currency specified but no amount_settled

          localCurrency = transferData.currency;

          localAmount = transferData.amount || payout.freti_amount;

          exchangeRate = localAmount / usdAmount;

          this.logger.warn(`Manual verification: Missing amount_settled. Using fallback calculation for withdrawal ${payoutId}`);

        } else {

          // Last resort: use payout record estimates

          localCurrency = payout.local_currency;

          localAmount = payout.estimated_local_amount || payout.freti_amount;

          exchangeRate = localCurrency === 'USD' ? 1.0 : (localAmount / usdAmount);

          this.logger.warn(`Manual verification: Using payout record estimates (no conversion data) for withdrawal ${payoutId}`);

        }



        // Validate currency matches expected destination currency

        if (localCurrency !== payout.local_currency) {

          this.logger.warn(`⚠️ Currency mismatch in manual verification ${payoutId}: Expected ${payout.local_currency}, got ${localCurrency}`);

        }

        

        console.log(`✅ Withdrawal verified: ${usdAmount} USD → ${localAmount} ${localCurrency} (rate: ${exchangeRate.toFixed(4)} ${localCurrency}/USD)`);



        // Update payout record

        await this.supabase

          .from('payout_requests')

          .update({

            estimated_local_amount: localAmount,

            local_currency: localCurrency,

            status: 'paid',

            external_payout_id: payout.external_payout_id,

            paid_at: new Date().toISOString(),

            metadata: {

              ...payout.metadata,

              exchange_rate: exchangeRate,

              usd_amount: usdAmount,

              local_amount_actual: localAmount,

              verified_manually: true,

            }

          })

          .eq('id', payoutId);



        // Get wallet

        const wallet = await this.getWallet(userId);



        // Create ledger entry to remove from pending

        await this.createLedgerEntry({

          walletId: wallet.id,

          transactionType: 'withdrawal_burn',

          availableDelta: 0,

          escrowDelta: 0,

          pendingWithdrawalDelta: -payout.freti_amount,

          referenceType: 'payout_request',

          referenceId: payoutId,

          idempotencyKey: `withdrawal_${payoutId}_manual_${Date.now()}`,

          description: `Withdrawal completed: ₣${payout.freti_amount} FRETI → ${localAmount} ${localCurrency}`,

        }, userId);



        // Send notification

        await this.notificationHelper.notifySystemUpdate(

          userId,

          'Withdrawal Verified',

          `Your withdrawal of ₣${payout.freti_amount} FRETI has been verified and processed. ${localAmount} ${localCurrency} has been sent to your bank account.`,

          { payoutId, amount: payout.freti_amount, localAmount, localCurrency, type: 'wallet_withdrawal_completed' }

        );



        console.log(`✅ Withdrawal manually verified and processed: ${payoutId}`);

      } else {

        // Transfer not successful

        const transferData = verificationResult.data;

        const failureReason = transferData?.complete_message || verificationResult.message || 'Transfer verification failed';

        console.log(`❌ Withdrawal verification failed: ${payoutId} - ${failureReason}`);



        // Get wallet

        const wallet = await this.getWallet(userId);



        // Refund from pending_withdrawal to available_balance

        await this.createLedgerEntry({

          walletId: wallet.id,

          transactionType: 'withdrawal_burn',

          availableDelta: payout.freti_amount, // Refund

          escrowDelta: 0,

          pendingWithdrawalDelta: -payout.freti_amount, // Remove from pending

          referenceType: 'payout_request',

          referenceId: payoutId,

          idempotencyKey: `withdrawal_refund_${payoutId}_manual_${Date.now()}`,

          description: 'Withdrawal failed - funds refunded to available balance',

        }, userId);



        // Check if we should retry (max 3 retries)

        const currentRetryCount = payout.retry_count || 0;

        const maxRetries = 3;

        

        if (currentRetryCount < maxRetries) {

          // Update payout status to pending for retry (with delay)

          const retryDelayHours = Math.pow(2, currentRetryCount); // Exponential backoff: 1h, 2h, 4h

          const nextRetryAt = new Date(Date.now() + retryDelayHours * 60 * 60 * 1000);

          

          await this.supabase

            .from('payout_requests')

            .update({

              status: 'pending',

              retry_count: currentRetryCount + 1,

              failure_reason: `${failureReason} (Retry ${currentRetryCount + 1}/${maxRetries} scheduled)`,

              metadata: {

                ...payout.metadata,

                last_failure_reason: failureReason,

                next_retry_at: nextRetryAt.toISOString(),

                retry_count: currentRetryCount + 1,

              },

              updated_at: new Date().toISOString(),

            })

            .eq('id', payoutId);



          // Send notification about retry

          await this.notificationHelper.notifySystemUpdate(

            userId,

            'Withdrawal Retry Scheduled',

            `Your withdrawal of ₣${payout.freti_amount} FRETI failed but will be retried automatically. Retry ${currentRetryCount + 1} of ${maxRetries} scheduled. Reason: ${failureReason}`,

            { payoutId, amount: payout.freti_amount, retryCount: currentRetryCount + 1, type: 'wallet_withdrawal_retry' }

          );



          console.log(`⏳ Withdrawal ${payoutId} scheduled for retry ${currentRetryCount + 1}/${maxRetries} at ${nextRetryAt.toISOString()}`);

          

          // Note: In a production system, you'd want a background job/cron to retry these

          // For now, the retry will happen when the withdrawal is manually verified again

        } else {

          // Max retries exceeded - mark as failed permanently

          await this.supabase

            .from('payout_requests')

            .update({

              status: 'failed',

              failure_reason: `${failureReason} (Max retries exceeded)`,

              metadata: {

                ...payout.metadata,

                last_failure_reason: failureReason,

                retry_count: currentRetryCount,

                max_retries_exceeded: true,

              },

            })

            .eq('id', payoutId);



          // Send notification about permanent failure

          await this.notificationHelper.notifySystemUpdate(

            userId,

            'Withdrawal Failed',

            `Your withdrawal of ₣${payout.freti_amount} FRETI failed after ${maxRetries} retry attempts. Funds have been refunded to your wallet. Please contact support if you need assistance.`,

            { payoutId, amount: payout.freti_amount, type: 'wallet_withdrawal_failed' }

          );



          console.log(`❌ Withdrawal ${payoutId} failed permanently after ${maxRetries} retries`);

        }

      }

    } catch (error: any) {

      console.error(`❌ Error manually verifying withdrawal: ${payoutId}`, error);

      throw error;

    }

  }



  /**

   * Handle withdrawal webhook from Flutterwave

   */

  async handleWithdrawalWebhook(webhookData: any): Promise<void> {

    const startTime = Date.now();

    // Support both Flutterwave v2 (event) and v3 (type) formats

    const event = webhookData.type || webhookData.event;

    const data = webhookData.data || webhookData;

    

    try {

      console.log('📤 Processing withdrawal webhook:', {

        event,

        eventType: typeof event,

        hasData: !!data,

        reference: data?.reference || data?.reference_id || webhookData?.reference || webhookData?.reference_id,

        status: data?.status,

        amount: data?.amount,

        currency: data?.currency,

        transferId: data?.id || data?.transfer_id || data?.flw_ref,

        fullWebhookKeys: Object.keys(webhookData || {}),

        dataKeys: data ? Object.keys(data) : [],

      });



      // Find payout by reference (payout ID) or external_payout_id

      // Flutterwave sends reference as the payout ID we provided during transfer initiation

      const reference = data.reference || data.reference_id || webhookData.reference || webhookData.reference_id;

      const externalPayoutId = data.id?.toString() || data.transfer_id?.toString() || data.flw_ref;

      

      if (!reference && !externalPayoutId) {

        console.error('❌ No reference or transfer ID found in webhook data');

        console.error('📦 Webhook data:', JSON.stringify(webhookData, null, 2).substring(0, 500));

        return;

      }



      console.log(`🔍 Looking up payout with reference: ${reference || 'none'}, external_payout_id: ${externalPayoutId || 'none'}`);



      // Try to find payout by reference (payout ID) first

      let { data: payout, error: payoutError } = await this.supabase

        .from('payout_requests')

        .select('*')

        .eq('id', reference)

        .single();



      // If not found by reference and we have external_payout_id, try that

      if ((payoutError || !payout) && externalPayoutId) {

        console.log(`🔍 Payout not found by reference, trying external_payout_id: ${externalPayoutId}`);

        const result = await this.supabase

          .from('payout_requests')

          .select('*')

          .eq('external_payout_id', externalPayoutId)

          .single();

        

        if (result.data) {

          payout = result.data;

          payoutError = null;

          console.log(`✅ Found payout by external_payout_id: ${externalPayoutId}`);

        }

      }



      // If still not found, try finding by reference in metadata or any other field

      if (payoutError || !payout) {

        // Last resort: search for any payout with this reference in metadata

        if (reference) {

          console.log(`🔍 Trying to find payout by reference in metadata or other fields...`);

          const result = await this.supabase

            .from('payout_requests')

            .select('*')

            .or(`id.eq.${reference},metadata->>transfer_reference.eq.${reference}`)

            .order('created_at', { ascending: false })

            .limit(1)

            .maybeSingle();

          

          if (result.data) {

            payout = result.data;

            payoutError = null;

            console.log(`✅ Found payout by reference search: ${reference}`);

          }

        }

      }



      if (payoutError || !payout) {

        console.error('❌ Payout not found with reference:', reference);

        console.error('❌ Payout error:', payoutError);

        console.error('❌ External payout ID tried:', externalPayoutId);

        console.error('📦 Webhook data:', JSON.stringify({ event, reference, externalPayoutId, dataKeys: data ? Object.keys(data) : [] }, null, 2));

        return;

      }



      console.log(`✅ Found payout: ${payout.id}, status: ${payout.status}, user: ${payout.user_id}`);



      // ENHANCED: Check idempotency and prevent race conditions

      // Use the externalPayoutId we extracted earlier (if not set, use reference as fallback)

      const transferId = externalPayoutId || data.id?.toString() || data.transfer_id?.toString() || data.flw_ref || reference;

      

      // Check if payout is already in a terminal state (paid, failed, cancelled)

      if (payout.status === 'paid' || payout.status === 'failed' || payout.status === 'cancelled') {

        // Verify it's the same transfer (prevent duplicate processing)

        if (transferId && payout.external_payout_id === transferId) {

          console.log(`⚠️ Payout ${payout.id} already processed (status: ${payout.status}) with same transfer ID ${transferId}`);

          return;

        } else {

          console.warn(`⚠️ Payout ${payout.id} in terminal state (${payout.status}) but with different transfer ID. Current: ${payout.external_payout_id}, Webhook: ${transferId}`);

          // Don't process if in terminal state, even if transfer ID differs (prevents state corruption)

          return;

        }

      }



      // Additional idempotency: Check if external_payout_id already exists for different payout

      // This prevents processing the same Flutterwave transfer twice

      if (transferId && transferId !== reference) {

        const { data: existingPayouts } = await this.supabase

          .from('payout_requests')

          .select('id, status, user_id')

          .eq('external_payout_id', transferId)

          .neq('id', payout.id);



        if (existingPayouts && existingPayouts.length > 0) {

          const existing = existingPayouts[0];

          console.warn(`⚠️ Transfer ID ${transferId} already processed for payout ${existing.id} (status: ${existing.status}). Ignoring webhook for ${payout.id}.`);

          return;

        }

      }



      // STATE MACHINE VALIDATION: Ensure valid state transition

      // Allowed transitions: requested -> processing -> paid

      //                     requested -> pending -> paid

      //                     any -> failed

      const validStatusTransitions: Record<string, string[]> = {

        'requested': ['processing', 'pending', 'paid', 'failed'],

        'pending': ['processing', 'paid', 'failed'],

        'processing': ['paid', 'failed'],

        'paid': [], // Terminal state

        'failed': [], // Terminal state

        'cancelled': [] // Terminal state

      };



      const allowedNextStatuses = validStatusTransitions[payout.status] || [];

      if (event === 'transfer.completed' && data.status === 'SUCCESSFUL') {

        if (!allowedNextStatuses.includes('paid')) {

          console.warn(`⚠️ Invalid state transition for payout ${reference}: ${payout.status} -> paid. Allowed: ${allowedNextStatuses.join(', ')}`);

          // Still process if webhook says successful, but log warning

        }

      }



      if (event === 'transfer.completed' && data.status === 'SUCCESSFUL') {

        // Transfer successful

        // CRITICAL: Extract amounts and currency from webhook data

        // Flutterwave sends: amount (USD), amount_settled (local), currency_settled (local currency)

        const usdAmount = data.amount || payout.freti_amount; // Original USD/FRETI amount

        let localAmount: number;

        let localCurrency: string;

        let exchangeRate: number;



        // Determine local currency and amount from Flutterwave webhook

        // Flutterwave provides currency_settled and amount_settled when conversion occurs

        if (data.currency_settled && data.amount_settled) {

          // Best case: Flutterwave explicitly provides converted currency and amount

          localCurrency = data.currency_settled;

          localAmount = data.amount_settled;

          exchangeRate = localAmount / usdAmount;

          console.log(`✅ Withdrawal webhook: ${usdAmount} USD → ${localAmount} ${localCurrency} (rate: ${exchangeRate.toFixed(4)} ${localCurrency}/USD)`);

        } else if (data.currency && data.currency !== 'USD') {

          // Fallback: currency specified in webhook but no amount_settled

          // This may happen with older webhook formats

          localCurrency = data.currency;

          // Try to get amount_settled from nested data structure

          localAmount = data.amount_settled || data.amount || payout.freti_amount;

          exchangeRate = localAmount / usdAmount;

          console.log(`⚠️ Withdrawal webhook: Using currency from webhook but amount_settled missing. Estimated: ${localAmount} ${localCurrency}`);

          this.logger.warn(`Withdrawal ${reference}: Missing amount_settled in webhook. Using fallback calculation.`, {

            usdAmount,

            localAmount,

            localCurrency,

            webhookData: data,

          });

        } else {

          // Last resort: use payout record estimates

          // This should rarely happen if Flutterwave is properly configured

          localCurrency = payout.local_currency;

          localAmount = payout.estimated_local_amount || payout.freti_amount;

          exchangeRate = localCurrency === 'USD' ? 1.0 : (localAmount / usdAmount);

          console.log(`⚠️ Withdrawal webhook: Using payout record estimates (no conversion data in webhook): ${localAmount} ${localCurrency}`);

          this.logger.warn(`Withdrawal ${reference}: No currency conversion data in webhook. Using payout record estimates.`, {

            usdAmount,

            estimatedLocalAmount: localAmount,

            localCurrency,

            webhookData: data,

          });

        }



        console.log(`✅ Withdrawal successful: ${usdAmount} USD → ${localAmount} ${localCurrency} (rate: ${exchangeRate.toFixed(4)} ${localCurrency}/USD)`);



        // Validate currency matches expected destination currency

        if (localCurrency !== payout.local_currency) {

          this.logger.warn(`⚠️ Currency mismatch in withdrawal ${reference}: Expected ${payout.local_currency}, got ${localCurrency} from webhook`);

          // Still process, but log the discrepancy

        }



        // Check for exchange rate discrepancies and create reconciliation alert if needed

        // Allow small differences due to rate fluctuations, but flag significant discrepancies

        const estimatedAmount = payout.estimated_local_amount || payout.freti_amount;

        const amountDifference = Math.abs(localAmount - estimatedAmount);

        const percentageDifference = estimatedAmount > 0 ? (amountDifference / estimatedAmount) * 100 : 0;

        

        // Flag if difference is > 1% or > $1 equivalent (whichever is larger)

        if (estimatedAmount > 0 && (percentageDifference > 1.0 || amountDifference > 1.0)) {

          // Significant difference between estimated and actual - create reconciliation alert

          this.logger.warn(`⚠️ Exchange rate discrepancy in withdrawal ${reference}:`, {

            estimated: `${estimatedAmount} ${payout.local_currency}`,

            actual: `${localAmount} ${localCurrency}`,

            difference: `${amountDifference} ${localCurrency}`,

            percentageDiff: `${percentageDifference.toFixed(2)}%`,

          });



          await this.reconciliationService.createReconciliationAlert({

            depositId: null, // Not a deposit

            payoutId: reference, // This is a payout/withdrawal

            userId: payout.user_id,

            localAmount: localAmount,

            localCurrency: localCurrency,

            fallbackRateUsed: exchangeRate,

            estimatedFretiAmount: usdAmount,

            alertReason: `Withdrawal amount mismatch: estimated ${estimatedAmount.toFixed(2)} ${payout.local_currency} vs actual ${localAmount.toFixed(2)} ${localCurrency} (${percentageDifference.toFixed(2)}% difference)`,

            metadata: {

              estimatedAmount: estimatedAmount,

              actualAmount: localAmount,

              estimatedCurrency: payout.local_currency,

              actualCurrency: localCurrency,

              exchangeRate,

              exchangeRateEstimated: payout.metadata?.estimated_exchange_rate,

              usdAmount,

              amountDifference,

              percentageDifference,

            },

          });

        }



        // Update payout record with actual amounts and exchange rate

        await this.supabase

          .from('payout_requests')

          .update({

            estimated_local_amount: localAmount,

            local_currency: localCurrency,

            status: 'paid',

            external_payout_id: transferId || payout.external_payout_id, // Use transfer ID if available

            webhook_data: webhookData,

            paid_at: new Date().toISOString(),

            metadata: {

              ...payout.metadata,

              exchange_rate: exchangeRate,

              usd_amount: usdAmount,

              local_amount_actual: localAmount,

              webhook_processed_at: new Date().toISOString(),

            }

          })

          .eq('id', payout.id);



        // Get wallet

        const wallet = await this.getWallet(payout.user_id);



        // Remove funds from pending_withdrawal (burn)

        // Use transfer ID in idempotency key for better deduplication

        const completedIdempotencyKey = `withdrawal_completed_${payout.id}_${transferId || 'webhook'}`;

        await this.createLedgerEntry({

          walletId: wallet.id,

          transactionType: 'withdrawal_burn',

          availableDelta: 0,

          escrowDelta: 0,

          pendingWithdrawalDelta: -payout.freti_amount, // Remove from pending

          referenceType: 'payout_request',

          referenceId: payout.id,

          idempotencyKey: completedIdempotencyKey,

          description: `Withdrawal completed: ₣${payout.freti_amount} FRETI → ${localAmount} ${localCurrency}`,

        }, payout.user_id);



        // Send notification

        await this.notificationHelper.notifySystemUpdate(

          payout.user_id,

          'Withdrawal Successful',

          `Your withdrawal of ₣${payout.freti_amount} FRETI has been processed. ${localAmount} ${localCurrency} has been sent to your bank account.`,

          { payoutId: reference, amount: payout.freti_amount, localAmount, localCurrency, type: 'wallet_withdrawal_completed' }

        );



        const processingTime = Date.now() - startTime;

        console.log(`✅ Withdrawal processed: ${reference} (${processingTime}ms)`);

        

        // Log for audit

        this.logger.log(`Withdrawal completed: ${reference}`, {

          userId: payout.user_id,

          amount: payout.freti_amount,

          localAmount,

          localCurrency,

          processingTime,

        });

      } else if (event === 'transfer.failed' || (event === 'transfer.completed' && data.status !== 'SUCCESSFUL')) {

        // Transfer failed - refund to available balance

        const failureReason = data.complete_message || data.message || 'Transfer failed';

        console.log(`❌ Withdrawal failed: ${reference} - ${failureReason}`);

        

        // Log for audit

        this.logger.warn(`Withdrawal failed: ${reference}`, {

          userId: payout.user_id,

          reason: failureReason,

          webhookData: data,

        });



        // Get wallet

        const wallet = await this.getWallet(payout.user_id);



        // Refund from pending_withdrawal to available_balance

        // Use transfer ID in idempotency key if available for better deduplication

        const refundIdempotencyKey = `withdrawal_refund_${payout.id}_${transferId || 'webhook'}_failed`;

        await this.createLedgerEntry({

          walletId: wallet.id,

          transactionType: 'withdrawal_burn',

          availableDelta: payout.freti_amount, // Refund

          escrowDelta: 0,

          pendingWithdrawalDelta: -payout.freti_amount, // Remove from pending

          referenceType: 'payout_request',

          referenceId: payout.id,

          idempotencyKey: refundIdempotencyKey,

          description: `Withdrawal failed - funds refunded to available balance. Reason: ${failureReason}`,

        }, payout.user_id);



        // Update payout status

        await this.supabase

          .from('payout_requests')

          .update({

            status: 'failed',

            failure_reason: failureReason,

            external_payout_id: transferId || payout.external_payout_id, // Store transfer ID if available

            webhook_data: webhookData,

            metadata: {

              ...payout.metadata,

              webhook_processed_at: new Date().toISOString(),

              failure_reason_details: data.complete_message || data.message || 'Transfer failed',

            }

          })

          .eq('id', payout.id);



        // Send notification

        await this.notificationHelper.notifySystemUpdate(

          payout.user_id,

          'Withdrawal Failed',

          `Your withdrawal of ₣${payout.freti_amount} FRETI could not be processed. Funds have been refunded to your available balance.${failureReason ? ` Reason: ${failureReason}` : ''}`,

          { payoutId: payout.id, amount: payout.freti_amount, type: 'wallet_withdrawal_failed', failureReason }

        );



        console.log(`✅ Withdrawal failed and refunded: ${payout.id} (${failureReason})`);

      }

    } catch (error: any) {

      const processingTime = Date.now() - startTime;

      console.error('❌ Error processing withdrawal webhook:', {

        error: error.message,

        stack: error.stack,

        processingTime,

        event: event || webhookData?.event || webhookData?.type,

        webhookKeys: Object.keys(webhookData || {}),

        dataKeys: data ? Object.keys(data) : [],

      });

      

      // Log for audit

      this.logger.error(`Withdrawal webhook error: ${error.message}`, {

        event: event || webhookData?.event || webhookData?.type,

        reference: data?.reference || data?.reference_id || webhookData?.reference,

        transferId: data?.id || data?.transfer_id || data?.flw_ref,

        error: error.message,

        stack: error.stack,

        processingTime,

        webhookData: JSON.stringify(webhookData, null, 2).substring(0, 500),

      });

      

      throw error;

    }

  }



  // ================================

  // SALES TRACKING & ANALYTICS

  // ================================



  /**

   * Get sales history for a user

   * Returns individual sales/earnings transactions

   */

  async getSalesHistory(

    userId: string,

    type?: 'vendor_sale' | 'rider_delivery',

    limit: number = 50,

    offset: number = 0,

    startDate?: string,

    endDate?: string,

  ) {

    try {

      let query = this.supabase

        .from('sales_ledger')

        .select('*')

        .eq('user_id', userId)

        .order('created_at', { ascending: false });



      // Filter by transaction type if specified

      if (type) {

        query = query.eq('transaction_type', type);

      }



      // Filter by date range if specified

      if (startDate) {

        query = query.gte('created_at', startDate);

      }

      if (endDate) {

        query = query.lte('created_at', endDate);

      }



      // Pagination

      query = query.range(offset, offset + limit - 1);



      const { data, error, count } = await query;



      if (error) {

        console.error('Error fetching sales history:', error);

        throw error;

      }



      // Get order details for each sale

      const salesWithDetails = await Promise.all(

        (data || []).map(async (sale) => {

          let orderDetails: any = null;

          if (sale.order_id) {

            const { data: order } = await this.supabase

              .from('orders')

              .select('order_number, buyer_id, created_at')

              .eq('id', sale.order_id)

              .single();

            orderDetails = order;

          }



          return {

            id: sale.id,

            transactionType: sale.transaction_type,

            amount: parseFloat(sale.amount),

            orderId: sale.order_id,

            orderNumber: orderDetails?.order_number || null,

            vendorSalesAfter: sale.vendor_sales_after ? parseFloat(sale.vendor_sales_after) : 0,

            riderEarningsAfter: sale.rider_earnings_after ? parseFloat(sale.rider_earnings_after) : 0,

            lifetimeRevenueAfter: sale.lifetime_revenue_after ? parseFloat(sale.lifetime_revenue_after) : 0,

            description: sale.description,

            createdAt: sale.created_at,

          };

        })

      );



      return {

        sales: salesWithDetails,

        total: count || salesWithDetails.length,

        limit,

        offset,

      };

    } catch (error) {

      console.error('Error in getSalesHistory:', error);

      throw error;

    }

  }



  /**

   * Get sales analytics (aggregated data for charts/dashboards)

   */

  /**

   * Get wallet transaction history (ledger entries)

   */

  async getTransactionHistory(

    userId: string,

    type?: string,

    limit: number = 50,

    offset: number = 0,

    startDate?: string,

    endDate?: string,

  ) {

    try {

      console.log('🔍 [DEBUG] getTransactionHistory called:', { userId, type, limit, offset });

      

      // Query by user_id instead of wallet_id to catch all transactions

      // (some old transactions may have wallet_id = null due to a previous bug)

      let query = this.supabase

        .from('wallet_ledger')

        .select('*')

        .eq('user_id', userId)

        .order('created_at', { ascending: false });



      // Filter by transaction type if specified

      if (type) {

        console.log(`🔍 [DEBUG] Filtering by transaction type: ${type}`);

        query = query.eq('transaction_type', type);

      }



      // Filter by date range if specified

      if (startDate) {

        query = query.gte('created_at', startDate);

      }

      if (endDate) {

        query = query.lte('created_at', endDate);

      }



      // Pagination

      query = query.range(offset, offset + limit - 1);



      const { data: ledgerData, error } = await query;



      if (error) {

        console.error('❌ [DEBUG] Error fetching transaction history:', error);

        throw error;

      }



      // Also fetch deposits that don't have ledger entries yet (pending/completed but webhook not processed)

      // Only include if type is 'deposit_mint' or no type filter

      if (!type || type === 'deposit_mint') {

        let depositQuery = this.supabase

          .from('deposits')

          .select('*')

          .eq('user_id', userId)

          .in('status', ['pending', 'completed', 'processing'])

          .order('created_at', { ascending: false });



        if (startDate) {

          depositQuery = depositQuery.gte('created_at', startDate);

        }

        if (endDate) {

          depositQuery = depositQuery.lte('created_at', endDate);

        }



        const { data: deposits } = await depositQuery;



        // Check which deposits don't have ledger entries

        if (deposits && deposits.length > 0) {

          const depositIds = deposits.map(d => d.id);

          const { data: existingLedgerEntries } = await this.supabase

            .from('wallet_ledger')

            .select('reference_id')

            .eq('user_id', userId)

            .eq('reference_type', 'deposit')

            .in('reference_id', depositIds);



          const existingDepositIds = new Set(

            (existingLedgerEntries || []).map(e => e.reference_id)

          );



          // Add deposits without ledger entries to the result

          const depositsWithoutLedger = deposits.filter(d => !existingDepositIds.has(d.id));

          

          // Get wallet once for all deposits

          const wallet = await this.getWallet(userId).catch(() => null);

          

          // Convert deposits to transaction format

          const depositTransactions = depositsWithoutLedger.map(deposit => ({

            id: `deposit_${deposit.id}`,

            walletId: wallet?.id || null,

            userId: deposit.user_id,

            transactionType: 'deposit_mint' as const,

            availableDelta: deposit.status === 'completed' ? parseFloat(deposit.freti_amount.toString()) : 0,

            escrowDelta: 0,

            pendingWithdrawalDelta: 0,

            availableBalanceAfter: wallet ? wallet.availableBalance : 0,

            escrowBalanceAfter: wallet ? wallet.escrowBalance : 0,

            pendingWithdrawalAfter: wallet ? wallet.pendingWithdrawal : 0,

            referenceType: 'deposit',

            referenceId: deposit.id,

            description: `Deposit: ${deposit.local_amount} ${deposit.local_currency} → ₣${deposit.freti_amount} FRETI (${deposit.status})`,

            metadata: {

              deposit_status: deposit.status,

              local_amount: deposit.local_amount,

              local_currency: deposit.local_currency,

              external_payment_id: deposit.external_payment_id,

            },

            createdAt: deposit.created_at,

          }));



          // Combine and sort by date

          const allTransactions = [

            ...(ledgerData || []).map((entry) => ({

              id: entry.id,

              walletId: entry.wallet_id,

              userId: entry.user_id,

              transactionType: entry.transaction_type,

              availableDelta: parseFloat(entry.available_delta),

              escrowDelta: parseFloat(entry.escrow_delta),

              pendingWithdrawalDelta: parseFloat(entry.pending_withdrawal_delta),

              availableBalanceAfter: parseFloat(entry.available_balance_after),

              escrowBalanceAfter: parseFloat(entry.escrow_balance_after),

              pendingWithdrawalAfter: parseFloat(entry.pending_withdrawal_after),

              referenceType: entry.reference_type,

              referenceId: entry.reference_id,

              description: entry.description,

              metadata: entry.metadata,

              createdAt: entry.created_at,

            })),

            ...depositTransactions,

          ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());



          // Apply pagination

          const paginated = allTransactions.slice(offset, offset + limit);



          console.log(`✅ [DEBUG] Found ${allTransactions.length} total transactions (${ledgerData?.length || 0} ledger + ${depositTransactions.length} deposits) for user ${userId}${type ? ` (type: ${type})` : ''}`);



          return paginated;

        }

      }



      console.log(`✅ [DEBUG] Found ${ledgerData?.length || 0} transactions for user ${userId}${type ? ` (type: ${type})` : ''}`);

      if (ledgerData && ledgerData.length > 0) {

        console.log('📋 [DEBUG] Sample transaction:', {

          id: ledgerData[0].id,

          transaction_type: ledgerData[0].transaction_type,

          wallet_id: ledgerData[0].wallet_id,

          user_id: ledgerData[0].user_id,

          created_at: ledgerData[0].created_at

        });

      }



      // Map to frontend format

      return (ledgerData || []).map((entry) => ({

        id: entry.id,

        walletId: entry.wallet_id,

        userId: entry.user_id,

        transactionType: entry.transaction_type,

        availableDelta: parseFloat(entry.available_delta),

        escrowDelta: parseFloat(entry.escrow_delta),

        pendingWithdrawalDelta: parseFloat(entry.pending_withdrawal_delta),

        availableBalanceAfter: parseFloat(entry.available_balance_after),

        escrowBalanceAfter: parseFloat(entry.escrow_balance_after),

        pendingWithdrawalAfter: parseFloat(entry.pending_withdrawal_after),

        referenceType: entry.reference_type,

        referenceId: entry.reference_id,

        description: entry.description,

        metadata: entry.metadata,

        createdAt: entry.created_at,

      }));

    } catch (error) {

      console.error('Error in getTransactionHistory:', error);

      throw error;

    }

  }



  async getSalesAnalytics(

    userId: string,

    period: 'daily' | 'weekly' | 'monthly' | 'yearly' = 'daily',

    startDate?: string,

    endDate?: string,

  ) {

    try {

      // Set default date range if not provided

      const end = endDate ? new Date(endDate) : new Date();

      let start: Date;

      

      switch (period) {

        case 'daily':

          start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last 30 days

          break;

        case 'weekly':

          start = startDate ? new Date(startDate) : new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000); // Last 12 weeks

          break;

        case 'monthly':

          start = startDate ? new Date(startDate) : new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000); // Last 12 months

          break;

        case 'yearly':

          start = startDate ? new Date(startDate) : new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000); // Last 5 years

          break;

      }



      // Fetch all sales in the date range

      const { data: sales, error } = await this.supabase

        .from('sales_ledger')

        .select('*')

        .eq('user_id', userId)

        .gte('created_at', start.toISOString())

        .lte('created_at', end.toISOString())

        .order('created_at', { ascending: true });



      if (error) {

        console.error('Error fetching sales for analytics:', error);

        throw error;

      }



      // Aggregate data by period

      const grouped = new Map<string, { vendorSales: number; riderEarnings: number; total: number; count: number }>();



      (sales || []).forEach((sale) => {

        const date = new Date(sale.created_at);

        let key: string;



        switch (period) {

          case 'daily':

            key = date.toISOString().split('T')[0]; // YYYY-MM-DD

            break;

          case 'weekly':

            const weekStart = new Date(date);

            weekStart.setDate(date.getDate() - date.getDay());

            key = weekStart.toISOString().split('T')[0];

            break;

          case 'monthly':

            key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM

            break;

          case 'yearly':

            key = String(date.getFullYear()); // YYYY

            break;

        }



        if (!grouped.has(key)) {

          grouped.set(key, { vendorSales: 0, riderEarnings: 0, total: 0, count: 0 });

        }



        const group = grouped.get(key)!;

        const amount = parseFloat(sale.amount);

        

        if (sale.transaction_type === 'vendor_sale') {

          group.vendorSales += amount;

        } else if (sale.transaction_type === 'rider_delivery') {

          group.riderEarnings += amount;

        }

        

        group.total += amount;

        group.count += 1;

      });



      // Convert to array and sort

      const chartData = Array.from(grouped.entries()).map(([period, data]) => ({

        period,

        vendorSales: data.vendorSales,

        riderEarnings: data.riderEarnings,

        totalRevenue: data.total,

        transactionCount: data.count,

      }));



      // Calculate summary statistics

      const totalVendorSales = chartData.reduce((sum, d) => sum + d.vendorSales, 0);

      const totalRiderEarnings = chartData.reduce((sum, d) => sum + d.riderEarnings, 0);

      const totalRevenue = totalVendorSales + totalRiderEarnings;

      const totalTransactions = chartData.reduce((sum, d) => sum + d.transactionCount, 0);



      return {

        summary: {

          totalVendorSales,

          totalRiderEarnings,

          totalRevenue,

          totalTransactions,

          averagePerTransaction: totalTransactions > 0 ? totalRevenue / totalTransactions : 0,

          period,

          startDate: start.toISOString(),

          endDate: end.toISOString(),

        },

        chartData,

      };

    } catch (error) {

      console.error('Error in getSalesAnalytics:', error);

      throw error;

    }

  }

}