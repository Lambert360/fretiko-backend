import { Injectable, Logger } from '@nestjs/common';
import { LlmService, ModelTier } from './llm.service';
import { AiIntent, ProductSearchToolParams, VendorSearchToolParams, LlmResponse } from '../dto/ai.dto';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ClassifiedIntent {
  intent: AiIntent;
  confidence: number;
  parameters: ProductSearchToolParams | VendorSearchToolParams | Record<string, any>;
  entities: {
    category?: string;
    location?: string;
    budget?: number;
    product?: string;
    vendor?: string;
    comparisonItems?: string[];
  };
  tokenUsage?: TokenUsage;
}

@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);
  private readonly systemPrompt = `You are an intent classifier for a Nigerian e-commerce AI assistant called Fretiko.
Classify the user's message into exactly one of these intents:
- product_search: user wants to find products to buy
- vendor_search: user wants to find sellers/vendors/stores
- comparison: user wants to compare multiple products or vendors
- trending: user wants to know what's popular or trending
- general_chat: general question, greeting, or unrelated message

Also extract these entities when present:
- category: product category (electronics, fashion, beauty, etc.)
- location: city or area (Lagos, Abuja, Ikeja, etc.)
- budget: maximum price in Naira (as a number)
- product: product name or type
- vendor: vendor/store name or type
- comparisonItems: array of items being compared

Return ONLY valid JSON in this exact format:
{
  "intent": "one_of_the_intents",
  "confidence": 0.0_to_1.0,
  "parameters": {},
  "entities": {}
}

Examples:
User: "Find me affordable sneakers under ₦50k"
Response: {"intent":"product_search","confidence":0.95,"parameters":{"query":"sneakers","maxPrice":50000},"entities":{"category":"fashion","budget":50000,"product":"sneakers"}}

User: "Show me trusted vendors selling phones"
Response: {"intent":"vendor_search","confidence":0.92,"parameters":{"query":"phones","isVerified":true},"entities":{"category":"electronics","product":"phones","vendor":"phone sellers"}}

User: "Compare iPhone 15 and Samsung S24"
Response: {"intent":"comparison","confidence":0.9,"parameters":{"query":"iPhone 15 vs Samsung S24"},"entities":{"comparisonItems":["iPhone 15","Samsung S24"],"category":"electronics"}}

User: "What's trending near me?"
Response: {"intent":"trending","confidence":0.85,"parameters":{"query":"trending","location":"near me"},"entities":{"location":"near me"}}`;

  constructor(private llmService: LlmService) {}

  async classify(message: string): Promise<ClassifiedIntent> {
    try {
      const response = await this.llmService.chat(
        [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: message },
        ],
        ModelTier.FAST
      );

      const parsed = this.parseResponse(response.content, response);
      this.logger.debug(`Classified intent: ${parsed.intent} (${parsed.confidence})`);
      return parsed;
    } catch (error) {
      this.logger.error('Intent classification failed:', error);
      return this.fallbackIntent(message);
    }
  }

  private parseResponse(content: string, llmResponse?: LlmResponse): ClassifiedIntent {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        intent: this.validateIntent(parsed.intent),
        confidence: Number(parsed.confidence) || 0.5,
        parameters: parsed.parameters || {},
        entities: parsed.entities || {},
        tokenUsage: {
          inputTokens: llmResponse?.inputTokens || 0,
          outputTokens: llmResponse?.outputTokens || 0,
        },
      };
    } catch (error) {
      this.logger.warn('Failed to parse intent response, using fallback:', error);
      return this.fallbackIntent(content);
    }
  }

  private validateIntent(intent: string): AiIntent {
    if (Object.values(AiIntent).includes(intent as AiIntent)) {
      return intent as AiIntent;
    }
    return AiIntent.UNKNOWN;
  }

  private fallbackIntent(message: string): ClassifiedIntent {
    const lower = message.toLowerCase();
    const base = {
      confidence: 0.6,
      parameters: { query: message },
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    };

    if (lower.includes('vendor') || lower.includes('seller') || lower.includes('store')) {
      return {
        ...base,
        intent: AiIntent.VENDOR_SEARCH,
        entities: {},
      };
    }

    if (lower.includes('compare') || lower.includes('versus') || lower.includes(' vs ')) {
      return {
        ...base,
        intent: AiIntent.COMPARISON,
        entities: { comparisonItems: this.extractComparisonItems(message) },
      };
    }

    if (lower.includes('trending') || lower.includes('popular') || lower.includes('what is hot')) {
      return {
        ...base,
        intent: AiIntent.TRENDING,
        entities: {},
      };
    }

    return {
      ...base,
      intent: AiIntent.PRODUCT_SEARCH,
      confidence: 0.5,
      entities: {},
    };
  }

  private extractComparisonItems(message: string): string[] {
    // Simple extraction: split by "and", "vs", "versus", "or"
    const separators = /\s+(?:and|vs|versus|or)\s+/i;
    return message
      .split(separators)
      .map(s => s.replace(/^(compare|between)\s+/i, '').trim())
      .filter(s => s.length > 0);
  }
}
