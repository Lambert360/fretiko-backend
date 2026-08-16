import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../../shared/supabase.client';
import { AiRequestMetadata } from '../dto/ai.dto';

@Injectable()
export class CostTrackingInterceptor {
  private readonly logger = new Logger(CostTrackingInterceptor.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async record(metadata: Partial<AiRequestMetadata>): Promise<void> {
    try {
      const logEntry = {
        user_id: metadata.userId,
        model: metadata.model || 'self-hosted',
        intent: metadata.intent,
        input_tokens: metadata.inputTokens || 0,
        output_tokens: metadata.outputTokens || 0,
        tool_calls: metadata.toolCalls || 0,
        latency_ms: metadata.latencyMs || 0,
        estimated_cost: metadata.estimatedCost || 0,
        success: metadata.success ?? true,
        error_message: metadata.errorMessage || null,
        created_at: new Date().toISOString(),
      };

      const { error } = await this.supabase
        .from('ai_usage_logs')
        .insert(logEntry);

      if (error) {
        this.logger.error('Failed to log AI usage:', error);
      }
    } catch (error) {
      this.logger.error('Cost tracking error:', error);
    }
  }

  /**
   * Estimate cost for self-hosted inference.
   * Since exact cost depends on hardware, we use a placeholder formula.
   * Adjust based on your GPU/cloud costs.
   */
  estimateCost(inputTokens: number, outputTokens: number, model: string): number {
    // Self-hosted cost estimate: $0.0001 per 1K tokens combined
    const totalTokens = inputTokens + outputTokens;
    return (totalTokens / 1000) * 0.0001;
  }

  async getUsageStats(userId: string, days = 30): Promise<{
    totalRequests: number;
    totalTokens: number;
    averageLatency: number;
    successRate: number;
  }> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    
    const { data, error } = await this.supabase
      .from('ai_usage_logs')
      .select('input_tokens, output_tokens, latency_ms, success')
      .eq('user_id', userId)
      .gte('created_at', since);

    if (error || !data) {
      return { totalRequests: 0, totalTokens: 0, averageLatency: 0, successRate: 0 };
    }

    const totalRequests = data.length;
    const totalTokens = data.reduce((sum, row) => sum + (row.input_tokens + row.output_tokens), 0);
    const averageLatency = totalRequests > 0
      ? data.reduce((sum, row) => sum + row.latency_ms, 0) / totalRequests
      : 0;
    const successCount = data.filter(row => row.success).length;
    const successRate = totalRequests > 0 ? (successCount / totalRequests) : 0;

    return {
      totalRequests,
      totalTokens,
      averageLatency: Math.round(averageLatency),
      successRate: Math.round(successRate * 100) / 100,
    };
  }
}
