/**
 * BROADCAST SCHEDULER
 * Hourly sweep over broadcast_templates with an auto cadence
 * (auto_cadence_days). Due templates are fanned out through
 * BroadcastsService.sendBroadcast(trigger='auto'), which applies the
 * same frequency cap, suppression rules and per-user dedup as manual
 * sends.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BroadcastsService } from './broadcasts.service';

@Injectable()
export class BroadcastSchedulerService {
  private readonly logger = new Logger(BroadcastSchedulerService.name);

  constructor(private readonly broadcastsService: BroadcastsService) {}

  @Cron('0 * * * *') // top of every hour
  async handleAutoBroadcasts() {
    try {
      const launched = await this.broadcastsService.runAutoBroadcasts();
      if (launched > 0) {
        this.logger.log(`Auto-broadcast sweep launched ${launched} campaign(s)`);
      }
    } catch (error) {
      this.logger.error('Auto-broadcast sweep failed:', error);
    }
  }
}
