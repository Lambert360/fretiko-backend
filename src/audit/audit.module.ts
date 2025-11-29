import { Module, forwardRef } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { StaffModule } from '../staff/staff.module';

@Module({
  imports: [forwardRef(() => StaffModule)], // Use forwardRef to resolve circular dependency
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService], // Export so other modules can use it
})
export class AuditModule {}
