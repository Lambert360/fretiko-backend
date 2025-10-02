import { Module } from '@nestjs/common';
import { IkoController } from './iko.controller';
import { IkoSearchController } from './iko-search.controller';
import { IkoService } from './iko.service';
import { IkoSearchService } from './iko-search.service';
import { IkoSchedulerService } from './iko-scheduler.service';
import { SearchModule } from '../search/search.module';
import { ProductsModule } from '../products/products.module';
import { ServicesModule } from '../services/services.module';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    SearchModule,
    ProductsModule,
    ServicesModule,
    UsersModule,
    NotificationsModule
  ],
  controllers: [IkoController, IkoSearchController],
  providers: [IkoService, IkoSearchService, IkoSchedulerService],
  exports: [IkoService, IkoSearchService, IkoSchedulerService], // Export services so other modules can use them
})
export class IkoModule {}