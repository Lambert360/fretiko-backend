import { Injectable, Logger } from '@nestjs/common';
import { StoresService } from '../../stores/stores.service';
import { VectorSearchService } from '../core/vector-search.service';
import { VendorSearchToolParams } from '../dto/ai.dto';

@Injectable()
export class VendorSearchTool {
  private readonly logger = new Logger(VendorSearchTool.name);

  constructor(
    private storesService: StoresService,
    private vectorSearchService: VectorSearchService,
  ) {}

  getDescription(): any {
    return {
      type: 'function',
      function: {
        name: 'search_vendors',
        description: 'Search for verified sellers and vendors on Fretiko. Use this when users want to find stores or sellers.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Vendor search query' },
            category: { type: 'string', description: 'Vendor category' },
            location: { type: 'string', description: 'Location preference' },
            isVerified: { type: 'boolean', description: 'Only verified vendors', default: true },
            limit: { type: 'number', description: 'Number of results (1-20)', default: 10 },
          },
          required: ['query'],
        },
      },
    };
  }

  async execute(params: VendorSearchToolParams, userId: string, userToken?: string) {
    const limit = Math.min(params.limit || 10, 20);

    // Try vector (semantic) search first
    try {
      const vectorResults = await this.vectorSearchService.searchVendors(params.query, {
        limit,
        isVerified: params.isVerified,
      });

      if (vectorResults && vectorResults.length > 0) {
        this.logger.debug(`Vector search returned ${vectorResults.length} vendors for "${params.query}"`);
        return {
          query: params.query,
          type: 'vendors',
          results: vectorResults.map(r => ({
            id: r.data.id,
            username: r.data.username,
            bio: r.data.bio,
            location: r.data.location,
            is_verified: r.data.is_verified,
            avatar_url: r.data.avatar_url,
            is_seller: r.data.is_seller,
            similarity: r.similarity,
          })),
          count: vectorResults.length,
          hasMore: false,
          searchMethod: 'vector',
        };
      }
    } catch (error: any) {
      this.logger.warn(`Vector vendor search failed, falling back to keyword search: ${error.message}`);
    }

    // Fallback to keyword search
    const offset = ((params.page || 1) - 1) * limit;
    let stores: any[] = [];

    if (params.category) {
      try {
        stores = await this.storesService.getStoresByCategory(params.category, limit, offset);
      } catch (error) {
        stores = await this.storesService.searchVerifiedStores(params.query, limit, offset);
      }
    } else {
      stores = await this.storesService.searchVerifiedStores(params.query, limit, offset);
    }

    const filtered = params.isVerified !== false
      ? stores.filter(s => s.is_verified)
      : stores;

    return {
      query: params.query,
      type: 'vendors',
      results: filtered,
      count: filtered.length,
      hasMore: false,
      searchMethod: 'keyword',
    };
  }
}
