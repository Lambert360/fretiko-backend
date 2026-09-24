import { Injectable } from '@nestjs/common';
import { AiIntent, AiToolCall } from '../dto/ai.dto';
import { ProductSearchTool } from '../tools/product-search.tool';
import { VendorSearchTool } from '../tools/vendor-search.tool';
import { ReviewSummaryTool } from '../tools/review-summary.tool';
import { TrendingTool } from '../tools/trending.tool';

export interface ToolExecutionResult {
  toolName: string;
  result: any;
  latencyMs: number;
  error?: string;
}

@Injectable()
export class ToolRouterService {
  constructor(
    private productSearchTool: ProductSearchTool,
    private vendorSearchTool: VendorSearchTool,
    private reviewSummaryTool: ReviewSummaryTool,
    private trendingTool: TrendingTool,
  ) {}

  async executeTools(
    intent: AiIntent,
    parameters: Record<string, any>,
    userId: string,
    userToken?: string
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    const startTime = Date.now();

    try {
      switch (intent) {
        case AiIntent.PRODUCT_SEARCH:
        case AiIntent.COMPARISON:
          const productResult = await this.productSearchTool.execute(
            {
              query: parameters.query || '',
              category: parameters.category,
              location: parameters.location,
              minPrice: parameters.minPrice,
              maxPrice: parameters.maxPrice,
              limit: parameters.limit || 10,
              page: parameters.page || 1,
            },
            userId,
            userToken
          );
          results.push({
            toolName: 'product_search',
            result: productResult,
            latencyMs: Date.now() - startTime,
          });

          // For comparison, also fetch reviews for top items
          if (intent === AiIntent.COMPARISON && productResult?.results?.length > 0) {
            const topIds = productResult.results.slice(0, 4).map((p: any) => p.id);
            const reviewsResult = await this.reviewSummaryTool.execute({ productIds: topIds }, userId, userToken);
            results.push({
              toolName: 'review_summary',
              result: reviewsResult,
              latencyMs: Date.now() - startTime,
            });
          }
          break;

        case AiIntent.VENDOR_SEARCH:
          const vendorResult = await this.vendorSearchTool.execute(
            {
              query: parameters.query || '',
              category: parameters.category,
              location: parameters.location,
              isVerified: parameters.isVerified,
              limit: parameters.limit || 10,
              page: parameters.page || 1,
            },
            userId,
            userToken
          );
          results.push({
            toolName: 'vendor_search',
            result: vendorResult,
            latencyMs: Date.now() - startTime,
          });
          break;

        case AiIntent.TRENDING:
          const trendingResult = await this.trendingTool.execute(
            {
              location: parameters.location,
              category: parameters.category,
              limit: parameters.limit || 10,
            },
            userId,
            userToken
          );
          results.push({
            toolName: 'trending',
            result: trendingResult,
            latencyMs: Date.now() - startTime,
          });
          break;

        default:
          results.push({
            toolName: 'none',
            result: { message: 'No tools needed for this intent.' },
            latencyMs: 0,
          });
      }
    } catch (error: any) {
      results.push({
        toolName: 'error',
        result: null,
        latencyMs: Date.now() - startTime,
        error: error.message,
      });
    }

    return results;
  }

  getToolDescriptions(): any[] {
    return [
      this.productSearchTool.getDescription(),
      this.vendorSearchTool.getDescription(),
      this.reviewSummaryTool.getDescription(),
      this.trendingTool.getDescription(),
    ];
  }
}
