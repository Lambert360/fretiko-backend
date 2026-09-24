import { Injectable, Logger } from '@nestjs/common';
import { LlmService, ModelTier } from './llm.service';
import { AiContext } from './context-builder.service';
import { ClassifiedIntent } from './intent-classifier.service';
import { AiIntent, AiResponseType, AiAction, ToolExecutionResult } from '../dto/ai.dto';

export interface GeneratedResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

@Injectable()
export class ResponseGeneratorService {
  private readonly logger = new Logger(ResponseGeneratorService.name);

  constructor(private llmService: LlmService) {}

  async generate(
    userMessage: string,
    intent: ClassifiedIntent,
    toolResults: ToolExecutionResult[],
    context: AiContext
  ): Promise<GeneratedResponse> {
    const result = toolResults.find(r => r.result && !r.error)?.result;
    const data = result?.results || result?.products || result?.vendors || result?.summaries || [];

    const systemPrompt = this.buildSystemPrompt(context, intent);
    const userPrompt = this.buildUserPrompt(userMessage, intent, data);

    try {
      const response = await this.llmService.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        this.selectTier(intent.intent)
      );

      return {
        content: response.content.trim(),
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      };
    } catch (error) {
      this.logger.error('Response generation failed:', error);
      return {
        content: this.generateFallback(intent, data),
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  suggestActions(intent: ClassifiedIntent, toolResults: ToolExecutionResult[]): AiAction[] {
    const result = toolResults.find(r => r.result)?.result;
    const items = result?.results || result?.products || result?.vendors || [];
    if (!items || items.length === 0) return [];

    const actions: AiAction[] = [];
    const firstItem = items[0];

    if (intent.intent === AiIntent.PRODUCT_SEARCH || intent.intent === AiIntent.COMPARISON) {
      actions.push({
        id: `save-${firstItem.id}`,
        type: 'save',
        label: 'Save to wishlist',
        payload: { productId: firstItem.id },
        requiresConfirmation: false,
      });
      actions.push({
        id: `view-${firstItem.id}`,
        type: 'view',
        label: 'View details',
        payload: { productId: firstItem.id },
        requiresConfirmation: false,
      });
      if (items.length > 1) {
        actions.push({
          id: `compare-${items.slice(0, 3).map((i: any) => i.id).join('-')}`,
          type: 'compare',
          label: 'Compare top picks',
          payload: { productIds: items.slice(0, 3).map((i: any) => i.id) },
          requiresConfirmation: false,
        });
      }
    }

    if (intent.intent === AiIntent.VENDOR_SEARCH) {
      actions.push({
        id: `follow-${firstItem.id}`,
        type: 'follow',
        label: 'Follow vendor',
        payload: { vendorId: firstItem.id },
        requiresConfirmation: false,
      });
      actions.push({
        id: `draft-${firstItem.id}`,
        type: 'draft',
        label: 'Message vendor',
        payload: { vendorId: firstItem.id },
        requiresConfirmation: false,
      });
    }

    if (intent.intent === AiIntent.PRODUCT_SEARCH || intent.intent === AiIntent.COMPARISON) {
      actions.push({
        id: `alert-${firstItem.id || 'query'}`,
        type: 'alert',
        label: 'Set price alert',
        payload: { productId: firstItem.id, query: intent.parameters.query },
        requiresConfirmation: false,
      });
    }

    return actions.slice(0, 4);
  }

  private buildSystemPrompt(context: AiContext, intent: ClassifiedIntent): string {
    const lines = [
      `You are Iko, Fretiko's AI shopping assistant. You help users find products and vendors on a Nigerian marketplace.`,
      `Tone: ${context.preferences.communicationStyle}.`,
      `Currency: Freti (₣).`,
      `Current date: ${new Date().toISOString().split('T')[0]}.`,
      `You are replying to ${context.username}.`,
    ];

    if (context.location?.address) {
      lines.push(`User is near ${context.location.address}.`);
    }

    if (context.preferences.favoriteCategories.length > 0) {
      lines.push(`User likes: ${context.preferences.favoriteCategories.join(', ')}.`);
    }

    lines.push(`Use ONLY the data provided below. Never invent prices, products, or ratings.`);
    lines.push(`Keep responses to 2-4 sentences. Be helpful and specific.`);
    lines.push(`If no results are found, suggest broadening the search or checking back later.`);

    return lines.join('\n');
  }

  private buildUserPrompt(userMessage: string, intent: ClassifiedIntent, data: any[]): string {
    if (intent.intent === AiIntent.GENERAL_CHAT || intent.intent === AiIntent.UNKNOWN) {
      return [
        `User message: "${userMessage}"`,
        `Intent: general conversation (no product search needed).`,
        `\nReply naturally and conversationally, as a friendly shopping assistant would. Do not mention searches, products, or results unless the user asked about them. Keep it brief.`,
      ].join('\n');
    }

    const lines = [
      `User message: "${userMessage}"`,
      `Intent: ${intent.intent}`,
    ];

    if (intent.entities?.budget) {
      lines.push(`Budget: up to ₣${intent.entities.budget}`);
    }

    if (intent.entities?.location) {
      lines.push(`Location preference: ${intent.entities.location}`);
    }

    if (data.length > 0) {
      lines.push(`\nResults (${data.length} found):`);
      data.slice(0, 10).forEach((item, idx) => {
        lines.push(`${idx + 1}. ${this.formatItem(item)}`);
      });
    } else {
      lines.push(`\nNo results found for this query.`);
    }

    lines.push(`\nWrite a natural response explaining these results. Mention the best match and why it is relevant.`);

    return lines.join('\n');
  }

  private formatItem(item: any): string {
    if (item.title && item.price !== undefined) {
      return `${item.title} — ₣${item.price}${item.originalPrice ? ` (was ₣${item.originalPrice})` : ''}, rated ${item.rating || 'N/A'}/5 by ${item.reviewCount || 0} reviews, sold by ${item.seller?.name || item.sellerName || 'unknown vendor'}`;
    }
    if (item.username) {
      return `${item.username}${item.is_verified ? ' (verified)' : ''} — rating ${item.store_rating || 'N/A'}/5, ${item.product_count || 0} products, ${item.service_count || 0} services`;
    }
    return JSON.stringify(item).substring(0, 200);
  }

  private selectTier(intent: AiIntent): ModelTier {
    switch (intent) {
      case AiIntent.COMPARISON:
        return ModelTier.STRONG;
      case AiIntent.PRODUCT_SEARCH:
      case AiIntent.VENDOR_SEARCH:
        return ModelTier.BALANCED;
      default:
        return ModelTier.FAST;
    }
  }

  private generateFallback(intent: ClassifiedIntent, data: any[]): string {
    if (intent.intent === AiIntent.GENERAL_CHAT || intent.intent === AiIntent.UNKNOWN) {
      return "Hi! I'm Iko, your Fretiko shopping assistant. Ask me to find products, vendors, or deals whenever you're ready.";
    }

    if (!data || data.length === 0) {
      return "I couldn't find anything matching that. Try a different keyword or category.";
    }

    const first = data[0];
    if (intent.intent === AiIntent.PRODUCT_SEARCH && first.title) {
      return `I found ${data.length} products. The top match is ${first.title} at ₣${first.price} from ${first.seller?.name || 'a vendor'}.`;
    }
    if (intent.intent === AiIntent.VENDOR_SEARCH && first.username) {
      return `I found ${data.length} vendors. ${first.username} is a verified seller with ${first.product_count || 0} products.`;
    }
    if (intent.intent === AiIntent.COMPARISON) {
      return `I found ${data.length} items to compare. The top option is ${first.title || first.username}. Let me know if you want a detailed comparison.`;
    }
    return `I found ${data.length} results. Let me know how you'd like to proceed.`;
  }
}
