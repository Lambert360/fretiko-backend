import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient } from '../shared/supabase.client';

export interface VerifiedStore {
  id: string;
  username: string;
  bio?: string;
  avatar_url?: string;
  is_verified: boolean;
  is_seller: boolean;
  store_rating?: number;
  product_count?: number;
  service_count?: number;
  created_at: string;
}

export interface StoreStats {
  total_products: number;
  total_services: number;
  average_rating: number;
  total_sales: number;
}

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  /**
   * Get all verified stores (sellers with is_verified = true)
   */
  async getVerifiedStores(limit = 50, offset = 0): Promise<VerifiedStore[]> {
    try {
      this.logger.log(`Fetching verified stores - limit: ${limit}, offset: ${offset}`);

      const { data, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id,
          username,
          bio,
          avatar_url,
          is_verified,
          is_seller,
          created_at
        `)
        .eq('is_verified', true)
        .eq('is_seller', true)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        this.logger.error('Error fetching verified stores:', error);
        throw new Error(`Failed to fetch verified stores: ${error.message}`);
      }

      // Enhance with store statistics
      const storesWithStats = await Promise.all(
        data.map(async (store) => {
          const stats = await this.getStoreStats(store.id);
          return {
            ...store,
            store_rating: stats.average_rating,
            product_count: stats.total_products,
            service_count: stats.total_services,
          };
        })
      );

      this.logger.log(`Found ${storesWithStats.length} verified stores`);
      return storesWithStats;
    } catch (error) {
      this.logger.error('Error in getVerifiedStores:', error);
      throw error;
    }
  }

  /**
   * Get statistics for a specific store
   */
  async getStoreStats(userId: string): Promise<StoreStats> {
    try {
      // Get product count and ratings
      const { data: productStats, error: productError } = await this.supabase
        .from('products')
        .select(`
          id,
          product_ratings (rating)
        `)
        .eq('user_id', userId)
        .eq('status', 'active');

      if (productError) {
        this.logger.warn(`Error fetching product stats for user ${userId}:`, productError);
      }

      // Get service count and ratings
      const { data: serviceStats, error: serviceError } = await this.supabase
        .from('services')
        .select(`
          id,
          service_ratings (rating)
        `)
        .eq('user_id', userId)
        .eq('status', 'active');

      if (serviceError) {
        this.logger.warn(`Error fetching service stats for user ${userId}:`, serviceError);
      }

      // Calculate statistics
      const totalProducts = productStats?.length || 0;
      const totalServices = serviceStats?.length || 0;

      // Calculate average rating from both products and services
      let totalRatings = 0;
      let ratingCount = 0;

      // Product ratings
      if (productStats) {
        productStats.forEach(product => {
          if (product.product_ratings) {
            product.product_ratings.forEach((rating: any) => {
              totalRatings += rating.rating;
              ratingCount++;
            });
          }
        });
      }

      // Service ratings
      if (serviceStats) {
        serviceStats.forEach(service => {
          if (service.service_ratings) {
            service.service_ratings.forEach((rating: any) => {
              totalRatings += rating.rating;
              ratingCount++;
            });
          }
        });
      }

      const averageRating = ratingCount > 0 ? totalRatings / ratingCount : 0;

      // TODO: Calculate total sales from orders/transactions
      const totalSales = 0;

      return {
        total_products: totalProducts,
        total_services: totalServices,
        average_rating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
        total_sales: totalSales,
      };
    } catch (error) {
      this.logger.error(`Error getting stats for store ${userId}:`, error);
      return {
        total_products: 0,
        total_services: 0,
        average_rating: 0,
        total_sales: 0,
      };
    }
  }

  /**
   * Get a specific store by ID with full details
   */
  async getStoreById(storeId: string): Promise<VerifiedStore | null> {
    try {
      this.logger.log(`Fetching store details for ID: ${storeId}`);

      const { data, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id,
          username,
          bio,
          avatar_url,
          is_verified,
          is_seller,
          created_at
        `)
        .eq('id', storeId)
        .eq('is_seller', true)
        .single();

      if (error) {
        this.logger.error('Error fetching store by ID:', error);
        return null;
      }

      if (!data) {
        this.logger.warn(`Store not found: ${storeId}`);
        return null;
      }

      // Add store statistics
      const stats = await this.getStoreStats(data.id);

      return {
        ...data,
        store_rating: stats.average_rating,
        product_count: stats.total_products,
        service_count: stats.total_services,
      };
    } catch (error) {
      this.logger.error('Error in getStoreById:', error);
      return null;
    }
  }

  /**
   * Search verified stores by name or bio
   */
  async searchVerifiedStores(
    query: string,
    limit = 20,
    offset = 0
  ): Promise<VerifiedStore[]> {
    try {
      this.logger.log(`Searching verified stores with query: "${query}"`);

      const { data, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id,
          username,
          bio,
          avatar_url,
          is_verified,
          is_seller,
          created_at
        `)
        .eq('is_verified', true)
        .eq('is_seller', true)
        .or(`username.ilike.%${query}%,bio.ilike.%${query}%`)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        this.logger.error('Error searching verified stores:', error);
        throw new Error(`Failed to search verified stores: ${error.message}`);
      }

      // Enhance with store statistics
      const storesWithStats = await Promise.all(
        data.map(async (store) => {
          const stats = await this.getStoreStats(store.id);
          return {
            ...store,
            store_rating: stats.average_rating,
            product_count: stats.total_products,
            service_count: stats.total_services,
          };
        })
      );

      this.logger.log(`Found ${storesWithStats.length} stores matching query`);
      return storesWithStats;
    } catch (error) {
      this.logger.error('Error in searchVerifiedStores:', error);
      throw error;
    }
  }

  /**
   * Get stores by category (based on their products/services)
   */
  async getStoresByCategory(
    categoryName: string,
    limit = 20,
    offset = 0
  ): Promise<VerifiedStore[]> {
    try {
      this.logger.log(`Fetching stores by category: ${categoryName}`);

      // Get stores that have products in this category
      const { data: productStores, error: productError } = await this.supabase
        .from('products')
        .select(`
          user_id,
          user_profiles!inner (
            id,
            username,
            bio,
            avatar_url,
            is_verified,
            is_seller,
            created_at
          ),
          product_categories!inner (
            name
          )
        `)
        .eq('user_profiles.is_verified', true)
        .eq('user_profiles.is_seller', true)
        .eq('product_categories.name', categoryName)
        .eq('status', 'active');

      // Get stores that have services in this category
      const { data: serviceStores, error: serviceError } = await this.supabase
        .from('services')
        .select(`
          user_id,
          user_profiles!inner (
            id,
            username,
            bio,
            avatar_url,
            is_verified,
            is_seller,
            created_at
          ),
          service_categories!inner (
            name
          )
        `)
        .eq('user_profiles.is_verified', true)
        .eq('user_profiles.is_seller', true)
        .eq('service_categories.name', categoryName)
        .eq('status', 'active');

      if (productError && serviceError) {
        this.logger.error('Error fetching stores by category:', { productError, serviceError });
        throw new Error('Failed to fetch stores by category');
      }

      // Combine and deduplicate stores
      const allStores = new Map<string, any>();

      if (productStores) {
        productStores.forEach(item => {
          allStores.set(item.user_profiles.id, item.user_profiles);
        });
      }

      if (serviceStores) {
        serviceStores.forEach(item => {
          allStores.set(item.user_profiles.id, item.user_profiles);
        });
      }

      const uniqueStores = Array.from(allStores.values())
        .slice(offset, offset + limit);

      // Enhance with store statistics
      const storesWithStats = await Promise.all(
        uniqueStores.map(async (store) => {
          const stats = await this.getStoreStats(store.id);
          return {
            ...store,
            store_rating: stats.average_rating,
            product_count: stats.total_products,
            service_count: stats.total_services,
          };
        })
      );

      this.logger.log(`Found ${storesWithStats.length} stores in category ${categoryName}`);
      return storesWithStats;
    } catch (error) {
      this.logger.error('Error in getStoresByCategory:', error);
      throw error;
    }
  }

  /**
   * Get total count of verified stores
   */
  async getVerifiedStoresCount(): Promise<number> {
    try {
      const { count, error } = await this.supabase
        .from('user_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('is_verified', true)
        .eq('is_seller', true);

      if (error) {
        this.logger.error('Error counting verified stores:', error);
        return 0;
      }

      return count || 0;
    } catch (error) {
      this.logger.error('Error in getVerifiedStoresCount:', error);
      return 0;
    }
  }
}