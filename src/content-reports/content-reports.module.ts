import { Module } from '@nestjs/common';
import { ContentReportsController } from './content-reports.controller';
import { ContentReportsService } from './content-reports.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [ContentReportsController],
  providers: [ContentReportsService],
  exports: [ContentReportsService],
})
export class ContentReportsModule {}

