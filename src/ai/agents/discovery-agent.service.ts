import { Injectable } from '@nestjs/common';
import { TrendingTool } from '../tools/trending.tool';
import { LlmService, ModelTier } from '../core/llm.service';
import { ContextBuilderService } from '../core/context-builder.service';
import { ConversationMemoryService } from '../memory/conversation-memory.service';
import { AiResponseType, StreamingResponseDto } from '../dto/ai.dto';

@Injectable()
export class DiscoveryAgentService {
  constructor(
    private trendingTool: TrendingTool,
    private llmService: LlmService,
    private contextBuilder: ContextBuilderService,
    private conversationMemory: ConversationMemoryService,
  ) {}

  async handleTrending(
    userId: string,
    message: string,
    category?: string,
    location?: string,
    userToken?: string,
    conversationId?: string
  ): Promise<StreamingResponseDto[]> {
    const responses: StreamingResponseDto[] = [];
    
    const trending = await this.trendingTool.execute(
      { category, location, limit: 10 },
      userId,
      userToken
    );

    responses.push({
      type: AiResponseType.TRENDING,
      data: trending,
    });

    const context = await this.contextBuilder.build(userId, userToken);
    const systemPrompt = `You are Iko, Fretiko's AI assistant. Summarize trending products and vendors in a friendly, concise way. Use only the data provided. Currency: ₦.`;
    const userPrompt = `User asked: "${message}"\n\nTrending products (${trending.products.length}):\n${trending.products.slice(0, 5).map((p: any, i: number) => `${i + 1}. ${p.title} — ₦${p.price}`).join('\n')}\n\nTrending vendors (${trending.vendors.length}):\n${trending.vendors.slice(0, 5).map((v: any, i: number) => `${i + 1}. ${v.username}`).join('\n')}\n\nWrite a brief response.`;

    try {
      const llmResponse = await this.llmService.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        ModelTier.BALANCED
      );

      responses.push({
        type: AiResponseType.TEXT,
        content: llmResponse.content.trim(),
      });
    } catch (error) {
      responses.push({
        type: AiResponseType.TEXT,
        content: `Here are ${trending.products.length} trending products and ${trending.vendors.length} trending vendors right now.`,
      });
    }

    const textResponse = responses.find(r => r.type === AiResponseType.TEXT)?.content || '';
    await this.conversationMemory.addMessage(userId, conversationId, 'user', message);
    await this.conversationMemory.addMessage(userId, conversationId, 'assistant', textResponse);

    return responses;
  }
}
