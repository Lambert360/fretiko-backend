import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { PinService } from './pin.service';
import { BankAccountService } from './bank-account.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [WalletController],
  providers: [WalletService, PinService, BankAccountService],
  exports: [WalletService, PinService, BankAccountService], // Export for use in other modules
})
export class WalletModule {}