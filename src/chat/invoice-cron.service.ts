import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InvoiceService } from './invoice.service';

@Injectable()
export class InvoiceCronService {
  private readonly logger = new Logger(InvoiceCronService.name);

  constructor(private readonly invoiceService: InvoiceService) {}

  /**
   * Cron job to expire pending invoices every hour
   * Runs at the start of every hour (0 minutes)
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireInvoices() {
    this.logger.log('Running invoice expiration cron job...');

    try {
      const result = await this.invoiceService.expireInvoices();
      this.logger.log(`Invoice expiration completed. Expired ${result.expired} invoices.`);
    } catch (error) {
      this.logger.error('Error running invoice expiration cron job:', error);
    }
  }

  /**
   * Optional: Run expiration check more frequently (every 15 minutes) for better UX
   * Uncomment if you want more frequent checks
   */
  // @Cron('0 */15 * * * *') // Every 15 minutes
  // async expireInvoicesFrequent() {
  //   this.logger.log('Running frequent invoice expiration check...');
  //
  //   try {
  //     const result = await this.invoiceService.expireInvoices();
  //     if (result.expired > 0) {
  //       this.logger.log(`Expired ${result.expired} invoices.`);
  //     }
  //   } catch (error) {
  //     this.logger.error('Error running frequent expiration check:', error);
  //   }
  // }
}
