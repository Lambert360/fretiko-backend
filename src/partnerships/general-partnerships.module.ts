import { Module } from '@nestjs/common';
import { GeneralPartnershipsService } from './general-partnerships.service';
import { GeneralPartnershipsController } from './general-partnerships.controller';

@Module({
  controllers: [GeneralPartnershipsController],
  providers: [GeneralPartnershipsService],
  exports: [GeneralPartnershipsService],
})
export class GeneralPartnershipsModule {}
