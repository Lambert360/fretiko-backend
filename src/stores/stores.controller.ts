import {
  Controller,
  Get,
  Query,
  Param,
  Logger,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StoresService, VerifiedStore } from './stores.service';

@Controller('stores')
@UseGuards(JwtAuthGuard)
export class StoresController {
  private readonly logger = new Logger(StoresController.name);

  constructor(private readonly storesService: StoresService) {}

  /**
   * Get all verified stores with pagination
   * GET /stores/verified?limit=20&offset=0
   */
  @Get('verified')
  async getVerifiedStores(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<{
    stores: VerifiedStore[];
    pagination: {
      limit: number;
      offset: number;
      total: number;
    };
  }> {
    try {
      this.logger.log(`GET /stores/verified - limit: ${limit}, offset: ${offset}`);

      // Validate pagination parameters
      const validLimit = Math.min(Math.max(limit, 1), 100); // Between 1 and 100
      const validOffset = Math.max(offset, 0); // Non-negative

      const [stores, total] = await Promise.all([
        this.storesService.getVerifiedStores(validLimit, validOffset),
        this.storesService.getVerifiedStoresCount(),
      ]);

      this.logger.log(`Returning ${stores.length} verified stores`);

      return {
        stores,
        pagination: {
          limit: validLimit,
          offset: validOffset,
          total,
        },
      };
    } catch (error) {
      this.logger.error('Error in getVerifiedStores:', error);
      throw error;
    }
  }

  /**
   * Get a specific store by ID
   * GET /stores/:id
   */
  @Get(':id')
  async getStoreById(@Param('id') storeId: string): Promise<VerifiedStore | null> {
    try {
      this.logger.log(`GET /stores/${storeId}`);

      const store = await this.storesService.getStoreById(storeId);

      if (!store) {
        this.logger.warn(`Store not found: ${storeId}`);
      }

      return store;
    } catch (error) {
      this.logger.error('Error in getStoreById:', error);
      throw error;
    }
  }

  /**
   * Search verified stores by name or bio
   * GET /stores/search?q=query&limit=20&offset=0
   */
  @Get('search')
  async searchVerifiedStores(
    @Query('q') query: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<{
    stores: VerifiedStore[];
    query: string;
    pagination: {
      limit: number;
      offset: number;
    };
  }> {
    try {
      this.logger.log(`GET /stores/search - query: "${query}", limit: ${limit}, offset: ${offset}`);

      if (!query || query.trim().length < 2) {
        this.logger.warn('Search query too short or empty');
        return {
          stores: [],
          query: query || '',
          pagination: { limit, offset },
        };
      }

      // Validate pagination parameters
      const validLimit = Math.min(Math.max(limit, 1), 50); // Between 1 and 50 for search
      const validOffset = Math.max(offset, 0); // Non-negative

      const stores = await this.storesService.searchVerifiedStores(
        query.trim(),
        validLimit,
        validOffset,
      );

      this.logger.log(`Search returned ${stores.length} stores`);

      return {
        stores,
        query: query.trim(),
        pagination: {
          limit: validLimit,
          offset: validOffset,
        },
      };
    } catch (error) {
      this.logger.error('Error in searchVerifiedStores:', error);
      throw error;
    }
  }

  /**
   * Get stores by category
   * GET /stores/category/:categoryName?limit=20&offset=0
   */
  @Get('category/:categoryName')
  async getStoresByCategory(
    @Param('categoryName') categoryName: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<{
    stores: VerifiedStore[];
    category: string;
    pagination: {
      limit: number;
      offset: number;
    };
  }> {
    try {
      this.logger.log(`GET /stores/category/${categoryName} - limit: ${limit}, offset: ${offset}`);

      // Validate pagination parameters
      const validLimit = Math.min(Math.max(limit, 1), 50); // Between 1 and 50
      const validOffset = Math.max(offset, 0); // Non-negative

      const stores = await this.storesService.getStoresByCategory(
        categoryName,
        validLimit,
        validOffset,
      );

      this.logger.log(`Category search returned ${stores.length} stores`);

      return {
        stores,
        category: categoryName,
        pagination: {
          limit: validLimit,
          offset: validOffset,
        },
      };
    } catch (error) {
      this.logger.error('Error in getStoresByCategory:', error);
      throw error;
    }
  }

  /**
   * Get store statistics
   * GET /stores/:id/stats
   */
  @Get(':id/stats')
  async getStoreStats(@Param('id') storeId: string) {
    try {
      this.logger.log(`GET /stores/${storeId}/stats`);

      const stats = await this.storesService.getStoreStats(storeId);

      return {
        store_id: storeId,
        ...stats,
      };
    } catch (error) {
      this.logger.error('Error in getStoreStats:', error);
      throw error;
    }
  }

  /**
   * Get verified stores count
   * GET /stores/verified/count
   */
  @Get('verified/count')
  async getVerifiedStoresCount(): Promise<{ count: number }> {
    try {
      this.logger.log('GET /stores/verified/count');

      const count = await this.storesService.getVerifiedStoresCount();

      return { count };
    } catch (error) {
      this.logger.error('Error in getVerifiedStoresCount:', error);
      throw error;
    }
  }
}