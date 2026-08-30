import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StaffModule } from '../staff/staff.module';
import { SignPostsService } from './sign-posts.service';
import { AdminSignPostsController } from './controllers/admin-sign-posts.controller';
import { PublicSignPostsController } from './controllers/public-sign-posts.controller';

@Module({
  imports: [ConfigModule, StaffModule],
  controllers: [AdminSignPostsController, PublicSignPostsController],
  providers: [SignPostsService],
  exports: [SignPostsService],
})
export class SignPostsModule {}
