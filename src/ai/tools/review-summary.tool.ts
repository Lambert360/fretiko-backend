import { Injectable } from '@nestjs/common';
import { ProductsService } from '../../products/products.service';

@Injectable()
export class ReviewSummaryTool {
  constructor(private productsService: ProductsService) {}

  getDescription(): any {
    return {
      type: 'function',
      function: {
        name: 'summarize_reviews',
        description: 'Get review summaries for one or more products. Use this for comparisons or when users ask about product quality.',
        parameters: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of product IDs to summarize reviews for',
            },
          },
          required: ['productIds'],
        },
      },
    };
  }

  async execute(params: { productIds: string[] }, userId: string, userToken?: string) {
    const summaries = await Promise.all(
      params.productIds.slice(0, 4).map(async (id) => {
        try {
          const reviews = await this.productsService.getProductReviews(id);
          return {
            productId: id,
            reviewCount: reviews.length,
            averageRating: this.calculateAverage(reviews),
            topPositive: this.extractTopThemes(reviews, true),
            topNegative: this.extractTopThemes(reviews, false),
            sampleReviews: reviews.slice(0, 3).map(r => ({
              rating: r.rating,
              comment: r.comment?.substring(0, 200),
            })),
          };
        } catch (error) {
          return {
            productId: id,
            reviewCount: 0,
            averageRating: 0,
            topPositive: [],
            topNegative: [],
            sampleReviews: [],
          };
        }
      })
    );

    return {
      productIds: params.productIds,
      summaries,
    };
  }

  private calculateAverage(reviews: any[]): number {
    if (!reviews.length) return 0;
    const sum = reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    return Math.round((sum / reviews.length) * 10) / 10;
  }

  private extractTopThemes(reviews: any[], positive: boolean): string[] {
    const filtered = reviews.filter(r => positive ? (r.rating || 0) >= 4 : (r.rating || 0) <= 2);
    const words = filtered
      .map(r => (r.comment || '').toLowerCase())
      .join(' ')
      .split(/\s+/)
      .filter(w => w.length > 3);
    
    const frequency: Record<string, number> = {};
    words.forEach(w => {
      frequency[w] = (frequency[w] || 0) + 1;
    });

    return Object.entries(frequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([word]) => word);
  }
}
