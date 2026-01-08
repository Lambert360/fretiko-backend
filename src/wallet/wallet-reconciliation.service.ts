import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { WalletService } from './wallet.service';
import { WalletTransactionType } from './constants/transaction-types';

export interface WalletBalanceDiscrepancy {
  walletId: string;
  userId: string;
  availableBalanceStored: number;
  availableBalanceCalculated: number;
  escrowBalanceStored: number;
  escrowBalanceCalculated: number;
  pendingWithdrawalStored: number;
  pendingWithdrawalCalculated: number;
  availableDiscrepancy: number;
  escrowDiscrepancy: number;
  pendingDiscrepancy: number;
  totalDiscrepancy: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  lastLedgerEntryId?: string;
  lastLedgerEntryDate?: string;
}

export interface EscrowReconciliationDiscrepancy {
  userId: string;
  walletId: string;
  walletEscrowBalance: number;
  expectedEscrowBalance: number; // Sum of held escrows
  discrepancy: number;
  escrowCount: number;
  escrowIds: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface EscrowReconciliationReport {
  timestamp: string;
  totalUsersChecked: number;
  usersWithDiscrepancies: number;
  totalDiscrepancies: EscrowReconciliationDiscrepancy[];
  criticalDiscrepancies: EscrowReconciliationDiscrepancy[];
  failedUsers?: Array<{ userId: string; walletId?: string; error: string }>; // ✅ BUG FIX: Track failed reconciliations
  summary: {
    totalDiscrepancy: number;
    maxDiscrepancy: number;
    totalEscrowAmount: number;
    totalWalletEscrowBalance: number;
  };
}

export interface ReconciliationReport {
  timestamp: string;
  totalWalletsChecked: number;
  walletsWithDiscrepancies: number;
  totalDiscrepancies: WalletBalanceDiscrepancy[];
  criticalDiscrepancies: WalletBalanceDiscrepancy[];
  failedWallets?: Array<{ walletId: string; userId?: string; error: string }>; // ✅ BUG FIX: Track failed reconciliations
  summary: {
    totalAvailableDiscrepancy: number;
    totalEscrowDiscrepancy: number;
    totalPendingDiscrepancy: number;
    maxDiscrepancy: number;
  };
}

/**
 * Wallet Balance Reconciliation Service
 * 
 * Periodically verifies that wallet balances match the sum of ledger entries.
 * Detects discrepancies that could indicate bugs, race conditions, or data corruption.
 */
@Injectable()
export class WalletReconciliationService {
  private readonly logger = new Logger(WalletReconciliationService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => WalletService))
    private walletService?: WalletService
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Calculate wallet balances from ledger entries
   * This is the source of truth - ledger is immutable
   * Uses SQL aggregation for accuracy and performance
   */
  private async calculateBalancesFromLedger(walletId: string): Promise<{
    availableBalance: number;
    escrowBalance: number;
    pendingWithdrawal: number;
  }> {
    // Try to use SQL aggregation function for better performance
    try {
      const { data: aggregated, error } = await this.supabase.rpc('calculate_wallet_balances_from_ledger', {
        p_wallet_id: walletId
      });

      if (!error && aggregated && aggregated.length > 0) {
        const result = aggregated[0];
        return {
          availableBalance: parseFloat(result.available_balance || '0'),
          escrowBalance: parseFloat(result.escrow_balance || '0'),
          pendingWithdrawal: parseFloat(result.pending_withdrawal || '0'),
        };
      }
    } catch (rpcError: any) {
      // RPC function might not exist yet, fallback to application calculation
      this.logger.debug(`RPC function not available, using application-level calculation for wallet ${walletId}`);
    }

    // Fallback to application-level calculation
    const { data: ledgerEntries, error: ledgerError } = await this.supabase
      .from('wallet_ledger')
      .select('available_delta, escrow_delta, pending_withdrawal_delta')
      .eq('wallet_id', walletId);

    if (ledgerError) {
      this.logger.error(`Error fetching ledger entries for wallet ${walletId}:`, ledgerError);
      throw ledgerError;
    }

    // Sum all deltas to get current balances
    const calculated = {
      availableBalance: 0,
      escrowBalance: 0,
      pendingWithdrawal: 0,
    };

    if (ledgerEntries && ledgerEntries.length > 0) {
      ledgerEntries.forEach((entry: any) => {
        calculated.availableBalance += parseFloat(entry.available_delta) || 0;
        calculated.escrowBalance += parseFloat(entry.escrow_delta) || 0;
        calculated.pendingWithdrawal += parseFloat(entry.pending_withdrawal_delta) || 0;
      });
    }

    return calculated;
  }

  /**
   * Reconcile a single wallet's balances
   */
  async reconcileWallet(walletId: string): Promise<WalletBalanceDiscrepancy | null> {
    try {
      // Get stored wallet balances
      const { data: wallet, error: walletError } = await this.supabase
        .from('wallets')
        .select('id, user_id, available_balance, escrow_balance, pending_withdrawal')
        .eq('id', walletId)
        .single();

      if (walletError || !wallet) {
        this.logger.error(`Wallet ${walletId} not found:`, walletError);
        return null;
      }

      // Calculate balances from ledger (source of truth)
      const calculated = await this.calculateBalancesFromLedger(walletId);

      // Get last ledger entry for reference
      const { data: lastEntry } = await this.supabase
        .from('wallet_ledger')
        .select('id, created_at, available_balance_after, escrow_balance_after, pending_withdrawal_after')
        .eq('wallet_id', walletId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // Compare stored vs calculated
      const stored = {
        available: parseFloat(wallet.available_balance) || 0,
        escrow: parseFloat(wallet.escrow_balance) || 0,
        pending: parseFloat(wallet.pending_withdrawal) || 0,
      };

      const discrepancies = {
        available: calculated.availableBalance - stored.available,
        escrow: calculated.escrowBalance - stored.escrow,
        pending: calculated.pendingWithdrawal - stored.pending,
      };

      const totalDiscrepancy = Math.abs(discrepancies.available) + 
                              Math.abs(discrepancies.escrow) + 
                              Math.abs(discrepancies.pending);

      // Determine severity
      let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
      if (totalDiscrepancy === 0) {
        // No discrepancy - return null
        return null;
      } else if (totalDiscrepancy < 0.01) {
        severity = 'low'; // Tiny rounding differences
      } else if (totalDiscrepancy < 1.0) {
        severity = 'medium';
      } else if (totalDiscrepancy < 10.0) {
        severity = 'high';
      } else {
        severity = 'critical';
      }

      return {
        walletId: wallet.id,
        userId: wallet.user_id,
        availableBalanceStored: stored.available,
        availableBalanceCalculated: calculated.availableBalance,
        escrowBalanceStored: stored.escrow,
        escrowBalanceCalculated: calculated.escrowBalance,
        pendingWithdrawalStored: stored.pending,
        pendingWithdrawalCalculated: calculated.pendingWithdrawal,
        availableDiscrepancy: discrepancies.available,
        escrowDiscrepancy: discrepancies.escrow,
        pendingDiscrepancy: discrepancies.pending,
        totalDiscrepancy,
        severity,
        lastLedgerEntryId: lastEntry?.id,
        lastLedgerEntryDate: lastEntry?.created_at,
      };
    } catch (error: any) {
      this.logger.error(`Error reconciling wallet ${walletId}:`, error);
      throw error;
    }
  }

  /**
   * Reconcile all wallets in the system
   */
  async reconcileAllWallets(): Promise<ReconciliationReport> {
    const startTime = Date.now();
    this.logger.log('🔄 Starting wallet balance reconciliation...');

    try {
      // Get all wallets
      const { data: wallets, error: walletsError } = await this.supabase
        .from('wallets')
        .select('id, user_id')
        .order('created_at', { ascending: false });

      if (walletsError) {
        throw new Error(`Failed to fetch wallets: ${walletsError.message}`);
      }

      const totalWallets = wallets?.length || 0;
      const discrepancies: WalletBalanceDiscrepancy[] = [];
      const criticalDiscrepancies: WalletBalanceDiscrepancy[] = [];
      const failedWallets: Array<{ walletId: string; userId?: string; error: string }> = []; // ✅ BUG FIX: Track failed reconciliations

      // Reconcile each wallet
      for (const wallet of wallets || []) {
        try {
          const discrepancy = await this.reconcileWallet(wallet.id);
          if (discrepancy) {
            discrepancies.push(discrepancy);
            if (discrepancy.severity === 'critical' || discrepancy.severity === 'high') {
              criticalDiscrepancies.push(discrepancy);
            }
          }
        } catch (error: any) {
          const errorMsg = error.message || error.toString() || 'Unknown error';
          this.logger.error(`Failed to reconcile wallet ${wallet.id} (user: ${wallet.user_id}):`, errorMsg);
          // ✅ BUG FIX: Track failed wallets for visibility in report
          failedWallets.push({
            walletId: wallet.id,
            userId: wallet.user_id,
            error: errorMsg,
          });
          // Continue with other wallets
        }
      }

      // Calculate summary
      const summary = {
        totalAvailableDiscrepancy: discrepancies.reduce((sum, d) => sum + Math.abs(d.availableDiscrepancy), 0),
        totalEscrowDiscrepancy: discrepancies.reduce((sum, d) => sum + Math.abs(d.escrowDiscrepancy), 0),
        totalPendingDiscrepancy: discrepancies.reduce((sum, d) => sum + Math.abs(d.pendingDiscrepancy), 0),
        maxDiscrepancy: discrepancies.length > 0 
          ? Math.max(...discrepancies.map(d => d.totalDiscrepancy))
          : 0,
      };

      const report: ReconciliationReport = {
        timestamp: new Date().toISOString(),
        totalWalletsChecked: totalWallets,
        walletsWithDiscrepancies: discrepancies.length,
        totalDiscrepancies: discrepancies,
        criticalDiscrepancies,
        failedWallets: failedWallets.length > 0 ? failedWallets : undefined, // ✅ BUG FIX: Include failed wallets in report
        summary,
      };

      const duration = Date.now() - startTime;
      const failedCount = failedWallets.length;
      this.logger.log(
        `✅ Reconciliation complete: ${discrepancies.length}/${totalWallets} wallets with discrepancies ` +
        `(${criticalDiscrepancies.length} critical/high)${failedCount > 0 ? `, ${failedCount} failed` : ''} in ${duration}ms`
      );

      // ✅ BUG FIX: Log failed wallets for visibility
      if (failedWallets.length > 0) {
        this.logger.warn(
          `⚠️ ${failedWallets.length} wallet(s) failed to reconcile:`,
          failedWallets.map(f => `Wallet ${f.walletId} (User: ${f.userId}): ${f.error}`).join('; ')
        );
      }

      // Log critical discrepancies
      if (criticalDiscrepancies.length > 0) {
        this.logger.error(
          `⚠️ CRITICAL: Found ${criticalDiscrepancies.length} wallets with high/critical discrepancies:`
        );
        criticalDiscrepancies.forEach(d => {
          this.logger.error(
            `  Wallet ${d.walletId} (User ${d.userId}): ` +
            `Total discrepancy: ${d.totalDiscrepancy.toFixed(6)} FRETI ` +
            `(Available: ${d.availableDiscrepancy.toFixed(6)}, ` +
            `Escrow: ${d.escrowDiscrepancy.toFixed(6)}, ` +
            `Pending: ${d.pendingDiscrepancy.toFixed(6)})`
          );
        });
      }

      // Store report in database for audit trail
      await this.storeReconciliationReport(report);

      return report;
    } catch (error: any) {
      this.logger.error('Fatal error during reconciliation:', error);
      throw error;
    }
  }

  /**
   * Store reconciliation report in database for audit trail
   * ✅ BUG FIX: Added retry logic and better error handling/alerting
   */
  private async storeReconciliationReport(report: ReconciliationReport): Promise<void> {
    // Only store report if there are discrepancies to alert about
    if (report.walletsWithDiscrepancies === 0) {
      return; // No discrepancies, nothing to store
    }

    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Use first discrepancy user_id, or a placeholder for system-level reports
        const reportUserId = report.totalDiscrepancies.length > 0 
          ? report.totalDiscrepancies[0].userId 
          : '00000000-0000-0000-0000-000000000000'; // System placeholder

        const { error } = await this.supabase
          .from('reconciliation_alerts')
          .insert({
            alert_type: 'balance_reconciliation',
            alert_severity: report.criticalDiscrepancies.length > 0 ? 'critical' : 'medium',
            alert_reason: `Periodic balance reconciliation: ${report.walletsWithDiscrepancies}/${report.totalWalletsChecked} wallets with discrepancies`,
            status: 'pending',
            user_id: reportUserId,
            local_amount: 0,
            local_currency: 'USD',
            metadata: {
              report,
              totalWalletsChecked: report.totalWalletsChecked,
              walletsWithDiscrepancies: report.walletsWithDiscrepancies,
              criticalCount: report.criticalDiscrepancies.length,
              summary: report.summary,
              reconciliationTimestamp: report.timestamp,
            },
          });

        if (error) {
          throw error;
        }

        // Success
        if (attempt > 0) {
          this.logger.log(`✅ Successfully stored reconciliation report after ${attempt} retries`);
        }
        return;
      } catch (error: any) {
        lastError = error;
        const errorMsg = error.message || 'Unknown error';
        
        if (attempt < maxRetries - 1) {
          // Retry with exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt), 4000);
          this.logger.warn(
            `Failed to store reconciliation report (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms:`,
            errorMsg
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed - log critical error
    this.logger.error(
      `❌ CRITICAL: Failed to store reconciliation report after ${maxRetries} attempts. ` +
      `Report data may be lost. Error:`,
      lastError
    );
    this.logger.error(
      `Report summary: ${report.walletsWithDiscrepancies}/${report.totalWalletsChecked} wallets with discrepancies, ` +
      `${report.criticalDiscrepancies.length} critical/high`
    );
    // TODO: Send alert to admin team via notification service
  }

  /**
   * Auto-correct minor discrepancies (low severity only)
   * ✅ BUG FIX: Directly updates stored balance without creating ledger entry
   * This prevents reconciliation loops where the adjustment entry would be included
   * in the next reconciliation calculation, causing the discrepancy to persist
   */
  async autoCorrectDiscrepancy(discrepancy: WalletBalanceDiscrepancy): Promise<boolean> {
    // Only auto-correct low severity discrepancies (likely rounding errors)
    if (discrepancy.severity !== 'low') {
      this.logger.warn(
        `Cannot auto-correct ${discrepancy.severity} severity discrepancy for wallet ${discrepancy.walletId}`
      );
      return false;
    }

    try {
      // Calculate deltas needed to reach target balances
      const availableDelta = discrepancy.availableDiscrepancy;
      const escrowDelta = discrepancy.escrowDiscrepancy;
      const pendingDelta = discrepancy.pendingDiscrepancy;

      let correctionsApplied = 0;

      // ✅ BUG FIX: Directly update stored balance to match calculated balance
      // We don't create a ledger entry because:
      // 1. The calculated balance is the source of truth (sum of all ledger entries)
      // 2. Creating an adjustment entry would be included in the next reconciliation
      // 3. This would cause a reconciliation loop where the discrepancy persists
      // Instead, we sync the stored balance to match the calculated balance
      if (Math.abs(availableDelta) > 0.000001) {
        const { error } = await this.supabase
          .from('wallets')
          .update({
            available_balance: discrepancy.availableBalanceCalculated,
            updated_at: new Date().toISOString(),
          })
          .eq('id', discrepancy.walletId);

        if (!error) {
          correctionsApplied++;
          this.logger.debug(`Corrected available balance by ${availableDelta.toFixed(6)}`);
        } else {
          this.logger.error(`Failed to correct available balance: ${error.message}`);
        }
      }

      // Note: Escrow and pending corrections are more complex because:
      // 1. There's no direct transaction type for adjusting these balances
      // 2. Escrow should match held escrows (handled by escrow reconciliation)
      // 3. Pending withdrawals are managed through withdrawal flow
      // For low-severity discrepancies, we'll only auto-correct available balance
      // and log escrow/pending discrepancies for manual review
      if (Math.abs(escrowDelta) > 0.000001 || Math.abs(pendingDelta) > 0.000001) {
        this.logger.warn(
          `Escrow/Pending discrepancies detected but not auto-corrected: ` +
          `Escrow: ${escrowDelta.toFixed(6)}, Pending: ${pendingDelta.toFixed(6)}. ` +
          `These require manual review or specialized correction logic.`
        );
      }

      if (correctionsApplied === 0 && Math.abs(availableDelta) > 0.000001) {
        this.logger.error(`Failed to apply any corrections for wallet ${discrepancy.walletId}`);
        return false;
      }

      this.logger.log(
        `✅ Auto-corrected low-severity discrepancy for wallet ${discrepancy.walletId}: ` +
        `Available: ${availableDelta.toFixed(6)}, ` +
        `Escrow: ${escrowDelta.toFixed(6)} (not auto-corrected), ` +
        `Pending: ${pendingDelta.toFixed(6)} (not auto-corrected)`
      );

      // ✅ BUG FIX: Invalidate cache after correction
      if (this.walletService) {
        this.walletService.invalidateWalletCache(discrepancy.userId);
      }

      // Log correction in reconciliation_alerts
      await this.supabase
        .from('reconciliation_alerts')
        .insert({
          user_id: discrepancy.userId,
          alert_type: 'balance_correction',
          alert_severity: 'low',
          alert_reason: `Auto-corrected low-severity balance discrepancy (Available balance only)`,
          status: 'resolved',
          local_amount: 0,
          local_currency: 'USD',
          metadata: {
            walletId: discrepancy.walletId,
            discrepancy,
            correctionsApplied,
            correctedAt: new Date().toISOString(),
            autoCorrected: true,
            note: 'Only available balance was auto-corrected. Escrow and pending require manual review.',
          },
        });

      return correctionsApplied > 0;
    } catch (error: any) {
      this.logger.error(`Error auto-correcting discrepancy for wallet ${discrepancy.walletId}:`, error);
      return false;
    }
  }

  /**
   * Scheduled job: Run balance reconciliation daily at 2 AM UTC
   * Use @Cron decorator from @nestjs/schedule
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'wallet-balance-reconciliation',
    timeZone: 'UTC',
  })
  async scheduledReconciliation(): Promise<void> {
    this.logger.log('⏰ Scheduled wallet balance reconciliation starting...');
    try {
      const report = await this.reconcileAllWallets();

      // Auto-correct low severity discrepancies
      const lowSeverityDiscrepancies = report.totalDiscrepancies.filter(d => d.severity === 'low');
      let corrected = 0;
      for (const discrepancy of lowSeverityDiscrepancies) {
        if (await this.autoCorrectDiscrepancy(discrepancy)) {
          corrected++;
        }
      }

      if (corrected > 0) {
        this.logger.log(`✅ Auto-corrected ${corrected} low-severity discrepancies`);
      }

      // Alert finance team if critical discrepancies found
      if (report.criticalDiscrepancies.length > 0) {
        this.logger.error(
          `🚨 ALERT: ${report.criticalDiscrepancies.length} critical/high discrepancies require manual review!`
        );
        // TODO: Send notification to finance team (email, Slack, etc.)
      }
    } catch (error: any) {
      this.logger.error('Scheduled reconciliation failed:', error);
      // TODO: Send alert to admin team
    }
  }

  /**
   * Manual trigger for reconciliation (can be called from admin endpoint)
   */
  async triggerReconciliation(): Promise<ReconciliationReport> {
    this.logger.log('🔧 Manual reconciliation triggered');
    return await this.reconcileAllWallets();
  }

  /**
   * Reconcile specific user's wallet (for troubleshooting)
   */
  async reconcileUserWallet(userId: string): Promise<WalletBalanceDiscrepancy | null> {
    try {
      const { data: wallet } = await this.supabase
        .from('wallets')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (!wallet) {
        throw new Error(`Wallet not found for user ${userId}`);
      }

      return await this.reconcileWallet(wallet.id);
    } catch (error: any) {
      this.logger.error(`Error reconciling user wallet ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Reconcile escrow balances: Verify wallets.escrow_balance matches sum of held escrows
   * This checks that the wallet's escrow balance equals the sum of all escrows where:
   * - The escrow's order has buyer_id = wallet.user_id
   * - The escrow status = 'held'
   */
  async reconcileEscrowBalances(): Promise<EscrowReconciliationReport> {
    const startTime = Date.now();
    this.logger.log('🔄 Starting escrow balance reconciliation...');

    try {
      // Get all users with non-zero escrow balance
      const { data: wallets, error: walletsError } = await this.supabase
        .from('wallets')
        .select('id, user_id, escrow_balance')
        .gt('escrow_balance', 0);

      if (walletsError) {
        throw new Error(`Failed to fetch wallets: ${walletsError.message}`);
      }

      const totalUsersChecked = wallets?.length || 0;
      const discrepancies: EscrowReconciliationDiscrepancy[] = [];
      const criticalDiscrepancies: EscrowReconciliationDiscrepancy[] = [];

      // Also check users who have held escrows but zero wallet escrow balance (potential issue)
      // Get all held escrows and their associated orders
      // ✅ BUG FIX: Include 'dispute' status escrows (they're still held, just disputed)
      const { data: heldEscrows, error: escrowsError } = await this.supabase
        .from('escrows')
        .select(`
          id,
          order_id,
          total_amount,
          orders!inner (
            buyer_id
          )
        `)
        .in('status', ['held', 'dispute']); // ✅ BUG FIX: Include disputed escrows

      if (!escrowsError && heldEscrows) {
        // Get unique buyer IDs from held escrows
        const userIdsWithEscrows = new Set(
          heldEscrows
            .map((e: any) => e.orders?.buyer_id)
            .filter(Boolean)
        );

        // Add users with escrows but no wallet escrow balance
        for (const userId of userIdsWithEscrows) {
          const hasWallet = wallets?.some(w => w.user_id === userId);
          if (!hasWallet) {
            // User has escrow but no wallet or zero escrow balance - check wallet
            const { data: wallet } = await this.supabase
              .from('wallets')
              .select('id, user_id, escrow_balance')
              .eq('user_id', userId)
              .single();

            if (wallet && parseFloat(wallet.escrow_balance || '0') === 0) {
              // User has escrows but zero wallet escrow balance - this is a discrepancy
              wallets?.push(wallet);
            }
          }
        }
      }

      // Reconcile each user's escrow balance
      const failedUsers: Array<{ userId: string; walletId?: string; error: string }> = []; // ✅ BUG FIX: Track failed reconciliations
      for (const wallet of wallets || []) {
        try {
          let orderIds: string[] = [];
          let escrows: any[] = [];
          let querySucceeded = false;

          // Get all held escrows for orders where this user is the buyer
          // First, get order IDs where user is buyer
          const { data: userOrders, error: ordersError } = await this.supabase
            .from('orders')
            .select('id')
            .eq('buyer_id', wallet.user_id);

          if (ordersError) {
            this.logger.error(`Error fetching orders for user ${wallet.user_id}:`, ordersError);
            // ✅ BUG FIX: Try fallback query - get escrows directly via join
            // This allows reconciliation even if order query fails
            this.logger.warn(`Attempting fallback escrow query for user ${wallet.user_id}`);
            const { data: fallbackEscrows, error: fallbackError } = await this.supabase
              .from('escrows')
              .select(`
                id,
                total_amount,
                status,
                order_id,
                orders!inner (
                  buyer_id
                )
              `)
              .in('status', ['held', 'dispute']) // ✅ BUG FIX: Include disputed escrows
              .eq('orders.buyer_id', wallet.user_id);

            if (fallbackError) {
              this.logger.error(`Fallback escrow query also failed for user ${wallet.user_id}:`, fallbackError);
              // Still check if user has escrow balance - flag as potential issue
              const actualBalance = parseFloat(wallet.escrow_balance || '0');
              if (actualBalance > 0.000001) {
                // User has escrow balance but we couldn't verify - flag for manual review
                const discrepancyRecord: EscrowReconciliationDiscrepancy = {
                  userId: wallet.user_id,
                  walletId: wallet.id,
                  walletEscrowBalance: actualBalance,
                  expectedEscrowBalance: 0, // Unknown due to query error
                  discrepancy: actualBalance,
                  escrowCount: 0,
                  escrowIds: [],
                  severity: 'high', // High severity because we couldn't verify
                };
                discrepancies.push(discrepancyRecord);
                criticalDiscrepancies.push(discrepancyRecord);
              }
              continue; // Skip to next user
            } else {
              escrows = fallbackEscrows || [];
              querySucceeded = true;
            }
          } else {
            orderIds = userOrders?.map(o => o.id) || [];
            querySucceeded = true;
          }

          // If we have order IDs, fetch escrows normally
          // ✅ BUG FIX: Guard against empty orderIds array (Supabase .in() may fail on empty arrays)
          // ✅ BUG FIX: Also check for escrows in 'dispute' status (they're still held)
          if (querySucceeded && orderIds.length > 0 && escrows.length === 0) {
            const { data: fetchedEscrows, error: escrowsError } = await this.supabase
              .from('escrows')
              .select('id, total_amount, status')
              .in('status', ['held', 'dispute']) // ✅ BUG FIX: Include disputed escrows (still held)
              .in('order_id', orderIds);

            if (escrowsError) {
              this.logger.error(`Error fetching escrows for user ${wallet.user_id}:`, escrowsError);
              // ✅ BUG FIX: Still reconcile with available data (zero escrows)
              // This ensures user is not skipped
              escrows = [];
            } else {
              escrows = fetchedEscrows || [];
            }
          } else if (querySucceeded && orderIds.length === 0 && escrows.length === 0) {
            // ✅ BUG FIX: Explicitly handle case where orderIds is empty
            // This prevents potential issues with .in() on empty arrays
            escrows = [];
          }

          // If no orders found, expected escrow balance should be 0
          if (orderIds.length === 0 && escrows.length === 0) {
            // User has no orders, so expected escrow balance should be 0
            const actualBalance = parseFloat(wallet.escrow_balance || '0');
            if (actualBalance > 0.000001) {
              // Discrepancy: user has escrow balance but no orders
              const discrepancyRecord: EscrowReconciliationDiscrepancy = {
                userId: wallet.user_id,
                walletId: wallet.id,
                walletEscrowBalance: actualBalance,
                expectedEscrowBalance: 0,
                discrepancy: actualBalance,
                escrowCount: 0,
                escrowIds: [],
                severity: actualBalance < 1.0 ? 'medium' : actualBalance < 10.0 ? 'high' : 'critical',
              };
              discrepancies.push(discrepancyRecord);
              if (discrepancyRecord.severity === 'critical' || discrepancyRecord.severity === 'high') {
                criticalDiscrepancies.push(discrepancyRecord);
              }
            }
            continue;
          }

          // Calculate expected escrow balance (sum of all held escrows)
          // ✅ BUG FIX: Handle null/undefined/NaN values in escrow amounts
          const expectedBalance = (escrows || []).reduce(
            (sum, e) => {
              const amount = parseFloat(e?.total_amount || '0');
              // Guard against NaN or invalid numbers
              if (isNaN(amount) || !isFinite(amount)) {
                this.logger.warn(
                  `Invalid escrow amount for escrow ${e?.id || 'unknown'}: ${e?.total_amount}. Using 0.`
                );
                return sum;
              }
              return sum + amount;
            },
            0
          );

          const actualBalance = parseFloat(wallet.escrow_balance || '0');
          const discrepancy = actualBalance - expectedBalance;
          const absDiscrepancy = Math.abs(discrepancy);

          // Only flag if discrepancy is significant (account for floating point precision)
          if (absDiscrepancy > 0.000001) {
            // Determine severity
            let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
            if (absDiscrepancy < 0.01) {
              severity = 'low'; // Tiny rounding differences
            } else if (absDiscrepancy < 1.0) {
              severity = 'medium';
            } else if (absDiscrepancy < 10.0) {
              severity = 'high';
            } else {
              severity = 'critical';
            }

            const discrepancyRecord: EscrowReconciliationDiscrepancy = {
              userId: wallet.user_id,
              walletId: wallet.id,
              walletEscrowBalance: actualBalance,
              expectedEscrowBalance: expectedBalance,
              discrepancy,
              escrowCount: escrows?.length || 0,
              escrowIds: escrows?.map(e => e.id) || [],
              severity,
            };

            discrepancies.push(discrepancyRecord);

            if (severity === 'critical' || severity === 'high') {
              criticalDiscrepancies.push(discrepancyRecord);
            }
          }
        } catch (error: any) {
          const errorMsg = error.message || error.toString() || 'Unknown error';
          this.logger.error(`Failed to reconcile escrow for user ${wallet.user_id} (wallet: ${wallet.id}):`, errorMsg);
          // ✅ BUG FIX: Track failed users for visibility in report
          failedUsers.push({
            userId: wallet.user_id,
            walletId: wallet.id,
            error: errorMsg,
          });
          // Continue with other users
        }
      }

      // Calculate summary
      const totalEscrowAmount = discrepancies.reduce(
        (sum, d) => sum + d.expectedEscrowBalance,
        0
      );
      const totalWalletEscrowBalance = discrepancies.reduce(
        (sum, d) => sum + d.walletEscrowBalance,
        0
      );
      const totalDiscrepancy = discrepancies.reduce(
        (sum, d) => sum + Math.abs(d.discrepancy),
        0
      );

      const report: EscrowReconciliationReport = {
        timestamp: new Date().toISOString(),
        totalUsersChecked,
        usersWithDiscrepancies: discrepancies.length,
        totalDiscrepancies: discrepancies,
        criticalDiscrepancies,
        failedUsers: failedUsers.length > 0 ? failedUsers : undefined, // ✅ BUG FIX: Include failed users in report
        summary: {
          totalDiscrepancy,
          maxDiscrepancy: discrepancies.length > 0
            ? Math.max(...discrepancies.map(d => Math.abs(d.discrepancy)))
            : 0,
          totalEscrowAmount,
          totalWalletEscrowBalance,
        },
      };

      const duration = Date.now() - startTime;
      const failedCount = failedUsers.length;
      this.logger.log(
        `✅ Escrow reconciliation complete: ${discrepancies.length}/${totalUsersChecked} users with discrepancies ` +
        `(${criticalDiscrepancies.length} critical/high)${failedCount > 0 ? `, ${failedCount} failed` : ''} in ${duration}ms`
      );

      // ✅ BUG FIX: Log failed users for visibility
      if (failedUsers.length > 0) {
        this.logger.warn(
          `⚠️ ${failedUsers.length} user(s) failed to reconcile:`,
          failedUsers.map(f => `User ${f.userId} (Wallet: ${f.walletId}): ${f.error}`).join('; ')
        );
      }

      // Log critical discrepancies
      if (criticalDiscrepancies.length > 0) {
        this.logger.error(
          `⚠️ CRITICAL: Found ${criticalDiscrepancies.length} users with high/critical escrow discrepancies:`
        );
        criticalDiscrepancies.forEach(d => {
          this.logger.error(
            `  User ${d.userId} (Wallet ${d.walletId}): ` +
            `Discrepancy: ${d.discrepancy.toFixed(6)} FRETI ` +
            `(Wallet: ${d.walletEscrowBalance.toFixed(6)}, Expected: ${d.expectedEscrowBalance.toFixed(6)}, ` +
            `Escrows: ${d.escrowCount})`
          );
        });
      }

      // Store report in database for audit trail
      await this.storeEscrowReconciliationReport(report);

      return report;
    } catch (error: any) {
      this.logger.error('Fatal error during escrow reconciliation:', error);
      throw error;
    }
  }

  /**
   * Store escrow reconciliation report in database for audit trail
   * ✅ BUG FIX: Added retry logic and better error handling/alerting
   */
  private async storeEscrowReconciliationReport(report: EscrowReconciliationReport): Promise<void> {
    // Only store report if there are discrepancies to alert about
    if (report.usersWithDiscrepancies === 0) {
      return; // No discrepancies, nothing to store
    }

    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const reportUserId = report.totalDiscrepancies.length > 0
          ? report.totalDiscrepancies[0].userId
          : '00000000-0000-0000-0000-000000000000'; // System placeholder

        const { error } = await this.supabase
          .from('reconciliation_alerts')
          .insert({
            alert_type: 'escrow_reconciliation',
            alert_severity: report.criticalDiscrepancies.length > 0 ? 'critical' : 'medium',
            alert_reason: `Escrow balance reconciliation: ${report.usersWithDiscrepancies}/${report.totalUsersChecked} users with discrepancies`,
            status: 'pending',
            user_id: reportUserId,
            local_amount: 0,
            local_currency: 'USD',
            metadata: {
              report,
              totalUsersChecked: report.totalUsersChecked,
              usersWithDiscrepancies: report.usersWithDiscrepancies,
              criticalCount: report.criticalDiscrepancies.length,
              summary: report.summary,
              reconciliationTimestamp: report.timestamp,
            },
          });

        if (error) {
          throw error;
        }

        // Success
        if (attempt > 0) {
          this.logger.log(`✅ Successfully stored escrow reconciliation report after ${attempt} retries`);
        }
        return;
      } catch (error: any) {
        lastError = error;
        const errorMsg = error.message || 'Unknown error';
        
        if (attempt < maxRetries - 1) {
          // Retry with exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt), 4000);
          this.logger.warn(
            `Failed to store escrow reconciliation report (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms:`,
            errorMsg
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed - log critical error
    this.logger.error(
      `❌ CRITICAL: Failed to store escrow reconciliation report after ${maxRetries} attempts. ` +
      `Report data may be lost. Error:`,
      lastError
    );
    this.logger.error(
      `Report summary: ${report.usersWithDiscrepancies}/${report.totalUsersChecked} users with discrepancies, ` +
      `${report.criticalDiscrepancies.length} critical/high`
    );
    // TODO: Send alert to admin team via notification service
  }

  /**
   * Scheduled job: Run escrow reconciliation daily at 3 AM UTC (after wallet reconciliation)
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'escrow-balance-reconciliation',
    timeZone: 'UTC',
  })
  async scheduledEscrowReconciliation(): Promise<void> {
    this.logger.log('⏰ Scheduled escrow balance reconciliation starting...');
    try {
      const report = await this.reconcileEscrowBalances();

      // Alert finance team if critical discrepancies found
      if (report.criticalDiscrepancies.length > 0) {
        this.logger.error(
          `🚨 ALERT: ${report.criticalDiscrepancies.length} critical/high escrow discrepancies require manual review!`
        );
        // TODO: Send notification to finance team (email, Slack, etc.)
      }
    } catch (error: any) {
      this.logger.error('Scheduled escrow reconciliation failed:', error);
      // TODO: Send alert to admin team
    }
  }

  /**
   * Manual trigger for escrow reconciliation (can be called from admin endpoint)
   */
  async triggerEscrowReconciliation(): Promise<EscrowReconciliationReport> {
    this.logger.log('🔧 Manual escrow reconciliation triggered');
    return await this.reconcileEscrowBalances();
  }
}

