import { Module } from '@nestjs/common';
import { SoundsController } from './sounds.controller';
import { SoundsService } from './sounds.service';
import { AuthModule } from '../auth/auth.module';

/**
 * Sounds Module
 *
 * Live-stream soundboard: platform-curated sounds (admin) + vendor-owned
 * uploads + per-vendor quick-play slot preferences.
 */
@Module({
  imports: [AuthModule],
  controllers: [SoundsController],
  providers: [SoundsService],
  exports: [SoundsService],
})
export class SoundsModule {}
