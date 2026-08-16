import { Module, forwardRef } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { FileUploadService } from './file-upload.service';
import { CallsService } from './calls.service';
import { AIAssistantService } from './ai-assistant.service';
import { InvoiceService } from './invoice.service';
import { InvoiceCronService } from './invoice-cron.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { EscrowModule } from '../escrow/escrow.module';
import { TagsModule } from '../tags/tags.module';
import { MentionsModule } from '../mentions/mentions.module';

@Module({
  imports: [
    NotificationsModule,
    forwardRef(() => RealtimeModule),
    forwardRef(() => EscrowModule),
    TagsModule,
    MentionsModule,
  ],
  controllers: [ChatController],
  providers: [
    ChatService,
    FileUploadService,
    CallsService,
    AIAssistantService,
    InvoiceService,
    InvoiceCronService,
  ],
  exports: [
    ChatService,
    FileUploadService,
    CallsService,
    AIAssistantService,
    InvoiceService,
  ],
})
export class ChatModule {}