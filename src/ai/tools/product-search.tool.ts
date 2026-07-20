import { Injectable, Logger } from '@nestjs/common';
import { IkoSearchService } from '../../iko/iko-search.service';
import { IkoSearchProductsDto } from '../../iko/dto/iko-search.dto';
import { VectorSearchService } from '../core/vector-search.service';
import { ProductSearchToolParams } from '../dto/ai.dto';

@Injectable()
export class ProductSearchTool {
  private readonly logger = new Logger(ProductSearchTool.name);

  constructor(
    private ikoSearchService: IkoSearchService,
    private vectorSearchService: VectorSearchService,
  ) {}

  getDescription(): any {
    return {
      type: 'function',
      function: {
        name: 'search_products',
        description: 'Search for products on the Fretiko marketplace. Use this when users want to find items to buy.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Product search query' },
            category: { type: 'string', description: 'Product category filter' },
            location: { type: 'string', description: 'Location preference' },
            minPrice: { type: 'number', description: 'Minimum price in Freti' },
            maxPrice: { type: 'number', description: 'Maximum price in Freti' },
            limit: { type: 'number', description: 'Number of results (1-20)', default: 10 },
          },
          required: ['query'],
        },
      },
    };
  }

  async execute(params: ProductSearchToolParams, userId: string, userToken?: string) {
    const limit = Math.min(params.limit || 10, 20);

    // Try vector (semantic) search first
    try {
      const vectorResults = await this.vectorSearchService.searchProducts(params.query, {
        limit,
        category: params.category,
        minPrice: params.minPrice,
        maxPrice: params.maxPrice,
      });

      if (vectorResults && vectorResults.length > 0) {
        this.logger.debug(`Vector search returned ${vectorResults.length} products for "${params.query}"`);
        return {
          query: params.query,
          type: 'products',
          results: vectorResults.map(r => ({
            id: r.data.id,
            name: r.data.name,
            description: r.data.description,
            price: parseFloat(r.data.price) || 0,
            condition: r.data.condition,
            category_id: r.data.category_id,
            images: r.data.images || [],
            primary_image_url: r.data.primary_image_url,
            tags: r.data.tags || [],
            location: r.data.location,
            average_rating: r.data.average_rating || 0,
            review_count: r.data.review_count || 0,
            view_count: r.data.view_count || 0,
            like_count: r.data.like_count || 0,
            username: r.data.username,
            avatar_url: r.data.avatar_url,
            is_verified: r.data.is_verified,
            similarity: r.similarity,
          })),
          count: vectorResults.length,
          hasMore: false,
          searchMethod: 'vector',
        };
      }
    } catch (error: any) {
      this.logger.warn(`Vector search failed, falling back to keyword search: ${error.message}`);
    }

    // Fallback to keyword search
    const searchParams: IkoSearchProductsDto = {
      query: params.query,
      category: params.category,
      location: params.location,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      limit,
      page: params.page || 1,
    };

    const results = await this.ikoSearchService.searchProducts(userId, searchParams, userToken);
    return { ...results, searchMethod: 'keyword' };
  }
}
