import { Injectable } from '@nestjs/common';
import { ProductsService } from '../../products/products.service';
import { StoresService } from '../../stores/stores.service';

@Injectable()
export class TrendingTool {
  constructor(
    private productsService: ProductsService,
    private storesService: StoresService,
  ) {}

  getDescription(): any {
    return {
      type: 'function',
      function: {
        name: 'get_trending',
        description: 'Get trending products and vendors on Fretiko. Use this when users ask what is popular or trending.',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category' },
            location: { type: 'string', description: 'Location preference' },
            limit: { type: 'number', description: 'Number of results', default: 10 },
          },
        },
      },
    };
  }

  async execute(params: { category?: string; location?: string; limit?: number }, userId: string, userToken?: string) {
    const limit = Math.min(params.limit || 10, 20);

    const [trendingProducts, trendingVendors] = await Promise.all([
      this.productsService.getTrendingProducts(limit),
      this.storesService.getVerifiedStores(limit, 0),
    ]);

    // Filter by category if provided
    const categoryLower = params.category?.toLowerCase();
    const filteredProducts = categoryLower
      ? trendingProducts.filter((p: any) => p.category?.toLowerCase() === categoryLower)
      : trendingProducts;

    const filteredVendors = categoryLower
      ? trendingVendors.filter((v: any) => v.category?.toLowerCase() === categoryLower)
      : trendingVendors;

    return {
      products: filteredProducts.slice(0, limit),
      vendors: filteredVendors.slice(0, limit),
      count: filteredProducts.length + filteredVendors.length,
    };
  }
}
