import { Module, forwardRef } from '@nestjs/common';
import { MemosController } from './memos.controller';
import { MemosService } from './memos.service';
import { StaffModule } from '../staff/staff.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [StaffModule, forwardRef(() => AdminModule)],
  controllers: [MemosController],
  providers: [MemosService],
  exports: [MemosService],
})
export class MemosModule {}
