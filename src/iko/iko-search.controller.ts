import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Logger,
  HttpCode,
  HttpStatus,
  Get,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IkoSearchService } from './iko-search.service';
import {
  IkoSearchProductsDto,
  IkoSearchServicesDto,
  IkoSearchUsersDto,
  IkoRecommendationsDto,
  IkoSearchResult,
  IkoRecommendationResult,
  IkoSearchFunctionSchemas,
} from './dto/iko-search.dto';

@Controller('iko/search')
@UseGuards(JwtAuthGuard)
export class IkoSearchController {
  private readonly logger = new Logger(IkoSearchController.name);

  constructor(private readonly ikoSearchService: IkoSearchService) {}

  /**
   * Search products - optimized for AI function calling
   */
  @Post('products')
  @HttpCode(HttpStatus.OK)
  async searchProducts(
    @Req() request: any,
    @Body() searchParams: IkoSearchProductsDto
  ): Promise<IkoSearchResult> {
    this.logger.log(`Iko product search for user: ${request.user.sub}, query: "${searchParams.query}"`);

    return await this.ikoSearchService.searchProducts(
      request.user.sub,
      searchParams,
      request.headers.authorization?.replace('Bearer ', '')
    );
  }

  /**
   * Search services - optimized for AI function calling
   */
  @Post('services')
  @HttpCode(HttpStatus.OK)
  async searchServices(
    @Req() request: any,
    @Body() searchParams: IkoSearchServicesDto
  ): Promise<IkoSearchResult> {
    this.logger.log(`Iko service search for user: ${request.user.sub}, query: "${searchParams.query}"`);

    return await this.ikoSearchService.searchServices(
      request.user.sub,
      searchParams,
      request.headers.authorization?.replace('Bearer ', '')
    );
  }

  /**
   * Search users - optimized for AI function calling
   */
  @Post('users')
  @HttpCode(HttpStatus.OK)
  async searchUsers(
    @Req() request: any,
    @Body() searchParams: IkoSearchUsersDto
  ): Promise<IkoSearchResult> {
    this.logger.log(`Iko user search for user: ${request.user.sub}, query: "${searchParams.query}"`);

    return await this.ikoSearchService.searchUsers(
      request.user.sub,
      searchParams,
      request.headers.authorization?.replace('Bearer ', '')
    );
  }

  /**
   * Get personalized recommendations
   */
  @Post('recommendations')
  @HttpCode(HttpStatus.OK)
  async getRecommendations(
    @Req() request: any,
    @Body() params: IkoRecommendationsDto
  ): Promise<IkoRecommendationResult> {
    this.logger.log(`Iko recommendations for user: ${request.user.sub}, type: ${params.type}`);

    return await this.ikoSearchService.getRecommendations(
      request.user.sub,
      params,
      request.headers.authorization?.replace('Bearer ', '')
    );
  }

  /**
   * Get function calling schemas for Gemini AI integration
   */
  @Get('schemas')
  @HttpCode(HttpStatus.OK)
  async getFunctionSchemas(): Promise<{ schemas: typeof IkoSearchFunctionSchemas }> {
    this.logger.log('Providing Iko search function schemas');

    return {
      schemas: IkoSearchFunctionSchemas,
    };
  }

  /**
   * Get search suggestions based on user context
   */
  @Get('suggestions')
  @HttpCode(HttpStatus.OK)
  async getSearchSuggestions(
    @Req() request: any,
    @Query('type') type?: 'products' | 'services' | 'users'
  ): Promise<{
    suggestions: string[];
    trending: string[];
    personalized: string[];
  }> {
    this.logger.log(`Getting search suggestions for user: ${request.user.sub}, type: ${type || 'all'}`);

    // This would typically fetch from trending/popular searches and user history
    const suggestions = {
      suggestions: [
        type === 'products' ? ['iPhone 15', 'Gaming laptop', 'Wireless earbuds'] :
        type === 'services' ? ['Hair styling', 'Web development', 'House cleaning'] :
        type === 'users' ? ['Tech sellers', 'Beauty experts', 'Local riders'] :
        ['iPhone 15', 'Hair styling', 'Tech sellers']
      ].flat(),
      trending: [
        'iPhone 15 Pro',
        'Professional makeup',
        'Same day delivery',
        'Web design',
        'Laptop repair',
      ],
      personalized: [
        'Budget phones under 100k',
        'Weekend beauty services',
        'Verified electronics sellers',
        'Local tech support',
      ],
    };

    return suggestions;
  }

  /**
   * Quick search endpoint for rapid queries
   */
  @Post('quick')
  @HttpCode(HttpStatus.OK)
  async quickSearch(
    @Req() request: any,
    @Body() params: { query: string; type?: 'products' | 'services' | 'users' | 'all' }
  ): Promise<{
    products: any[];
    services: any[];
    users: any[];
    suggestions: string[];
  }> {
    this.logger.log(`Iko quick search for user: ${request.user.sub}, query: "${params.query}"`);

    const results = {
      products: [] as any[],
      services: [] as any[],
      users: [] as any[],
      suggestions: [] as string[],
    };

    try {
      // Perform quick searches in parallel with limited results
      const searches: Promise<{ type: string; data: any[] }>[] = [];

      if (!params.type || params.type === 'all' || params.type === 'products') {
        searches.push(
          this.ikoSearchService.searchProducts(
            request.user.sub,
            { query: params.query, limit: 3 },
            request.headers.authorization?.replace('Bearer ', '')
          ).then(result => ({ type: 'products', data: result.results }))
        );
      }

      if (!params.type || params.type === 'all' || params.type === 'services') {
        searches.push(
          this.ikoSearchService.searchServices(
            request.user.sub,
            { query: params.query, limit: 3 },
            request.headers.authorization?.replace('Bearer ', '')
          ).then(result => ({ type: 'services', data: result.results }))
        );
      }

      if (!params.type || params.type === 'all' || params.type === 'users') {
        searches.push(
          this.ikoSearchService.searchUsers(
            request.user.sub,
            { query: params.query, limit: 3 },
            request.headers.authorization?.replace('Bearer ', '')
          ).then(result => ({ type: 'users', data: result.results }))
        );
      }

      const searchResults = await Promise.allSettled(searches);

      // Process results
      searchResults.forEach(result => {
        if (result.status === 'fulfilled') {
          const { type, data } = result.value;
          results[type as keyof typeof results] = data;
        }
      });

      // Generate suggestions
      results.suggestions = [
        `${params.query} on sale`,
        `professional ${params.query}`,
        `${params.query} near me`,
      ];

      return results;
    } catch (error) {
      this.logger.error('Error in quick search:', error);
      return results; // Return empty results on error
    }
  }
}