import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { LlmMessage, LlmResponse } from '../dto/ai.dto';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  apiKey?: string;
}

export enum ModelTier {
  FAST = 'fast',
  BALANCED = 'balanced',
  STRONG = 'strong',
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Get LLM configuration for a given tier.
   * Self-hosted models are configured via env vars.
   */
  getConfig(tier: ModelTier = ModelTier.BALANCED): LlmConfig {
    const tierKey = tier.toUpperCase();
    
    const baseUrl = this.configService.get<string>(`LLM_${tierKey}_BASE_URL`) 
      || this.configService.get<string>('LLM_BASE_URL') 
      || 'http://localhost:8000/v1';
    
    const model = this.configService.get<string>(`LLM_${tierKey}_MODEL`) 
      || this.configService.get<string>('LLM_MODEL') 
      || 'qwen2.5-7b-instruct';

    const temperature = Number(
      this.configService.get<string>(`LLM_${tierKey}_TEMPERATURE`) 
      || this.configService.get<string>('LLM_TEMPERATURE') 
      || 0.3
    );

    const maxTokens = parseInt(
      String(
        this.configService.get<string>(`LLM_${tierKey}_MAX_TOKENS`) 
        || this.configService.get<string>('LLM_MAX_TOKENS') 
        || 1024
      ),
      10
    );

    const timeoutMs = parseInt(
      String(
        this.configService.get<string>(`LLM_${tierKey}_TIMEOUT_MS`) 
        || this.configService.get<string>('LLM_TIMEOUT_MS') 
        || 30000
      ),
      10
    );

    const apiKey = this.configService.get<string>(`LLM_${tierKey}_API_KEY`) 
      || this.configService.get<string>('LLM_API_KEY') 
      || undefined;

    return {
      baseUrl: baseUrl.replace(/\/$/, ''),
      model,
      temperature,
      maxTokens,
      timeoutMs,
      apiKey,
    };
  }

  /**
   * Send a chat completion request to the self-hosted LLM endpoint.
   * The endpoint must be OpenAI-compatible: POST /chat/completions
   */
  async chat(
    messages: LlmMessage[],
    tier: ModelTier = ModelTier.BALANCED,
    options?: { responseFormat?: { type: string }; tools?: any[] }
  ): Promise<LlmResponse> {
    const config = this.getConfig(tier);
    const startTime = Date.now();

    this.logger.debug(`LLM request to ${config.baseUrl} using model ${config.model}`);

    const body: any = {
      model: config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.name && { name: m.name }),
        ...(m.tool_calls && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      })),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    };

    if (options?.responseFormat) {
      body.response_format = options.responseFormat;
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const response = await axios.post(
        `${config.baseUrl}/chat/completions`,
        body,
        {
          headers,
          timeout: config.timeoutMs,
        }
      );

      const latencyMs = Date.now() - startTime;
      const choice = response.data.choices?.[0];
      const usage = response.data.usage || {};

      const result: LlmResponse = {
        content: this.extractContent(choice),
        model: response.data.model || config.model,
        inputTokens: usage.prompt_tokens || this.estimateTokens(messages),
        outputTokens: usage.completion_tokens || this.estimateTokensFromText(this.extractContent(choice)),
        finishReason: choice?.finish_reason || 'stop',
        rawResponse: response.data,
      };

      this.logger.debug(
        `LLM response: ${result.inputTokens} input tokens, ${result.outputTokens} output tokens, ${latencyMs}ms`
      );

      return result;
    } catch (error: any) {
      this.logger.error('LLM request failed:', error.message);
      if (error.response) {
        this.logger.error('LLM error response:', JSON.stringify(error.response.data));
      }
      throw new Error(`LLM request failed: ${error.message}`);
    }
  }

  /**
   * Extract content from an LLM choice, handling text and tool_calls.
   */
  private extractContent(choice: any): string {
    if (!choice) return '';
    if (choice.message?.content) return choice.message.content;
    if (choice.message?.tool_calls) {
      return JSON.stringify({ tool_calls: choice.message.tool_calls });
    }
    if (typeof choice.text === 'string') return choice.text;
    return '';
  }

  /**
   * Rough token estimator for self-hosted models that don't return usage.
   */
  private estimateTokens(messages: LlmMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimateTokensFromText(m.content), 0);
  }

  private estimateTokensFromText(text: string): number {
    if (!text) return 0;
    // Rough estimate: 1 token ~= 4 characters for English, more conservative for mixed text
    return Math.ceil(text.length / 3.5);
  }

  /**
   * Select model tier based on task complexity.
   */
  selectTier(task: string): ModelTier {
    switch (task) {
      case 'intent_classification':
      case 'simple_search':
        return ModelTier.FAST;
      case 'product_comparison':
      case 'action_confirmation':
      case 'complex_reasoning':
        return ModelTier.STRONG;
      default:
        return ModelTier.BALANCED;
    }
  }
}
