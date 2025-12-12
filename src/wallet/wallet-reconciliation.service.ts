import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createServiceSupabaseClient } from '../shared/supabase.client';

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

export interface ReconciliationReport {
  timestamp: string;
  totalWalletsChecked: number;
  walletsWithDiscrepancies: number;
  totalDiscrepancies: WalletBalanceDiscrepancy[];
  criticalDiscrepancies: WalletBalanceDiscrepancy[];
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

  constructor(private configService: ConfigService) {
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
          this.logger.error(`Failed to reconcile wallet ${wallet.id}:`, error);
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
        summary,
      };

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Reconciliation complete: ${discrepancies.length}/${totalWallets} wallets with discrepancies ` +
        `(${criticalDiscrepancies.length} critical/high) in ${duration}ms`
      );

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
   */
  private async storeReconciliationReport(report: ReconciliationReport): Promise<void> {
    try {
      // Only store report if there are discrepancies to alert about
      if (report.walletsWithDiscrepancies > 0) {
        // Use first discrepancy user_id, or a placeholder for system-level reports
        const reportUserId = report.totalDiscrepancies.length > 0 
          ? report.totalDiscrepancies[0].userId 
          : '00000000-0000-0000-0000-000000000000'; // System placeholder

        await this.supabase
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
      }
    } catch (error: any) {
      this.logger.error('Failed to store reconciliation report:', error);
      // Don't throw - report generation succeeded even if storage failed
    }
  }

  /**
   * Auto-correct minor discrepancies (low severity only)
   * Updates wallet balances to match ledger-calculated values
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
      // Update wallet balances to match calculated values
      const { error } = await this.supabase
        .from('wallets')
        .update({
          available_balance: discrepancy.availableBalanceCalculated,
          escrow_balance: discrepancy.escrowBalanceCalculated,
          pending_withdrawal: discrepancy.pendingWithdrawalCalculated,
          updated_at: new Date().toISOString(),
        })
        .eq('id', discrepancy.walletId);

      if (error) {
        this.logger.error(`Failed to auto-correct wallet ${discrepancy.walletId}:`, error);
        return false;
      }

      this.logger.log(
        `✅ Auto-corrected low-severity discrepancy for wallet ${discrepancy.walletId}: ` +
        `Available: ${discrepancy.availableDiscrepancy.toFixed(6)}, ` +
        `Escrow: ${discrepancy.escrowDiscrepancy.toFixed(6)}, ` +
        `Pending: ${discrepancy.pendingDiscrepancy.toFixed(6)}`
      );

      // Log correction in reconciliation_alerts
      await this.supabase
        .from('reconciliation_alerts')
        .insert({
          user_id: discrepancy.userId,
          alert_type: 'balance_correction',
          alert_severity: 'low',
          alert_reason: `Auto-corrected low-severity balance discrepancy`,
          status: 'resolved',
          local_amount: 0,
          local_currency: 'USD',
          metadata: {
            walletId: discrepancy.walletId,
            discrepancy,
            correctedAt: new Date().toISOString(),
            autoCorrected: true,
          },
        });

      return true;
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
}

