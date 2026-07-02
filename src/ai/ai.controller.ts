import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Logger,
  HttpCode,
  HttpStatus,
  Get,
  Param,
  Query,
  Delete,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatMessageDto, CreatePriceAlertDto } from './dto/ai.dto';
import { IntentClassifierService } from './core/intent-classifier.service';
import { ShoppingAgentService } from './agents/shopping-agent.service';
import { DiscoveryAgentService } from './agents/discovery-agent.service';
import { ConversationMemoryService } from './memory/conversation-memory.service';
import { PriceAlertService } from './price-alert.service';
import { AiIntent } from './dto/ai.dto';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private intentClassifier: IntentClassifierService,
    private shoppingAgent: ShoppingAgentService,
    private discoveryAgent: DiscoveryAgentService,
    private conversationMemory: ConversationMemoryService,
    private priceAlertService: PriceAlertService,
  ) {}

  /**
   * Main chat endpoint. Returns a single JSON response with all response chunks.
   * For streaming, use POST /ai/chat/stream.
   */
  @Post('chat')
  @HttpCode(HttpStatus.OK)
  async chat(
    @Req() request: any,
    @Body() dto: ChatMessageDto
  ): Promise<{
    conversationId: string;
    responses: any[];
  }> {
    const userId = request.user.sub;
    const userToken = request.headers.authorization?.replace('Bearer ', '');
    const conversationId = dto.conversationId || await this.getConversationId(userId, dto.message);

    this.logger.log(`AI chat request from user: ${userId}, conversation: ${conversationId}, message: "${dto.message}"`);

    const classified = await this.intentClassifier.classify(dto.message);

    let responses: any[];
    if (classified.intent === AiIntent.TRENDING) {
      responses = await this.discoveryAgent.handleTrending(
        userId,
        dto.message,
        classified.entities?.category,
        classified.entities?.location,
        userToken,
        conversationId
      );
    } else {
      responses = await this.shoppingAgent.process(
        userId,
        dto.message,
        classified,
        conversationId,
        userToken
      );
    }

    return {
      conversationId,
      responses,
    };
  }

  /**
   * Server-Sent Events streaming chat endpoint.
   * Yields response chunks as they are generated.
   */
  @Post('chat/stream')
  @Sse()
  async chatStream(
    @Req() request: any,
    @Body() dto: ChatMessageDto
  ): Promise<Observable<MessageEvent>> {
    const userId = request.user.sub;
    const userToken = request.headers.authorization?.replace('Bearer ', '');
    const conversationId = dto.conversationId || await this.getConversationId(userId, dto.message);

    return new Observable<MessageEvent>((observer) => {
      (async () => {
        try {
          const classified = await this.intentClassifier.classify(dto.message);
          let responses: any[];

          if (classified.intent === AiIntent.TRENDING) {
            responses = await this.discoveryAgent.handleTrending(
              userId,
              dto.message,
              classified.entities?.category,
              classified.entities?.location,
              userToken,
              conversationId
            );
          } else {
            responses = await this.shoppingAgent.process(
              userId,
              dto.message,
              classified,
              conversationId,
              userToken
            );
          }

          // Emit each response chunk
          for (const response of responses) {
            observer.next({
              data: JSON.stringify(response),
            } as MessageEvent);
          }

          // Emit completion event
          observer.next({
            data: JSON.stringify({ type: 'done', conversationId }),
          } as MessageEvent);

          observer.complete();
        } catch (error) {
          this.logger.error('AI streaming error:', error);
          observer.next({
            data: JSON.stringify({
              type: 'error',
              content: 'Sorry, something went wrong. Please try again.',
            }),
          } as MessageEvent);
          observer.complete();
        }
      })();
    });
  }

  /**
   * Get conversation history for the AI chat.
   */
  @Get('conversations/:conversationId')
  async getConversation(
    @Req() request: any,
    @Param('conversationId') conversationId: string
  ) {
    const userId = request.user.sub;
    const messages = await this.conversationMemory.getRecentMessages(
      userId,
      conversationId,
      50
    );

    return {
      conversationId,
      messages,
    };
  }

  /**
   * List AI conversations for the current user.
   */
  @Get('conversations')
  async listConversations(
    @Req() request: any,
    @Query('limit') limit?: number
  ) {
    const userId = request.user.sub;
    const conversations = await this.conversationMemory.getConversations(
      userId,
      limit || 20
    );

    return {
      conversations,
    };
  }

  /**
   * List price alerts for the current user.
   */
  @Get('price-alerts')
  async getPriceAlerts(@Req() request: any) {
    const userId = request.user.sub;
    const alerts = await this.priceAlertService.getAlerts(userId);
    return { alerts };
  }

  /**
   * Create a new price alert.
   */
  @Post('price-alerts')
  @HttpCode(HttpStatus.CREATED)
  async createPriceAlert(
    @Req() request: any,
    @Body() dto: CreatePriceAlertDto
  ) {
    const userId = request.user.sub;
    const alert = await this.priceAlertService.createAlert(userId, dto);
    return { alert };
  }

  /**
   * Delete (soft-delete) a price alert.
   */
  @Delete('price-alerts/:id')
  @HttpCode(HttpStatus.OK)
  async deletePriceAlert(
    @Req() request: any,
    @Param('id') alertId: string
  ) {
    const userId = request.user.sub;
    await this.priceAlertService.deleteAlert(userId, alertId);
    return { success: true };
  }

  private async getConversationId(userId: string, message: string): Promise<string> {
    const conversation = await this.conversationMemory.getOrCreateConversation(userId);
    return conversation.id;
  }
}
