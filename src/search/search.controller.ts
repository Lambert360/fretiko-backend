import {
  Controller,
  Get,
  Query,
  UseGuards,
  Request,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SearchService } from './search.service';
import { 
  SearchQueryDto, 
  TrendingSearchDto, 
  FeaturedContentDto, 
  SearchSuggestionsDto, 
  SearchType 
} from './dto/search.dto';

@Controller('search')
export class SearchController {
  private readonly logger = new Logger(SearchController.name);
  
  constructor(private readonly searchService: SearchService) {}

  @Get()
  async search(
    @Query() query: SearchQueryDto,
    @Request() req?: any
  ) {
    this.logger.log(`Search endpoint called with query: ${query.query || 'empty'}, type: ${query.type || 'all'}`);
    
    if (!query.query && query.type === SearchType.ALL) {
      throw new BadRequestException('Search query is required for general search');
    }
    
    const userId = req?.user?.sub;
    return this.searchService.search(query, userId);
  }

  @Get('trending')
  async getTrending(@Query() query: TrendingSearchDto) {
    this.logger.log(`Trending searches endpoint called with location: ${query.location || 'all'}, limit: ${query.limit}`);
    return this.searchService.getTrendingSearches(query);
  }

  @Get('featured')
  async getFeatured(
    @Query() query: FeaturedContentDto,
    @Request() req?: any
  ) {
    this.logger.log(`Featured content endpoint called with type: ${query.type || 'all'}, limit: ${query.limit}`);
    const userId = req?.user?.sub;
    return this.searchService.getFeaturedContent(query, userId);
  }

  @Get('suggestions')
  async getSuggestions(@Query() query: SearchSuggestionsDto) {
    this.logger.log(`Search suggestions endpoint called with query: ${query.query}`);
    
    if (!query.query || query.query.length < 2) {
      throw new BadRequestException('Query must be at least 2 characters long');
    }
    
    return this.searchService.getSearchSuggestions(query);
  }

  @Get('recommendations')
  @UseGuards(JwtAuthGuard)
  async getRecommendations(
    @Request() req,
    @Query('type') type?: SearchType,
    @Query('limit') limit?: number
  ) {
    this.logger.log(`Personalized recommendations endpoint called for user: ${req.user.sub}`);
    return this.searchService.getPersonalizedRecommendations(
      req.user.sub, 
      type, 
      limit || 10
    );
  }

  // Quick access endpoints for specific content types
  @Get('products')
  async searchProducts(@Query() query: SearchQueryDto, @Request() req?: any) {
    this.logger.log('Products search endpoint called');
    const userId = req?.user?.sub;
    return this.searchService.search({ ...query, type: SearchType.PRODUCTS }, userId);
  }

  @Get('services')
  async searchServices(@Query() query: SearchQueryDto, @Request() req?: any) {
    this.logger.log('Services search endpoint called');
    const userId = req?.user?.sub;
    return this.searchService.search({ ...query, type: SearchType.SERVICES }, userId);
  }

  @Get('people')
  async searchPeople(@Query() query: SearchQueryDto, @Request() req?: any) {
    this.logger.log('People search endpoint called');
    const userId = req?.user?.sub;
    return this.searchService.search({ ...query, type: SearchType.PEOPLE }, userId);
  }

  @Get('providers')
  async searchProviders(@Query() query: SearchQueryDto, @Request() req?: any) {
    this.logger.log('Providers search endpoint called');
    const userId = req?.user?.sub;
    return this.searchService.search({ ...query, type: SearchType.PROVIDERS }, userId);
  }

  // Discovery endpoints for the main SearchScreen feed
  @Get('discover')
  async discover(@Request() req?: any) {
    this.logger.log('Discover endpoint called - getting comprehensive feed');
    const userId = req?.user?.sub;
    
    try {
      // Get all the content needed for the SearchScreen before user searches
      const [trending, featured, recommendations] = await Promise.allSettled([
        this.searchService.getTrendingSearches({ limit: 8 }),
        this.searchService.getFeaturedContent({ limit: 6 }, userId),
        userId ? this.searchService.getPersonalizedRecommendations(userId, SearchType.ALL, 8) : null,
      ]);

      return {
        trending: trending.status === 'fulfilled' ? trending.value : [],
        featured: featured.status === 'fulfilled' ? featured.value : {
          products: [],
          services: [],
          people: [],
          providers: [],
        },
        recommendations: recommendations.status === 'fulfilled' && recommendations.value ? recommendations.value : {
          products: [],
          services: [],
          people: [],
          providers: [],
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Discover endpoint failed:', error);
      throw error;
    }
  }

  // Popular searches endpoint
  @Get('popular')
  async getPopularSearches(@Query('limit') limit?: number) {
    this.logger.log('Popular searches endpoint called');
    return this.searchService.getTrendingSearches({ 
      limit: limit || 10 
    });
  }

  // Categories endpoint for filters
  @Get('categories')
  async getSearchCategories() {
    this.logger.log('Search categories endpoint called');
    
    // Mock categories - in production, get from database
    return {
      products: [
        'Electronics', 'Fashion', 'Home & Garden', 'Sports', 'Books', 'Automotive',
        'Health & Beauty', 'Toys & Games', 'Food & Beverages', 'Office Supplies'
      ],
      services: [
        'Home Services', 'Professional Services', 'Beauty & Wellness', 'Automotive Services',
        'Educational Services', 'Event Services', 'Health Services', 'Technology Services',
        'Fitness & Sports', 'Pet Services'
      ],
      people: [
        'Professionals', 'Creatives', 'Entrepreneurs', 'Students', 'Experts',
        'Influencers', 'Consultants', 'Freelancers', 'Artists', 'Coaches'
      ],
      providers: [
        'Food Delivery', 'Package Delivery', 'Transportation', 'Logistics',
        'Courier Services', 'Moving Services', 'Grocery Delivery', 'Pharmacy Delivery',
        'Pet Transport', 'Furniture Delivery'
      ],
    };
  }

  // Quick filters endpoint
  @Get('filters')
  async getSearchFilters(@Query('type') type: SearchType) {
    this.logger.log(`Search filters endpoint called for type: ${type}`);
    
    const baseFilters = {
      location: true,
      rating: true,
      sortBy: ['relevance', 'newest', 'popular', 'rating'],
    };

    switch (type) {
      case SearchType.PRODUCTS:
        return {
          ...baseFilters,
          price: true,
          category: true,
          tags: true,
          inStock: true,
          fastShipping: true,
          sortBy: [...baseFilters.sortBy, 'price_asc', 'price_desc'],
        };
      
      case SearchType.SERVICES:
        return {
          ...baseFilters,
          price: true,
          category: true,
          tags: true,
          availability: true,
          serviceType: true,
          sortBy: [...baseFilters.sortBy, 'price_asc', 'price_desc'],
        };
      
      case SearchType.PEOPLE:
        return {
          ...baseFilters,
          profession: true,
          skills: true,
          verified: true,
          online: true,
          connections: true,
        };
      
      case SearchType.PROVIDERS:
        return {
          ...baseFilters,
          vehicleType: true,
          availability: true,
          deliveryTime: true,
          verified: true,
          experience: true,
        };
      
      default:
        return baseFilters;
    }
  }
}