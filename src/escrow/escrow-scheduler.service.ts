import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EscrowService } from './escrow.service';

@Injectable()
export class EscrowSchedulerService {
  private readonly logger = new Logger(EscrowSchedulerService.name);

  constructor(private readonly escrowService: EscrowService) {}

  /**
   * Auto-release escrows every hour
   * Runs at the start of every hour (e.g., 1:00, 2:00, 3:00)
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleEscrowAutoRelease() {
    this.logger.log('⏰ Running scheduled escrow auto-release check...');
    
    try {
      const releasedCount = await this.escrowService.autoReleaseEscrows();
      
      if (releasedCount > 0) {
        this.logger.log(`✅ Successfully auto-released ${releasedCount} escrow(s)`);
      } else {
        this.logger.debug('No escrows ready for auto-release at this time');
      }
    } catch (error) {
      this.logger.error('❌ Error during escrow auto-release:', error);
    }
  }

  /**
   * Alternative: Run every 30 minutes for more frequent checks
   * Uncomment this and comment out the hourly cron if you want more frequent checks
   */
  // @Cron('*/30 * * * *')
  // async handleEscrowAutoReleaseFrequent() {
  //   this.logger.log('⏰ Running frequent escrow auto-release check (30 min)...');
  //   
  //   try {
  //     const releasedCount = await this.escrowService.autoReleaseEscrows();
  //     
  //     if (releasedCount > 0) {
  //       this.logger.log(`✅ Successfully auto-released ${releasedCount} escrow(s)`);
  //     }
  //   } catch (error) {
  //     this.logger.error('❌ Error during escrow auto-release:', error);
  //   }
  // }
}

