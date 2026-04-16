import { Module } from '@nestjs/common'
import { PartnershipsController } from './partnerships.controller'
import { PartnershipsService } from './partnerships.service'
import { AuditModule } from '../audit/audit.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [PartnershipsController],
  providers: [PartnershipsService],
  exports: [PartnershipsService],
})
export class PartnershipsModule {}
