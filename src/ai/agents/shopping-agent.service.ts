import { Injectable, Logger } from '@nestjs/common';
import { ContextBuilderService } from '../core/context-builder.service';
import { ResponseGeneratorService } from '../core/response-generator.service';
import { ToolRouterService } from '../core/tool-router.service';
import { ConversationMemoryService } from '../memory/conversation-memory.service';
import { PreferenceLearnerService } from '../memory/preference-learner.service';
import { AiPermissionGuard } from '../guards/ai-permission.guard';
import { CostTrackingInterceptor } from '../guards/cost-tracking.interceptor';
import { ClassifiedIntent } from '../core/intent-classifier.service';
import { AiIntent, AiResponseType, StreamingResponseDto } from '../dto/ai.dto';

@Injectable()
export class ShoppingAgentService {
  private readonly logger = new Logger(ShoppingAgentService.name);

  constructor(
    private contextBuilder: ContextBuilderService,
    private responseGenerator: ResponseGeneratorService,
    private toolRouter: ToolRouterService,
    private conversationMemory: ConversationMemoryService,
    private preferenceLearner: PreferenceLearnerService,
    private permissionGuard: AiPermissionGuard,
    private costTracker: CostTrackingInterceptor,
  ) {}

  async process(
    userId: string,
    message: string,
    classifiedIntent: ClassifiedIntent,
    conversationId?: string,
    userToken?: string
  ): Promise<StreamingResponseDto[]> {
    const startTime = Date.now();
    const responses: StreamingResponseDto[] = [];
    let metadata: any = {};

    try {
      // 1. Load user context
      const aiContext = await this.contextBuilder.build(userId, userToken);
      
      // 2. Permission check
      await this.permissionGuard.verify(userId, classifiedIntent.intent);

      // 3. Send thinking indicator
      responses.push({
        type: AiResponseType.THINKING,
        content: 'Searching...',
      });

      // 4. Execute relevant tools
      const toolResults = await this.toolRouter.executeTools(
        classifiedIntent.intent,
        classifiedIntent.parameters,
        userId,
        userToken
      );

      // 5. Generate product/vendor cards immediately
      const toolData = toolResults.find(r => r.result)?.result;
      if (toolData?.results) {
        responses.push({
          type: this.getDataType(classifiedIntent.intent),
          data: toolData.results.slice(0, 10),
        });
      } else if (toolData?.products || toolData?.vendors) {
        responses.push({
          type: AiResponseType.TRENDING,
          data: toolData,
        });
      }

      // 6. Generate AI explanation
      const explanation = await this.responseGenerator.generate(
        message,
        classifiedIntent,
        toolResults,
        aiContext
      );

      responses.push({
        type: AiResponseType.TEXT,
        content: explanation.content,
      });

      // 7. Suggest safe actions
      const actions = this.responseGenerator.suggestActions(classifiedIntent, toolResults);
      if (actions.length > 0) {
        responses.push({
          type: AiResponseType.ACTIONS,
          actions,
        });
      }

      // 8. Update memory and preferences
      await this.conversationMemory.addMessage(userId, conversationId, 'user', message);
      await this.conversationMemory.addMessage(userId, conversationId, 'assistant', explanation.content);
      await this.preferenceLearner.learn(userId, classifiedIntent, toolResults);

      // 9. Record cost with actual token usage
      const inputTokens = (classifiedIntent.tokenUsage?.inputTokens || 0) + explanation.inputTokens;
      const outputTokens = (classifiedIntent.tokenUsage?.outputTokens || 0) + explanation.outputTokens;
      metadata = {
        userId,
        intent: classifiedIntent.intent,
        model: 'self-hosted',
        inputTokens,
        outputTokens,
        toolCalls: toolResults.length,
        latencyMs: Date.now() - startTime,
        estimatedCost: this.costTracker.estimateCost(inputTokens, outputTokens, 'self-hosted'),
        success: true,
      };
      await this.costTracker.record(metadata);

    } catch (error: any) {
      this.logger.error('Shopping agent error:', error);
      responses.push({
        type: AiResponseType.TEXT,
        content: 'Sorry, I had trouble with that request. Please try again or rephrase.',
      });
      metadata.errorMessage = error.message;
      metadata.success = false;
      await this.costTracker.record(metadata);
    }

    return responses;
  }

  private getDataType(intent: AiIntent): AiResponseType {
    switch (intent) {
      case AiIntent.VENDOR_SEARCH:
        return AiResponseType.VENDORS;
      case AiIntent.COMPARISON:
        return AiResponseType.COMPARISON;
      case AiIntent.TRENDING:
        return AiResponseType.TRENDING;
      default:
        return AiResponseType.PRODUCTS;
    }
  }
}
