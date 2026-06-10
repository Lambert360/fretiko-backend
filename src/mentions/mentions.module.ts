import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MentionsService } from './mentions.service';
import { MentionsController } from './mentions.controller';

@Module({
  imports: [ConfigModule, AuthModule, forwardRef(() => NotificationsModule)],
  controllers: [MentionsController],
  providers: [MentionsService, SupabaseClientManager],
  exports: [MentionsService],
})
export class MentionsModule {}
