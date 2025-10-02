import { Injectable, Logger } from '@nestjs/common';
import { ProductsService } from '../products/products.service';
import { ServicesService } from '../services/services.service';
import { UsersService } from '../users/users.service';
import { RidersService } from '../riders/riders.service';
import { SearchQueryDto, SearchType, TrendingSearchDto, FeaturedContentDto, SearchSuggestionsDto } from './dto/search.dto';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly productsService: ProductsService,
    private readonly servicesService: ServicesService,
    private readonly usersService: UsersService,
    private readonly ridersService: RidersService,
  ) {}

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
      },
      suggestions: [],
    };

    try {
      // Sanitize search query
      const sanitizedQuery = this.sanitizeSearchQuery(searchQuery.query);
      const searchParams = { ...searchQuery, query: sanitizedQuery };

      // If no specific type, search all categories
      if (searchQuery.type === SearchType.ALL || !searchQuery.type) {
        // Search in parallel for better performance
        const [products, services, people, providers] = await Promise.allSettled([
          this.searchProducts(searchParams),
          this.searchServices(searchParams),
          this.searchPeople(searchParams, userId),
          this.searchProviders(searchParams),
        ]);

        results.results.products = products.status === 'fulfilled' ? products.value || [] : [];
        results.results.services = services.status === 'fulfilled' ? services.value || [] : [];
        results.results.people = people.status === 'fulfilled' ? people.value || [] : [];
        results.results.providers = providers.status === 'fulfilled' ? providers.value || [] : [];

        // Log any failed searches
        if (products.status === 'rejected') this.logger.warn('Product search failed:', products.reason);
        if (services.status === 'rejected') this.logger.warn('Service search failed:', services.reason);
        if (people.status === 'rejected') this.logger.warn('People search failed:', people.reason);
        if (providers.status === 'rejected') this.logger.warn('Provider search failed:', providers.reason);
      } else {
        // Search specific category
        switch (searchQuery.type) {
          case SearchType.PRODUCTS:
            results.results.products = await this.searchProducts(searchParams) || [];
            break;
          case SearchType.SERVICES:
            results.results.services = await this.searchServices(searchParams) || [];
            break;
          case SearchType.PEOPLE:
            results.results.people = await this.searchPeople(searchParams, userId) || [];
            break;
          case SearchType.PROVIDERS:
            results.results.providers = await this.searchProviders(searchParams) || [];
            break;
        }
      }

      // Calculate total results
      results.pagination.total = 
        results.results.products.length +
        results.results.services.length +
        results.results.people.length +
        results.results.providers.length;

      this.logger.log(`Search completed - Total results: ${results.pagination.total}`);
      return results;
    } catch (error) {
      this.logger.error('Search failed:', error.message);
      throw error;
    }
  }

  async getTrendingSearches(trendingQuery: TrendingSearchDto) {
    this.logger.log(`Fetching trending searches - Location: ${trendingQuery.location || 'all'}, Limit: ${trendingQuery.limit}`);
    
    // Mock trending data for now - in production, this would come from analytics
    const trending = [
      { query: 'nike shoes', count: 1234, category: 'products' },
      { query: 'home cleaning', count: 987, category: 'services' },
      { query: 'iphone repair', count: 876, category: 'services' },
      { query: 'fitness trainer', count: 654, category: 'people' },
      { query: 'food delivery', count: 543, category: 'providers' },
      { query: 'laptop accessories', count: 432, category: 'products' },
      { query: 'house painting', count: 321, category: 'services' },
      { query: 'photographer', count: 234, category: 'people' },
      { query: 'car wash', count: 198, category: 'services' },
      { query: 'gaming setup', count: 156, category: 'products' },
    ];

    return trending
      .filter(item => !trendingQuery.location || Math.random() > 0.3) // Mock location filtering
      .slice(0, trendingQuery.limit);
  }

  async getFeaturedContent(featuredQuery: FeaturedContentDto, userId?: string) {
    this.logger.log(`Fetching featured content - Type: ${featuredQuery.type || 'all'}, Location: ${featuredQuery.location || 'all'}, Limit: ${featuredQuery.limit}`);

    const featured: any = {
      products: [],
      services: [],
      people: [],
      providers: [],
    };

    try {
      // Fetch featured content from each category
      if (!featuredQuery.type || featuredQuery.type === SearchType.ALL) {
        const [products, services, people, providers] = await Promise.allSettled([
          this.getFeaturedProducts(featuredQuery.limit || 10),
          this.getFeaturedServices(featuredQuery.limit || 10),
          this.getFeaturedPeople(featuredQuery.limit || 10, userId),
          this.getFeaturedProviders(featuredQuery.limit || 10),
        ]);

        featured.products = products.status === 'fulfilled' ? products.value : [];
        featured.services = services.status === 'fulfilled' ? services.value : [];
        featured.people = people.status === 'fulfilled' ? people.value : [];
        featured.providers = providers.status === 'fulfilled' ? providers.value : [];
      } else {
        switch (featuredQuery.type) {
          case SearchType.PRODUCTS:
            featured.products = await this.getFeaturedProducts(featuredQuery.limit || 10);
            break;
          case SearchType.SERVICES:
            featured.services = await this.getFeaturedServices(featuredQuery.limit || 10);
            break;
          case SearchType.PEOPLE:
            featured.people = await this.getFeaturedPeople(featuredQuery.limit || 10, userId);
            break;
          case SearchType.PROVIDERS:
            featured.providers = await this.getFeaturedProviders(featuredQuery.limit || 10);
            break;
        }
      }

      this.logger.log('Featured content fetched successfully');
      return featured;
    } catch (error) {
      this.logger.error('Failed to fetch featured content:', error.message);
      throw error;
    }
  }

  async getSearchSuggestions(suggestionsQuery: SearchSuggestionsDto) {
    this.logger.log(`Fetching search suggestions for: ${suggestionsQuery.query}`);
    
    // Mock suggestions - in production, this would use elasticsearch or similar
    const suggestions = [
      `${suggestionsQuery.query} near me`,
      `${suggestionsQuery.query} delivery`,
      `best ${suggestionsQuery.query}`,
      `${suggestionsQuery.query} price`,
      `${suggestionsQuery.query} reviews`,
      `cheap ${suggestionsQuery.query}`,
      `${suggestionsQuery.query} service`,
      `${suggestionsQuery.query} online`,
    ];

    return suggestions
      .filter(suggestion => suggestion.toLowerCase().includes(suggestionsQuery.query.toLowerCase()))
      .slice(0, suggestionsQuery.limit);
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
      };

      // Get recommendations based on user activity
      if (!type || type === SearchType.ALL) {
        const [products, services, people, providers] = await Promise.allSettled([
          this.getRecommendedProducts(userId, limit),
          this.getRecommendedServices(userId, limit),
          this.getRecommendedPeople(userId, limit),
          this.getRecommendedProviders(userId, limit),
        ]);

        recommendations.products = products.status === 'fulfilled' ? products.value : [];
        recommendations.services = services.status === 'fulfilled' ? services.value : [];
        recommendations.people = people.status === 'fulfilled' ? people.value : [];
        recommendations.providers = providers.status === 'fulfilled' ? providers.value : [];
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
        }
      }

      return recommendations;
    } catch (error) {
      this.logger.error('Failed to get personalized recommendations:', error.message);
      throw error;
    }
  }

  // Private helper methods - using simplified calls that work with existing services
  private async searchProducts(searchQuery: SearchQueryDto) {
    try {
      const queryParams = {
        search: searchQuery.query || '',
        limit: Math.min(searchQuery.limit || 10, 10),
      };
      return await this.productsService.getProducts(queryParams);
    } catch (error) {
      this.logger.error('Product search failed:', error.message);
      return [];
    }
  }

  private async searchServices(searchQuery: SearchQueryDto) {
    try {
      const queryParams = {
        search: searchQuery.query || '',
        limit: Math.min(searchQuery.limit || 10, 10),
      };
      return await this.servicesService.getServices(queryParams);
    } catch (error) {
      this.logger.error('Service search failed:', error.message);
      return [];
    }
  }

  private async searchPeople(searchQuery: SearchQueryDto, userId?: string) {
    try {
      // Use simplified search for users
      const query = searchQuery.query || '';
      const limit = Math.min(searchQuery.limit || 10, 10);
      return await this.usersService.searchUsers(query, limit);
    } catch (error) {
      this.logger.error('People search failed:', error.message);
      return [];
    }
  }

  private async searchProviders(searchQuery: SearchQueryDto) {
    try {
      // Return mock data for now since getRiders method doesn't exist
      return [
        {
          id: '1',
          name: 'Ahmed Hassan',
          rating: 4.9,
          vehicleType: 'bike',
          totalDeliveries: 1250,
          isOnline: true,
          distance: 0.5,
        },
        {
          id: '2', 
          name: 'Kemi Adeleke',
          rating: 4.8,
          vehicleType: 'car',
          totalDeliveries: 890,
          isOnline: true,
          distance: 1.2,
        }
      ];
    } catch (error) {
      this.logger.error('Provider search failed:', error.message);
      return [];
    }
  }

  private async getFeaturedProducts(limit: number = 10) {
    try {
      return await this.productsService.getProducts({ limit });
    } catch (error) {
      this.logger.error('Featured products failed:', error.message);
      return [];
    }
  }

  private async getFeaturedServices(limit: number = 10) {
    try {
      return await this.servicesService.getServices({ limit });
    } catch (error) {
      this.logger.error('Featured services failed:', error.message);
      return [];
    }
  }

  private async getFeaturedPeople(limit: number = 10, userId?: string) {
    try {
      // Use empty search to get featured people
      return await this.usersService.searchUsers('', limit);
    } catch (error) {
      this.logger.error('Featured people failed:', error.message);
      return [];
    }
  }

  private async getFeaturedProviders(limit: number = 10) {
    try {
      // Return mock featured providers
      return [
        {
          id: '1',
          name: 'Ahmed Hassan',
          rating: 4.9,
          vehicleType: 'bike',
          totalDeliveries: 1250,
          isOnline: true,
          verified: true,
        }
      ];
    } catch (error) {
      this.logger.error('Featured providers failed:', error.message);
      return [];
    }
  }

  private async getRecommendedProducts(userId: string, limit: number = 10) {
    try {
      // Get regular products as recommendations for now
      return await this.productsService.getProducts({ limit });
    } catch (error) {
      this.logger.error('Recommended products failed:', error.message);
      return [];
    }
  }

  private async getRecommendedServices(userId: string, limit: number = 10) {
    try {
      return await this.servicesService.getServices({ limit });
    } catch (error) {
      this.logger.error('Recommended services failed:', error.message);
      return [];
    }
  }

  private async getRecommendedPeople(userId: string, limit: number = 10) {
    try {
      return await this.usersService.searchUsers('', limit);
    } catch (error) {
      this.logger.error('Recommended people failed:', error.message);
      return [];
    }
  }

  private async getRecommendedProviders(userId: string, limit: number = 10) {
    try {
      // Return mock recommendations
      return [
        {
          id: '2',
          name: 'Kemi Adeleke', 
          rating: 4.8,
          vehicleType: 'car',
          totalDeliveries: 890,
          isOnline: true,
        }
      ];
    } catch (error) {
      this.logger.error('Recommended providers failed:', error.message);
      return [];
    }
  }

  // Utility methods
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