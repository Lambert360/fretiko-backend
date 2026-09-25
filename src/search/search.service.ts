import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProductsService } from '../products/products.service';
import { ServicesService } from '../services/services.service';
import { UsersService } from '../users/users.service';
import { RidersService } from '../riders/riders.service';
import { RiderProfile } from '../riders/riders.controller';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { escapePostgrestTerm } from '../shared/postgrest';
import { SearchQueryDto, SearchType, TrendingSearchDto, FeaturedContentDto, SearchSuggestionsDto } from './dto/search.dto';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly supabase;

  constructor(
    private readonly productsService: ProductsService,
    private readonly servicesService: ServicesService,
    private readonly usersService: UsersService,
    private readonly ridersService: RidersService,
    private readonly configService: ConfigService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  // Map the public sortBy enum to the per-entity sort options used by the
  // product/service query builders.
  private mapSort(sortBy?: SearchQueryDto['sortBy']) {
    switch (sortBy) {
      case 'price_asc': return 'price_asc' as const;
      case 'price_desc': return 'price_desc' as const;
      case 'rating': return 'rating' as const;
      case 'popular': return 'popular' as const;
      case 'newest': return 'newest' as const;
      default: return undefined;
    }
  }

  async search(searchQuery: SearchQueryDto, userId?: string) {
    this.logger.log(`Performing comprehensive search - Query: "${searchQuery.query || 'empty'}", Type: ${searchQuery.type || 'all'}, User: ${userId || 'anonymous'}`);

    const results = {
      query: searchQuery.query,
      type: searchQuery.type || SearchType.ALL,
      pagination: {
        page: searchQuery.page || 1,
        limit: searchQuery.limit || 20,
        total: 0,
      },
      results: {
        products: [] as any[],
        services: [] as any[],
        people: [] as any[],
        providers: [] as any[],
        vendors: [] as any[],
      },
      suggestions: [],
    };

    try {
      // Sanitize search query
      const sanitizedQuery = this.sanitizeSearchQuery(searchQuery.query);

      // Treat leading '#' as hashtag search by stripping the hash for underlying services
      let effectiveQuery = sanitizedQuery;
      if (effectiveQuery && effectiveQuery.startsWith('#')) {
        effectiveQuery = effectiveQuery.slice(1);
      }

      const searchParams = { ...searchQuery, query: effectiveQuery };

      // If no specific type, search all categories
      if (searchQuery.type === SearchType.ALL || !searchQuery.type) {
        // Search in parallel for better performance
        const [products, services, people, providers, vendors] = await Promise.allSettled([
          this.searchProducts(searchParams, userId),
          this.searchServices(searchParams, userId),
          this.searchPeople(searchParams, userId),
          this.searchProviders(searchParams),
          this.searchVendors(searchParams),
        ]);

        results.results.products = products.status === 'fulfilled' ? products.value || [] : [];
        results.results.services = services.status === 'fulfilled' ? services.value || [] : [];
        results.results.people = people.status === 'fulfilled' ? people.value || [] : [];
        results.results.providers = providers.status === 'fulfilled' ? providers.value || [] : [];
        results.results.vendors = vendors.status === 'fulfilled' ? vendors.value || [] : [];

        // Log any failed searches
        if (products.status === 'rejected') this.logger.warn('Product search failed:', products.reason);
        if (services.status === 'rejected') this.logger.warn('Service search failed:', services.reason);
        if (people.status === 'rejected') this.logger.warn('People search failed:', people.reason);
        if (providers.status === 'rejected') this.logger.warn('Provider search failed:', providers.reason);
        if (vendors.status === 'rejected') this.logger.warn('Vendor search failed:', vendors.reason);
      } else {
        // Search specific category
        switch (searchQuery.type) {
          case SearchType.PRODUCTS:
            results.results.products = await this.searchProducts(searchParams, userId) || [];
            break;
          case SearchType.SERVICES:
            results.results.services = await this.searchServices(searchParams, userId) || [];
            break;
          case SearchType.PEOPLE:
            results.results.people = await this.searchPeople(searchParams, userId) || [];
            break;
          case SearchType.PROVIDERS:
            results.results.providers = await this.searchProviders(searchParams) || [];
            break;
          case SearchType.VENDORS:
            results.results.vendors = await this.searchVendors(searchParams) || [];
            break;
        }
      }

      // Calculate total results
      results.pagination.total =
        results.results.products.length +
        results.results.services.length +
        results.results.people.length +
        results.results.providers.length +
        results.results.vendors.length;

      this.logger.log(`Search completed - Total results: ${results.pagination.total}`);
      return results;
    } catch (error: any) {
      this.logger.error('Search failed:', error.message);
      throw error;
    }
  }

  async getTrendingSearches(trendingQuery: TrendingSearchDto) {
    this.logger.log(`Fetching trending searches - Location: ${trendingQuery.location || 'all'}, Limit: ${trendingQuery.limit}`);

    // Real trending: sales-recency-weighted products (trending_products view,
    // migration 226). The view has no product name, so resolve names in a
    // second query.
    const { data: rows, error } = await this.supabase
      .from('trending_products')
      .select('product_id, order_count, trending_score')
      .order('trending_score', { ascending: false })
      .limit(trendingQuery.limit || 10);

    if (error || !rows?.length) {
      if (error) this.logger.warn('Trending products query failed:', error.message);
      return [];
    }

    const { data: products } = await this.supabase
      .from('products')
      .select('id, name')
      .in('id', rows.map((r: any) => r.product_id))
      .eq('status', 'active')
      .is('deleted_at', null);

    const nameById = new Map((products || []).map((p: any) => [p.id, p.name]));

    return rows
      .filter((r: any) => nameById.has(r.product_id))
      .map((r: any) => ({
        query: nameById.get(r.product_id),
        count: r.order_count,
        category: 'products',
      }));
  }

  async getFeaturedContent(featuredQuery: FeaturedContentDto, userId?: string) {
    this.logger.log(`Fetching featured content - Type: ${featuredQuery.type || 'all'}, Location: ${featuredQuery.location || 'all'}, Limit: ${featuredQuery.limit}`);

    const featured: any = {
      products: [],
      services: [],
      people: [],
      providers: [],
      vendors: [],
    };

    try {
      // Fetch featured content from each category
      if (!featuredQuery.type || featuredQuery.type === SearchType.ALL) {
        const [products, services, people, providers, vendors] = await Promise.allSettled([
          this.getFeaturedProducts(featuredQuery.limit || 10, userId),
          this.getFeaturedServices(featuredQuery.limit || 10, userId),
          this.getFeaturedPeople(featuredQuery.limit || 10, userId),
          this.getFeaturedProviders(featuredQuery.limit || 10),
          this.getFeaturedVendors(featuredQuery.limit || 10),
        ]);

        featured.products = products.status === 'fulfilled' ? products.value : [];
        featured.services = services.status === 'fulfilled' ? services.value : [];
        featured.people = people.status === 'fulfilled' ? people.value : [];
        featured.providers = providers.status === 'fulfilled' ? providers.value : [];
        featured.vendors = vendors.status === 'fulfilled' ? vendors.value : [];
      } else {
        switch (featuredQuery.type) {
          case SearchType.PRODUCTS:
            featured.products = await this.getFeaturedProducts(featuredQuery.limit || 10, userId);
            break;
          case SearchType.SERVICES:
            featured.services = await this.getFeaturedServices(featuredQuery.limit || 10, userId);
            break;
          case SearchType.PEOPLE:
            featured.people = await this.getFeaturedPeople(featuredQuery.limit || 10, userId);
            break;
          case SearchType.PROVIDERS:
            featured.providers = await this.getFeaturedProviders(featuredQuery.limit || 10);
            break;
          case SearchType.VENDORS:
            featured.vendors = await this.getFeaturedVendors(featuredQuery.limit || 10);
            break;
        }
      }

      this.logger.log('Featured content fetched successfully');
      return featured;
    } catch (error: any) {
      this.logger.error('Failed to fetch featured content:', error.message);
      throw error;
    }
  }

  async getSearchSuggestions(suggestionsQuery: SearchSuggestionsDto) {
    this.logger.log(`Fetching search suggestions for: ${suggestionsQuery.query}`);

    // Real suggestions: product + service names containing the query.
    const q = escapePostgrestTerm(suggestionsQuery.query);
    if (q.length < 2) return [];

    const limit = suggestionsQuery.limit || 5;
    const [products, services] = await Promise.all([
      this.supabase
        .from('products')
        .select('name')
        .eq('status', 'active')
        .is('deleted_at', null)
        .ilike('name', `%${q}%`)
        .limit(limit),
      this.supabase
        .from('services')
        .select('name')
        .eq('status', 'active')
        .ilike('name', `%${q}%`)
        .limit(limit),
    ]);

    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const row of [...(products.data || []), ...(services.data || [])] as any[]) {
      const name = (row.name || '').trim();
      const key = name.toLowerCase();
      if (name && !seen.has(key)) {
        seen.add(key);
        suggestions.push(name);
      }
      if (suggestions.length >= limit) break;
    }
    return suggestions;
  }

  async getPersonalizedRecommendations(userId: string, type?: SearchType, limit: number = 10) {
    this.logger.log(`Fetching personalized recommendations for user: ${userId}`);
    
    try {
      // Get user preferences/history - mock for now
      const recommendations: any = {
        products: [],
        services: [],
        people: [],
        providers: [],
        vendors: [],
      };

      // Get recommendations based on user activity
      if (!type || type === SearchType.ALL) {
        const [products, services, people, providers, vendors] = await Promise.allSettled([
          this.getRecommendedProducts(userId, limit),
          this.getRecommendedServices(userId, limit),
          this.getRecommendedPeople(userId, limit),
          this.getRecommendedProviders(userId, limit),
          this.getRecommendedVendors(limit),
        ]);

        recommendations.products = products.status === 'fulfilled' ? products.value : [];
        recommendations.services = services.status === 'fulfilled' ? services.value : [];
        recommendations.people = people.status === 'fulfilled' ? people.value : [];
        recommendations.providers = providers.status === 'fulfilled' ? providers.value : [];
        recommendations.vendors = vendors.status === 'fulfilled' ? vendors.value : [];
      } else {
        switch (type) {
          case SearchType.PRODUCTS:
            recommendations.products = await this.getRecommendedProducts(userId, limit);
            break;
          case SearchType.SERVICES:
            recommendations.services = await this.getRecommendedServices(userId, limit);
            break;
          case SearchType.PEOPLE:
            recommendations.people = await this.getRecommendedPeople(userId, limit);
            break;
          case SearchType.PROVIDERS:
            recommendations.providers = await this.getRecommendedProviders(userId, limit);
            break;
          case SearchType.VENDORS:
            recommendations.vendors = await this.getRecommendedVendors(limit);
            break;
        }
      }

      return recommendations;
    } catch (error: any) {
      this.logger.error('Failed to get personalized recommendations:', error.message);
      throw error;
    }
  }

  // Private helper methods - using simplified calls that work with existing services
  private async searchProducts(searchQuery: SearchQueryDto, userId?: string) {
    try {
      const limit = Math.min(searchQuery.limit || 10, 10);
      const queryParams = {
        search: searchQuery.query || '',
        limit,
        offset: ((searchQuery.page || 1) - 1) * limit,
        category_id: searchQuery.category,
        price_min: searchQuery.minPrice,
        price_max: searchQuery.maxPrice,
        min_rating: searchQuery.minRating,
        sort: this.mapSort(searchQuery.sortBy),
      };
      return await this.productsService.getProducts(queryParams, userId);
    } catch (error: any) {
      this.logger.error('Product search failed:', error.message);
      return [];
    }
  }

  private async searchServices(searchQuery: SearchQueryDto, userId?: string) {
    try {
      const limit = Math.min(searchQuery.limit || 10, 10);
      const queryParams = {
        search: searchQuery.query || '',
        limit,
        offset: ((searchQuery.page || 1) - 1) * limit,
        viewerId: userId,
        price_min: searchQuery.minPrice,
        price_max: searchQuery.maxPrice,
        min_rating: searchQuery.minRating,
        sort: this.mapSort(searchQuery.sortBy),
      };
      return await this.servicesService.getServices(queryParams);
    } catch (error: any) {
      this.logger.error('Service search failed:', error.message);
      return [];
    }
  }

  private async searchPeople(searchQuery: SearchQueryDto, userId?: string) {
    try {
      const query = searchQuery.query || '';
      const limit = Math.min(searchQuery.limit || 10, 10);
      return await this.usersService.searchUsers(query, limit, {
        verifiedOnly: searchQuery.verifiedOnly,
        offset: ((searchQuery.page || 1) - 1) * limit,
      });
    } catch (error: any) {
      this.logger.error('People search failed:', error.message);
      return [];
    }
  }

  private async searchProviders(searchQuery: SearchQueryDto) {
    try {
      const limit = searchQuery.limit || 20;
      const riders = await this.ridersService.getRidersForSearch(
        limit,
        searchQuery.query,
        ((searchQuery.page || 1) - 1) * limit,
      );
      return this.mapRiderProfiles(riders);
    } catch (error: any) {
      this.logger.error('Provider search failed:', error.message);
      return [];
    }
  }

  // Vendors = verified sellers (same criteria as the Stores directory)
  private async searchVendors(searchQuery: SearchQueryDto) {
    try {
      const limit = Math.min(searchQuery.limit || 10, 10);
      return await this.usersService.searchVendors(
        searchQuery.query || '',
        limit,
        ((searchQuery.page || 1) - 1) * limit,
      );
    } catch (error: any) {
      this.logger.error('Vendor search failed:', error.message);
      return [];
    }
  }

  private async getFeaturedProducts(limit: number = 10, userId?: string) {
    try {
      // Featured = most-viewed products; recommendations use newest so the
      // two sections don't render identical items.
      return await this.productsService.getProducts({ limit, sort: 'popular' }, userId);
    } catch (error: any) {
      this.logger.error('Featured products failed:', error.message);
      return [];
    }
  }

  private async getFeaturedServices(limit: number = 10, userId?: string) {
    try {
      return await this.servicesService.getServices({ limit, viewerId: userId, sort: 'popular' });
    } catch (error: any) {
      this.logger.error('Featured services failed:', error.message);
      return [];
    }
  }

  private async getFeaturedPeople(limit: number = 10, userId?: string) {
    try {
      // Use empty search to get featured people
      return await this.usersService.searchUsers('', limit);
    } catch (error: any) {
      this.logger.error('Featured people failed:', error.message);
      return [];
    }
  }

  private async getFeaturedProviders(limit: number = 10) {
    try {
      const riders = await this.ridersService.getRidersForSearch(limit);
      return this.mapRiderProfiles(riders);
    } catch (error: any) {
      this.logger.error('Featured providers failed:', error.message);
      return [];
    }
  }

  private async getFeaturedVendors(limit: number = 10) {
    try {
      return await this.usersService.searchVendors('', limit);
    } catch (error: any) {
      this.logger.error('Featured vendors failed:', error.message);
      return [];
    }
  }

  private async getRecommendedProducts(userId: string, limit: number = 10) {
    try {
      return await this.productsService.getProducts({ limit, sort: 'newest' }, userId);
    } catch (error: any) {
      this.logger.error('Recommended products failed:', error.message);
      return [];
    }
  }

  private async getRecommendedServices(userId: string, limit: number = 10) {
    try {
      return await this.servicesService.getServices({ limit, viewerId: userId, sort: 'newest' });
    } catch (error: any) {
      this.logger.error('Recommended services failed:', error.message);
      return [];
    }
  }

  private async getRecommendedPeople(userId: string, limit: number = 10) {
    try {
      return await this.usersService.searchUsers('', limit);
    } catch (error: any) {
      this.logger.error('Recommended people failed:', error.message);
      return [];
    }
  }

  private async getRecommendedProviders(userId: string, limit: number = 10) {
    try {
      const riders = await this.ridersService.getRidersForSearch(limit);
      return this.mapRiderProfiles(riders);
    } catch (error: any) {
      this.logger.error('Recommended providers failed:', error.message);
      return [];
    }
  }

  private async getRecommendedVendors(limit: number = 10) {
    try {
      return await this.usersService.searchVendors('', limit);
    } catch (error: any) {
      this.logger.error('Recommended vendors failed:', error.message);
      return [];
    }
  }

  // Utility methods
  private mapRiderProfiles(riders: RiderProfile[]): any[] {
    return riders.map(rider => ({
      ...rider,
      distance: rider.distanceFromPickup,
      verified: rider.is_verified === true,
    }));
  }

  private sanitizeSearchQuery(query?: string): string {
    if (!query) return '';
    
    // Remove potentially harmful characters and trim
    return query
      .trim()
      .replace(/[<>'"&]/g, '') // Remove HTML/script injection chars
      .replace(/[\r\n\t]/g, ' ') // Replace line breaks with spaces
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .substring(0, 500); // Limit length
  }
}