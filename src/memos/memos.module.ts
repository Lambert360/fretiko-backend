import { Module } from '@nestjs/common';
import { MemosController } from './memos.controller';
import { MemosService } from './memos.service';
import { StaffModule } from '../staff/staff.module';

@Module({
  imports: [StaffModule],
  controllers: [MemosController],
  providers: [MemosService],
  exports: [MemosService],
})
export class MemosModule {}
