import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchService } from '../search/search.service';
import { SearchType } from '../search/dto/search.dto';
import { ProductsService } from '../products/products.service';
import { ServicesService } from '../services/services.service';
import { UsersService } from '../users/users.service';
import { IkoService } from './iko.service';
import {
  IkoSearchProductsDto,
  IkoSearchServicesDto,
  IkoSearchUsersDto,
  IkoRecommendationsDto,
  IkoSearchResult,
  IkoRecommendationResult,
} from './dto/iko-search.dto';

@Injectable()
export class IkoSearchService {
  private readonly logger = new Logger(IkoSearchService.name);

  constructor(
    private readonly searchService: SearchService,
    private readonly productsService: ProductsService,
    private readonly servicesService: ServicesService,
    private readonly usersService: UsersService,
    private readonly ikoService: IkoService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Search products with AI-optimized results
   */
  async searchProducts(
    userId: string,
    searchParams: IkoSearchProductsDto,
    userToken?: string
  ): Promise<IkoSearchResult> {
    this.logger.log(`Iko searching products for user: ${userId}, query: "${searchParams.query}"`);

    try {
      // Get user preferences for personalization
      const preferences = await this.ikoService.getIkoPreferences(userId, userToken);

      // Enhance search with user preferences
      const enhancedSearch = {
        query: searchParams.query,
        type: SearchType.PRODUCTS,
        category: searchParams.category,
        location: searchParams.location || preferences.location_preferences,
        minPrice: searchParams.minPrice,
        maxPrice: searchParams.maxPrice || this.getBudgetForCategory(preferences, searchParams.category),
        limit: searchParams.limit || 10,
        page: searchParams.page || 1,
      };

      // Perform search
      const searchResults = await this.searchService.search(enhancedSearch, userId);

      // Format results for AI consumption
      const formattedResults = searchResults.results.products.map(product => ({
        id: product.id,
        title: product.title,
        description: product.description,
        price: product.price,
        originalPrice: product.originalPrice,
        discount: product.discount,
        category: product.category,
        seller: {
          id: product.sellerId,
          name: product.sellerName,
          rating: product.sellerRating,
        },
        images: product.images,
        rating: product.rating,
        reviewCount: product.reviewCount,
        availability: product.availability,
        location: product.location,
        tags: product.tags,
        isRecommended: this.isRecommendedForUser(product, preferences),
      }));

      // Record search for learning
      await this.recordSearchInteraction(userId, 'products', searchParams.query, formattedResults.length, userToken);

      return {
        query: searchParams.query,
        type: SearchType.PRODUCTS,
        results: formattedResults,
        count: formattedResults.length,
        hasMore: searchResults.pagination.total > (searchParams.page || 1) * (searchParams.limit || 10),
        suggestions: this.generateProductSuggestions(searchParams.query, preferences),
        userContext: {
          preferredCategories: preferences.favorite_categories,
          budgetRange: this.getBudgetForCategory(preferences, searchParams.category),
          locationPreference: preferences.location_preferences,
        },
      };
    } catch (error) {
      this.logger.error('Error in Iko product search:', error);
      throw error;
    }
  }

  /**
   * Search services with AI-optimized results
   */
  async searchServices(
    userId: string,
    searchParams: IkoSearchServicesDto,
    userToken?: string
  ): Promise<IkoSearchResult> {
    this.logger.log(`Iko searching services for user: ${userId}, query: "${searchParams.query}"`);

    try {
      // Get user preferences for personalization
      const preferences = await this.ikoService.getIkoPreferences(userId, userToken);

      // Enhance search with user preferences
      const enhancedSearch = {
        query: searchParams.query,
        type: SearchType.SERVICES,
        category: searchParams.category,
        location: searchParams.location || preferences.location_preferences,
        minPrice: searchParams.minPrice,
        maxPrice: searchParams.maxPrice || this.getBudgetForCategory(preferences, searchParams.category),
        limit: searchParams.limit || 10,
        page: searchParams.page || 1,
      };

      // Perform search
      const searchResults = await this.searchService.search(enhancedSearch, userId);

      // Format results for AI consumption
      const formattedResults = searchResults.results.services.map(service => ({
        id: service.id,
        title: service.title,
        description: service.description,
        price: service.price,
        duration: service.duration,
        category: service.category,
        provider: {
          id: service.providerId,
          name: service.providerName,
          rating: service.providerRating,
          completedJobs: service.completedJobs,
        },
        images: service.images,
        rating: service.rating,
        reviewCount: service.reviewCount,
        availability: service.availability,
        location: service.location,
        tags: service.tags,
        isRecommended: this.isRecommendedForUser(service, preferences),
      }));

      // Record search for learning
      await this.recordSearchInteraction(userId, 'services', searchParams.query, formattedResults.length, userToken);

      return {
        query: searchParams.query,
        type: SearchType.SERVICES,
        results: formattedResults,
        count: formattedResults.length,
        hasMore: searchResults.pagination.total > (searchParams.page || 1) * (searchParams.limit || 10),
        suggestions: this.generateServiceSuggestions(searchParams.query, preferences),
        userContext: {
          preferredCategories: preferences.favorite_categories,
          budgetRange: this.getBudgetForCategory(preferences, searchParams.category),
          locationPreference: preferences.location_preferences,
        },
      };
    } catch (error) {
      this.logger.error('Error in Iko service search:', error);
      throw error;
    }
  }

  /**
   * Search users with AI-optimized results
   */
  async searchUsers(
    userId: string,
    searchParams: IkoSearchUsersDto,
    userToken?: string
  ): Promise<IkoSearchResult> {
    this.logger.log(`Iko searching users for user: ${userId}, query: "${searchParams.query}"`);

    try {
      // Enhance search
      const enhancedSearch = {
        query: searchParams.query,
        type: SearchType.PEOPLE,
        location: searchParams.location,
        limit: searchParams.limit || 10,
        page: searchParams.page || 1,
      };

      // Perform search
      const searchResults = await this.searchService.search(enhancedSearch, userId);

      // Format results for AI consumption
      const formattedResults = searchResults.results.people.map(person => ({
        id: person.id,
        username: person.username,
        displayName: person.displayName,
        bio: person.bio,
        avatar: person.avatar,
        location: person.location,
        isSeller: person.isSeller,
        isRider: person.isRider,
        rating: person.rating,
        connectionStatus: person.connectionStatus,
        mutualConnections: person.mutualConnections,
      }));

      // Record search for learning
      await this.recordSearchInteraction(userId, 'users', searchParams.query, formattedResults.length, userToken);

      return {
        query: searchParams.query,
        type: 'users',
        results: formattedResults,
        count: formattedResults.length,
        hasMore: searchResults.pagination.total > (searchParams.page || 1) * (searchParams.limit || 10),
        suggestions: this.generateUserSuggestions(searchParams.query),
      };
    } catch (error) {
      this.logger.error('Error in Iko user search:', error);
      throw error;
    }
  }

  /**
   * Get personalized recommendations
   */
  async getRecommendations(
    userId: string,
    params: IkoRecommendationsDto,
    userToken?: string
  ): Promise<IkoRecommendationResult> {
    this.logger.log(`Generating Iko recommendations for user: ${userId}, type: ${params.type}`);

    try {
      // Get user preferences and context
      const [preferences, context] = await Promise.all([
        this.ikoService.getIkoPreferences(userId, userToken),
        this.ikoService.getIkoContext(userId, userToken),
      ]);

      let recommendations: any[] = [];

      switch (params.type) {
        case 'products':
          recommendations = await this.getProductRecommendations(userId, preferences, context, params);
          break;
        case 'services':
          recommendations = await this.getServiceRecommendations(userId, preferences, context, params);
          break;
        case 'mixed':
          const [productRecs, serviceRecs] = await Promise.all([
            this.getProductRecommendations(userId, preferences, context, { ...params, limit: Math.ceil((params.limit || 10) / 2) }),
            this.getServiceRecommendations(userId, preferences, context, { ...params, limit: Math.ceil((params.limit || 10) / 2) }),
          ]);
          recommendations = [...productRecs, ...serviceRecs];
          break;
      }

      return {
        type: params.type,
        recommendations: recommendations.slice(0, params.limit || 10),
        reason: this.generateRecommendationReason(preferences, context, params.type),
        userContext: {
          preferredCategories: preferences.favorite_categories,
          recentSearches: this.getRecentSearches(context),
          budgetRanges: preferences.budget_ranges,
        },
      };
    } catch (error) {
      this.logger.error('Error generating Iko recommendations:', error);
      throw error;
    }
  }

  // Private helper methods
  private getBudgetForCategory(preferences: any, category?: string): number | undefined {
    if (!category || !preferences.budget_ranges) return undefined;
    return preferences.budget_ranges[category] || preferences.budget_ranges['general'];
  }

  private isRecommendedForUser(item: any, preferences: any): boolean {
    // Check if item matches user preferences
    if (preferences.favorite_categories.includes(item.category)) return true;
    if (item.rating >= 4.5) return true;
    return false;
  }

  private async recordSearchInteraction(
    userId: string,
    type: string,
    query: string,
    resultCount: number,
    userToken?: string
  ): Promise<void> {
    try {
      const context = await this.ikoService.getIkoContext(userId, userToken);
      const learnedPatterns = context.learned_patterns || {};

      // Update search patterns
      if (!learnedPatterns.searches) learnedPatterns.searches = [];
      learnedPatterns.searches.push({
        type,
        query,
        resultCount,
        timestamp: new Date().toISOString(),
      });

      // Keep only last 50 searches
      if (learnedPatterns.searches.length > 50) {
        learnedPatterns.searches = learnedPatterns.searches.slice(-50);
      }

      await this.ikoService.updateIkoContext(userId, { learned_patterns: learnedPatterns }, userToken);
    } catch (error) {
      this.logger.warn('Failed to record search interaction:', error);
    }
  }

  private generateProductSuggestions(query: string, preferences: any): string[] {
    const suggestions = [
      `${query} on sale`,
      `premium ${query}`,
      `${query} near me`,
    ];

    // Add category-based suggestions
    if (preferences.favorite_categories.length > 0) {
      suggestions.push(`${query} in ${preferences.favorite_categories[0]}`);
    }

    return suggestions.slice(0, 3);
  }

  private generateServiceSuggestions(query: string, preferences: any): string[] {
    const suggestions = [
      `${query} booking`,
      `professional ${query}`,
      `${query} near me`,
    ];

    return suggestions.slice(0, 3);
  }

  private generateUserSuggestions(query: string): string[] {
    return [
      `${query} seller`,
      `${query} provider`,
      `verified ${query}`,
    ].slice(0, 3);
  }

  private async getProductRecommendations(userId: string, preferences: any, context: any, params: any): Promise<any[]> {
    // Implementation for product recommendations based on user preferences
    // This would typically involve ML algorithms, but for now we'll use basic logic
    return [];
  }

  private async getServiceRecommendations(userId: string, preferences: any, context: any, params: any): Promise<any[]> {
    // Implementation for service recommendations based on user preferences
    return [];
  }

  private generateRecommendationReason(preferences: any, context: any, type: string): string {
    const reasons = [
      `Based on your interest in ${preferences.favorite_categories.join(', ')}`,
      `Popular in your area`,
      `Highly rated by users like you`,
      `Within your budget range`,
    ];

    return reasons[Math.floor(Math.random() * reasons.length)];
  }

  private getRecentSearches(context: any): string[] {
    if (!context.learned_patterns?.searches) return [];
    return context.learned_patterns.searches
      .slice(-5)
      .map((search: any) => search.query)
      .filter((query: string) => query);
  }
}