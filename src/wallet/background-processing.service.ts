import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { RateProviderService } from './rate-provider.service';
import { WalletReconciliationService } from './wallet-reconciliation.service';
import { AdminService } from '../admin/admin.service';

/**
 * Background Processing Service
 * Handles scheduled tasks for exchange rate updates, monitoring, and maintenance
 */
@Injectable()
export class BackgroundProcessingService implements OnModuleInit {
  private readonly logger = new Logger(BackgroundProcessingService.name);
  private readonly rateCache = new Map<string, any>(); // Simple cache replacement
  private readonly monitoringCache = new Map<string, any>(); // Simple cache replacement
  private readonly healthMetrics = {
    lastRateUpdate: null as Date | null,
    lastReconciliation: null as Date | null,
    failedUpdates: 0,
    successfulUpdates: 0,
    providerHealth: {} as Record<string, any>,
  };

  constructor(
    private readonly rateProviderService: RateProviderService,
    private readonly walletReconciliationService: WalletReconciliationService,
    private readonly adminService: AdminService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit() {
    this.logger.log('🚀 Background Processing Service initialized');
    this.initializeHealthChecks();
  }

  /**
   * Update exchange rates every 5 minutes during business hours
   * Runs every 5 minutes from 6 AM to 10 PM UTC
   */
  @Cron('0 */5 6-22 * * *', {
    name: 'exchange-rate-update',
    timeZone: 'UTC',
  })
  async updateExchangeRates() {
    const startTime = Date.now();
    this.logger.log('🔄 Starting scheduled exchange rate update...');

    try {
      // Test all major currency pairs
      const testPairs = [
        { from: 'USD', to: 'NGN', amount: 100 },
        { from: 'EUR', to: 'NGN', amount: 100 },
        { from: 'GBP', to: 'NGN', amount: 100 },
        { from: 'USD', to: 'EUR', amount: 100 },
      ];

      const results = await Promise.allSettled(
        testPairs.map(pair => 
          this.rateProviderService.getExchangeRate(pair.from, pair.to, pair.amount)
        )
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      // Update health metrics
      this.healthMetrics.lastRateUpdate = new Date();
      this.healthMetrics.successfulUpdates += successful;
      this.healthMetrics.failedUpdates += failed;

      // Cache the results for monitoring
      this.rateCache.set('latest-update', {
        timestamp: new Date(),
        successful,
        failed,
        total: testPairs.length,
        duration: Date.now() - startTime,
      });

      this.logger.log(`✅ Exchange rate update completed: ${successful}/${testPairs.length} successful (${Date.now() - startTime}ms)`);

      // Alert if failure rate is high
      if (failed > testPairs.length * 0.3) {
        this.logger.warn(`⚠️ High failure rate detected: ${failed}/${testPairs.length} updates failed`);
        await this.sendAlert('HIGH_FAILURE_RATE', {
          failed,
          total: testPairs.length,
          failureRate: (failed / testPairs.length) * 100,
        });
      }

    } catch (error) {
      this.healthMetrics.failedUpdates++;
      this.logger.error(`❌ Exchange rate update failed: ${error.message}`);
      await this.sendAlert('RATE_UPDATE_FAILED', { error: error.message });
    }
  }

  /**
   * Daily wallet reconciliation at 2 AM UTC
   */
  @Cron('0 2 * * *', {
    name: 'daily-reconciliation',
    timeZone: 'UTC',
  })
  async performDailyReconciliation() {
    const startTime = Date.now();
    this.logger.log('🔍 Starting daily wallet reconciliation...');

    try {
      const result = await this.walletReconciliationService.triggerReconciliation();
      
      this.healthMetrics.lastReconciliation = new Date();
      
      this.monitoringCache.set('reconciliation-result', {
        timestamp: new Date(),
        result,
        duration: Date.now() - startTime,
      });

      this.logger.log(`✅ Daily reconciliation completed in ${Date.now() - startTime}ms`);

      if (result.walletsWithDiscrepancies > 0) {
        this.logger.warn(`⚠️ Found ${result.walletsWithDiscrepancies} wallets with discrepancies`);
        await this.sendAlert('WALLET_DISCREPANCIES', result);
      }

    } catch (error) {
      this.logger.error(`❌ Daily reconciliation failed: ${error.message}`);
      await this.sendAlert('RECONCILIATION_FAILED', { error: error.message });
    }
  }

  /**
   * Hourly health check for all providers
   */
  @Cron('0 * * * *', {
    name: 'provider-health-check',
    timeZone: 'UTC',
  })
  async performProviderHealthCheck() {
    this.logger.log('🏥 Performing provider health checks...');

    try {
      const providers = ['Flutterwave', 'Frankfurter', 'ExchangeRateHost'];
      const healthResults = await Promise.allSettled(
        providers.map(provider => this.checkProviderHealth(provider))
      );

      const healthStatus = providers.reduce((acc, provider, index) => {
        const result = healthResults[index];
        acc[provider] = {
          healthy: result.status === 'fulfilled',
          responseTime: result.status === 'fulfilled' ? result.value.responseTime : null,
          error: result.status === 'rejected' ? result.reason : null,
          lastChecked: new Date(),
        };
        return acc;
      }, {} as Record<string, any>);

      this.healthMetrics.providerHealth = healthStatus;

      // Cache health status
      this.monitoringCache.set('provider-health', {
        timestamp: new Date(),
        providers: healthStatus,
      });

      const unhealthyProviders = Object.entries(healthStatus)
        .filter(([_, status]: [string, any]) => !status.healthy)
        .map(([provider]) => provider);

      if (unhealthyProviders.length > 0) {
        this.logger.warn(`⚠️ Unhealthy providers detected: ${unhealthyProviders.join(', ')}`);
        await this.sendAlert('UNHEALTHY_PROVIDERS', { providers: unhealthyProviders });
      }

    } catch (error) {
      this.logger.error(`❌ Provider health check failed: ${error.message}`);
    }
  }

  /**
   * Weekly performance analytics
   */
  @Cron('0 0 * * 0', {
    name: 'weekly-analytics',
    timeZone: 'UTC',
  })
  async generateWeeklyAnalytics() {
    this.logger.log('📊 Generating weekly analytics...');

    try {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [regionalData, providerData, patternData, revenueData] = await Promise.all([
        this.adminService.getRegionalRevenueForStaff('system', {
          period: 'weekly',
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        }),
        this.adminService.getProviderPerformanceForStaff('system', {
          period: 'weekly',
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        }),
        this.adminService.getTransactionPatternsForStaff('system', {
          period: 'weekly',
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        }),
        this.adminService.getRevenueSummaryForStaff('system', {
          period: 'weekly',
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        }),
      ]);

      const weeklyReport = {
        period: 'weekly',
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        generated: new Date().toISOString(),
        regional: regionalData,
        providers: providerData,
        patterns: patternData,
        revenue: revenueData,
        health: this.healthMetrics,
      };

      // Cache the weekly report
      this.monitoringCache.set('weekly-report', weeklyReport);

      this.logger.log('✅ Weekly analytics generated successfully');

    } catch (error) {
      this.logger.error(`❌ Weekly analytics generation failed: ${error.message}`);
    }
  }

  /**
   * Check individual provider health
   */
  private async checkProviderHealth(provider: string): Promise<{ responseTime: number }> {
    const startTime = Date.now();
    
    try {
      // Test with a simple rate request
      await this.rateProviderService.getExchangeRate('USD', 'NGN', 100);
      
      return {
        responseTime: Date.now() - startTime,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Send alert to admin monitoring system
   */
  private async sendAlert(type: string, data: any) {
    try {
      // This would integrate with your alert system
      this.logger.warn(`🚨 ALERT [${type}]:`, data);
      
      // Store alert in monitoring cache
      const alerts = (this.monitoringCache.get('alerts') as any[]) || [];
      alerts.push({
        type,
        data,
        timestamp: new Date(),
      });
      this.monitoringCache.set('alerts', alerts.slice(-100)); // Keep last 100 alerts
      
    } catch (error) {
      this.logger.error(`Failed to send alert: ${error.message}`);
    }
  }

  /**
   * Initialize health checks on startup
   */
  private async initializeHealthChecks() {
    this.logger.log('🏥 Initializing health checks...');
    
    try {
      await this.performProviderHealthCheck();
      await this.updateExchangeRates();
      this.logger.log('✅ Initial health checks completed');
    } catch (error) {
      this.logger.error(`❌ Initial health checks failed: ${error.message}`);
    }
  }

  /**
   * Get current health metrics
   */
  getHealthMetrics() {
    return {
      ...this.healthMetrics,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      lastRateUpdate: this.rateCache.get('latest-update'),
      lastReconciliation: this.monitoringCache.get('reconciliation-result'),
      providerHealth: this.healthMetrics.providerHealth,
      recentAlerts: ((this.monitoringCache.get('alerts') as any[]) || []).slice(-10),
    };
  }

  /**
   * Get cached analytics data
   */
  getCachedAnalytics(type: 'weekly' | 'daily' | 'hourly') {
    const cacheKey = `${type}-report`;
    return this.monitoringCache.get(cacheKey);
  }

  /**
   * Manual trigger for exchange rate update
   */
  async manualRateUpdate() {
    this.logger.log('🔄 Manual exchange rate update triggered');
    return this.updateExchangeRates();
  }

  /**
   * Manual trigger for reconciliation
   */
  async manualReconciliation() {
    this.logger.log('🔍 Manual reconciliation triggered');
    return this.performDailyReconciliation();
  }

  /**
   * Get recent alerts with optional filtering
   */
  getAlerts(limit: number = 50, severity?: string, resolved?: boolean) {
    const alerts = (this.monitoringCache.get('alerts') as any[]) || [];
    
    let filtered = alerts;
    
    if (severity) {
      filtered = filtered.filter(a => a.data?.severity === severity || a.type?.includes(severity.toUpperCase()));
    }
    
    if (resolved !== undefined) {
      filtered = filtered.filter(a => a.resolved === resolved);
    }
    
    // Sort by timestamp desc and limit
    return filtered
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit)
      .map((alert, index) => ({
        id: alert.id || `alert-${Date.now()}-${index}`,
        type: alert.type,
        severity: alert.data?.severity || this.getSeverityFromType(alert.type),
        message: alert.data?.message || alert.data?.error || alert.type,
        data: alert.data,
        timestamp: alert.timestamp,
        resolved: alert.resolved || false,
        resolvedAt: alert.resolvedAt,
        resolvedBy: alert.resolvedBy,
      }));
  }

  /**
   * Dismiss an alert (mark as resolved)
   */
  dismissAlert(alertId: string, resolvedBy?: string) {
    const alerts = (this.monitoringCache.get('alerts') as any[]) || [];
    const alertIndex = alerts.findIndex(a => a.id === alertId || a.id === undefined && alerts.indexOf(a) === parseInt(alertId.split('-').pop() || '-1'));
    
    if (alertIndex === -1) {
      // Try to find by generated ID pattern
      const targetAlert = alerts.find((a, idx) => `alert-${Date.now()}-${idx}` === alertId || `alert-${new Date(a.timestamp).getTime()}-${idx}` === alertId);
      if (!targetAlert) {
        return { success: false, message: 'Alert not found' };
      }
    }
    
    // Mark as resolved
    const alert = alerts[alertIndex];
    alert.resolved = true;
    alert.resolvedAt = new Date();
    alert.resolvedBy = resolvedBy || 'system';
    
    this.monitoringCache.set('alerts', alerts);
    
    this.logger.log(`✅ Alert ${alertId} dismissed by ${resolvedBy || 'system'}`);
    
    return { success: true, message: 'Alert dismissed successfully' };
  }

  /**
   * Resolve an alert with notes
   */
  resolveAlert(alertId: string, notes?: string, resolvedBy?: string) {
    const result = this.dismissAlert(alertId, resolvedBy);
    
    if (result.success) {
      const alerts = (this.monitoringCache.get('alerts') as any[]) || [];
      const alert = alerts.find(a => a.id === alertId);
      if (alert) {
        alert.resolutionNotes = notes;
      }
      this.monitoringCache.set('alerts', alerts);
      
      return { success: true, message: 'Alert resolved successfully' };
    }
    
    return result;
  }

  /**
   * Get severity level from alert type
   */
  private getSeverityFromType(type: string): string {
    const criticalTypes = ['RATE_UPDATE_FAILED', 'RECONCILIATION_FAILED', 'HIGH_FAILURE_RATE'];
    const warningTypes = ['PROVIDER_DEGRADED', 'CACHE_MISS'];
    
    if (criticalTypes.includes(type)) return 'critical';
    if (warningTypes.includes(type)) return 'medium';
    return 'low';
  }
}
