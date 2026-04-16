import { Module, forwardRef } from '@nestjs/common';
import { ContentReportsController } from './content-reports.controller';
import { ContentReportsService } from './content-reports.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, NotificationsModule, forwardRef(() => AdminModule)],
  controllers: [ContentReportsController],
  providers: [ContentReportsService],
  exports: [ContentReportsService],
})
export class ContentReportsModule {}
