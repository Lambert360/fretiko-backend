import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { ProductsModule } from '../products/products.module';
import { ServicesModule } from '../services/services.module';
import { UsersModule } from '../users/users.module';
import { RidersModule } from '../riders/riders.module';

@Module({
  imports: [ProductsModule, ServicesModule, UsersModule, RidersModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService], // Export SearchService so other modules can use it
})
export class SearchModule {}