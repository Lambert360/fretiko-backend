import { Module } from '@nestjs/common'
import { GeneralPartnershipsController } from './general-partnerships.controller'
import { PartnershipsModule } from '../partnerships/partnerships.module'

@Module({
  imports: [PartnershipsModule],
  controllers: [GeneralPartnershipsController],
})
export class GeneralPartnershipsModule {}
