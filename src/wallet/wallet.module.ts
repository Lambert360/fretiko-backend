import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { WalletController } from './wallet.controller';
import { RateTestController } from './rate-test.controller';
import { WalletService } from './wallet.service';
import { PinService } from './pin.service';
import { BankAccountService } from './bank-account.service';
import { FlutterwaveService } from './flutterwave.service';
import { ReconciliationService } from './reconciliation.service';
import { WalletReconciliationService } from './wallet-reconciliation.service';
import { ExchangeRateService } from '../shared/exchange-rate.service';
import { ProcessingTimeService } from './processing-time.service';
import { WithdrawalValidationService } from './withdrawal-validation.service';
import { RateProviderService } from './rate-provider.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebhookModule } from '../webhook/webhook.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [NotificationsModule, ScheduleModule, WebhookModule, AuthModule],
  controllers: [WalletController, RateTestController],
  providers: [
    WalletService, 
    PinService, 
    BankAccountService, 
    FlutterwaveService, 
    ReconciliationService, 
    WalletReconciliationService,
    ExchangeRateService, 
    ProcessingTimeService,
    WithdrawalValidationService,
    RateProviderService
  ],
  exports: [
    WalletService, 
    PinService, 
    BankAccountService, 
    FlutterwaveService, 
    ReconciliationService, 
    WalletReconciliationService,
    ProcessingTimeService
  ], // Export for use in other modules
})
export class WalletModule {}