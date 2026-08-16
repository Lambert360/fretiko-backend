import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IkoModule } from '../iko/iko.module';
import { ChatModule } from '../chat/chat.module';
import { ProductsModule } from '../products/products.module';
import { StoresModule } from '../stores/stores.module';
import { SearchModule } from '../search/search.module';

import { AiController } from './ai.controller';
import { LlmService } from './core/llm.service';
import { EmbeddingService } from './core/embedding.service';
import { VectorSearchService } from './core/vector-search.service';
import { IntentClassifierService } from './core/intent-classifier.service';
import { ContextBuilderService } from './core/context-builder.service';
import { ResponseGeneratorService } from './core/response-generator.service';
import { ToolRouterService } from './core/tool-router.service';

import { ShoppingAgentService } from './agents/shopping-agent.service';
import { DiscoveryAgentService } from './agents/discovery-agent.service';

import { ProductSearchTool } from './tools/product-search.tool';
import { VendorSearchTool } from './tools/vendor-search.tool';
import { ReviewSummaryTool } from './tools/review-summary.tool';
import { TrendingTool } from './tools/trending.tool';

import { ConversationMemoryService } from './memory/conversation-memory.service';
import { PreferenceLearnerService } from './memory/preference-learner.service';

import { AiPermissionGuard } from './guards/ai-permission.guard';
import { CostTrackingInterceptor } from './guards/cost-tracking.interceptor';
import { PriceAlertService } from './price-alert.service';

@Module({
  imports: [
    ConfigModule,
    IkoModule,
    ChatModule,
    ProductsModule,
    StoresModule,
    SearchModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '24h' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AiController],
  providers: [
    LlmService,
    EmbeddingService,
    VectorSearchService,
    IntentClassifierService,
    ContextBuilderService,
    ResponseGeneratorService,
    ToolRouterService,
    ShoppingAgentService,
    DiscoveryAgentService,
    ProductSearchTool,
    VendorSearchTool,
    ReviewSummaryTool,
    TrendingTool,
    ConversationMemoryService,
    PreferenceLearnerService,
    AiPermissionGuard,
    CostTrackingInterceptor,
    PriceAlertService,
  ],
  exports: [
    LlmService,
    EmbeddingService,
    VectorSearchService,
    IntentClassifierService,
    ShoppingAgentService,
    DiscoveryAgentService,
    PriceAlertService,
  ],
})
export class AiModule {}
