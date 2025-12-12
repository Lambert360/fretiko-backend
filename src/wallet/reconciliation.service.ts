import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';

export interface ReconciliationAlertData {
  depositId?: string | null; // For deposits
  payoutId?: string | null; // For withdrawals/payouts
  userId: string;
  localAmount: number;
  localCurrency: string;
  fallbackRateUsed: number;
  estimatedFretiAmount: number;
  actualFretiAmount?: number;
  actualRate?: number;
  alertReason: string;
  metadata?: Record<string, any>;
}

/**
 * Reconciliation Service
 * Handles logging and tracking of reconciliation alerts when fallback exchange rates are used
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Create a reconciliation alert when fallback exchange rate is used
   */
  async createReconciliationAlert(data: ReconciliationAlertData): Promise<void> {
    try {
      // Calculate discrepancy if actual amount is available
      let amountDiscrepancy: number | null = null;
      let discrepancyPercentage: number | null = null;
      let alertSeverity: 'low' | 'medium' | 'high' | 'critical' = 'medium';

      if (data.actualFretiAmount !== undefined && data.actualFretiAmount !== null) {
        amountDiscrepancy = data.actualFretiAmount - data.estimatedFretiAmount;
        discrepancyPercentage = (amountDiscrepancy / data.actualFretiAmount) * 100;

        // Determine severity based on absolute discrepancy
        const absDiscrepancy = Math.abs(amountDiscrepancy);
        if (absDiscrepancy < 1) {
          alertSeverity = 'low';
        } else if (absDiscrepancy < 10) {
          alertSeverity = 'medium';
        } else if (absDiscrepancy < 100) {
          alertSeverity = 'high';
        } else {
          alertSeverity = 'critical';
        }
      } else {
        // If actual amount is not available, severity is based on estimated amount
        if (data.estimatedFretiAmount < 1) {
          alertSeverity = 'low';
        } else if (data.estimatedFretiAmount < 10) {
          alertSeverity = 'medium';
        } else if (data.estimatedFretiAmount < 100) {
          alertSeverity = 'high';
        } else {
          alertSeverity = 'critical';
        }
      }

      const { data: alert, error } = await this.supabase
        .from('reconciliation_alerts')
        .insert({
          deposit_id: data.depositId || null,
          payout_id: data.payoutId || null, // Support withdrawals
          user_id: data.userId,
          local_amount: data.localAmount,
          local_currency: data.localCurrency,
          fallback_rate_used: data.fallbackRateUsed,
          estimated_freti_amount: data.estimatedFretiAmount,
          actual_freti_amount: data.actualFretiAmount || null,
          actual_rate: data.actualRate || null,
          amount_discrepancy: amountDiscrepancy,
          discrepancy_percentage: discrepancyPercentage,
          alert_type: data.depositId ? 'exchange_rate_fallback_deposit' : 'exchange_rate_fallback_withdrawal',
          alert_severity: alertSeverity,
          alert_reason: data.alertReason,
          status: 'pending',
          metadata: data.metadata || {},
        })
        .select()
        .single();

      if (error) {
        const recordId = data.depositId || data.payoutId || 'unknown';
        const recordType = data.depositId ? 'deposit' : 'withdrawal';
        this.logger.error(`Failed to create reconciliation alert for ${recordType} ${recordId}:`, error);
        // Don't throw - we don't want to break the flow if alert creation fails
      } else {
        const recordId = data.depositId || data.payoutId || 'unknown';
        const recordType = data.depositId ? 'Deposit' : 'Withdrawal';
        this.logger.warn(
          `⚠️ Reconciliation alert created: ${recordType} ${recordId} - ` +
          `${data.localAmount} ${data.localCurrency} @ fallback rate ${data.fallbackRateUsed} ` +
          `(Estimated: ${data.estimatedFretiAmount} FRETI, Actual: ${data.actualFretiAmount || 'N/A'} FRETI) ` +
          `[${alertSeverity.toUpperCase()}]`
        );
      }
    } catch (error: any) {
      this.logger.error(`Error creating reconciliation alert:`, error);
      // Don't throw - we don't want to break the deposit flow
    }
  }

  /**
   * Update reconciliation alert with actual Flutterwave data when it becomes available
   */
  async updateReconciliationAlertWithActualData(
    depositId: string,
    actualFretiAmount: number,
    actualRate: number
  ): Promise<void> {
    try {
      // Find the alert for this deposit
      const { data: existingAlert } = await this.supabase
        .from('reconciliation_alerts')
        .select('*')
        .eq('deposit_id', depositId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!existingAlert) {
        this.logger.debug(`No pending reconciliation alert found for deposit ${depositId}`);
        return;
      }

      // Calculate discrepancy
      const amountDiscrepancy = actualFretiAmount - existingAlert.estimated_freti_amount;
      const discrepancyPercentage = (amountDiscrepancy / actualFretiAmount) * 100;

      // Update severity based on actual discrepancy
      let alertSeverity: 'low' | 'medium' | 'high' | 'critical' = 'medium';
      const absDiscrepancy = Math.abs(amountDiscrepancy);
      if (absDiscrepancy < 1) {
        alertSeverity = 'low';
      } else if (absDiscrepancy < 10) {
        alertSeverity = 'medium';
      } else if (absDiscrepancy < 100) {
        alertSeverity = 'high';
      } else {
        alertSeverity = 'critical';
      }

      const { error } = await this.supabase
        .from('reconciliation_alerts')
        .update({
          actual_freti_amount: actualFretiAmount,
          actual_rate: actualRate,
          amount_discrepancy: amountDiscrepancy,
          discrepancy_percentage: discrepancyPercentage,
          alert_severity: alertSeverity,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingAlert.id);

      if (error) {
        this.logger.error(`Failed to update reconciliation alert ${existingAlert.id}:`, error);
      } else {
        this.logger.log(
          `✅ Updated reconciliation alert ${existingAlert.id} with actual data: ` +
          `${actualFretiAmount} FRETI @ ${actualRate} (Discrepancy: ${amountDiscrepancy.toFixed(4)} FRETI)`
        );
      }
    } catch (error: any) {
      this.logger.error(`Error updating reconciliation alert:`, error);
    }
  }
}

