import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebsiteContentController } from './controllers/website-content.controller';
import { AboutContentController } from './controllers/about-content.controller';
import { PublicAboutContentController } from './controllers/public-about-content.controller';
import { BlogPostsController, PublicBlogPostsController } from './controllers/blog-posts.controller';
import { JobListingsController } from './controllers/job-listings.controller';
import { PublicJobListingsController } from './controllers/job-listings.controller';
import { JobApplicationsController, PublicJobApplicationsController } from './controllers/job-applications.controller';
import { SupportMessagesController, PublicSupportMessagesController } from './controllers/support-messages.controller';
import { WebsiteContentUploadController, PublicWebsiteContentUploadController } from './controllers/website-content-upload.controller';

import { AboutContentService } from './services/about-content.service';
import { BlogPostsService } from './services/blog-posts.service';
import { JobListingsService } from './services/job-listings.service';
import { JobApplicationsService } from './services/job-applications.service';
import { SupportMessagesService } from './services/support-messages.service';
import { WebsiteContentUploadService } from './services/website-content-upload.service';

import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
  ],
  controllers: [
    WebsiteContentController,
    AboutContentController,
    PublicAboutContentController,
    BlogPostsController,
    PublicBlogPostsController,
    JobListingsController,
    PublicJobListingsController,
    JobApplicationsController,
    SupportMessagesController,
    PublicJobApplicationsController,
    PublicSupportMessagesController,
    WebsiteContentUploadController,
    PublicWebsiteContentUploadController,
  ],
  providers: [
    AboutContentService,
    BlogPostsService,
    JobListingsService,
    JobApplicationsService,
    SupportMessagesService,
    WebsiteContentUploadService,
  ],
  exports: [
    AboutContentService,
    BlogPostsService,
    JobListingsService,
    JobApplicationsService,
    SupportMessagesService,
  ],
})
export class WebsiteContentModule {}
