import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../../shared/supabase.client';
import { EmbeddingService } from './embedding.service';

export interface VectorSearchResult {
  id: string;
  similarity: number;
  data: any;
}

@Injectable()
export class VectorSearchService {
  private readonly logger = new Logger(VectorSearchService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private embeddingService: EmbeddingService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Search products by semantic similarity.
   * Falls back to null if embedding fails (caller should handle keyword fallback).
   */
  async searchProducts(
    query: string,
    options?: {
      limit?: number;
      category?: string;
      minPrice?: number;
      maxPrice?: number;
      threshold?: number;
    }
  ): Promise<VectorSearchResult[] | null> {
    const limit = options?.limit || 10;
    const threshold = options?.threshold || 0.5;

    try {
      const { embedding } = await this.embeddingService.embed(query);
      if (!embedding || embedding.length === 0) {
        this.logger.warn('Empty embedding returned, cannot do vector search');
        return null;
      }

      // Build the query using RPC for pgvector similarity search
      const { data, error } = await this.supabase.rpc('match_products', {
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: limit,
        filter_category: options?.category || null,
        filter_min_price: options?.minPrice || null,
        filter_max_price: options?.maxPrice || null,
      });

      if (error) {
        this.logger.warn('Vector product search RPC failed, trying inline query:', error.message);
        return await this.inlineProductSearch(embedding, limit, options);
      }

      return (data || []).map((row: any) => ({
        id: row.id,
        similarity: row.similarity,
        data: row,
      }));
    } catch (error: any) {
      this.logger.error('Vector product search failed:', error.message);
      return null;
    }
  }

  /**
   * Search vendors by semantic similarity.
   */
  async searchVendors(
    query: string,
    options?: {
      limit?: number;
      isVerified?: boolean;
      threshold?: number;
    }
  ): Promise<VectorSearchResult[] | null> {
    const limit = options?.limit || 10;
    const threshold = options?.threshold || 0.4;

    try {
      const { embedding } = await this.embeddingService.embed(query);
      if (!embedding || embedding.length === 0) {
        this.logger.warn('Empty embedding returned, cannot do vector search');
        return null;
      }

      const { data, error } = await this.supabase.rpc('match_vendors', {
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: limit,
        filter_verified: options?.isVerified === false ? null : true,
      });

      if (error) {
        this.logger.warn('Vector vendor search RPC failed, trying inline query:', error.message);
        return await this.inlineVendorSearch(embedding, limit, options);
      }

      return (data || []).map((row: any) => ({
        id: row.id,
        similarity: row.similarity,
        data: row,
      }));
    } catch (error: any) {
      this.logger.error('Vector vendor search failed:', error.message);
      return null;
    }
  }

  /**
   * Inline fallback: query pgvector directly without RPC function.
   * Uses cosine distance operator (<=>).
   */
  private async inlineProductSearch(
    embedding: number[],
    limit: number,
    options?: { category?: string; minPrice?: number; maxPrice?: number }
  ): Promise<VectorSearchResult[] | null> {
    try {
      let query = this.supabase
        .from('products')
        .select(`
          *,
          user_profiles!products_user_id_fkey (
            username,
            avatar_url,
            is_verified
          )
        `)
        .eq('status', 'active')
        .is('deleted_at', null)
        .not('embedding', 'is', null)
        .order('embedding', { ascending: true, foreignTable: undefined })
        .limit(limit);

      // Note: Supabase JS client doesn't natively support vector similarity operators.
      // This inline method won't do true similarity search without the RPC function.
      // We return null so the caller falls back to keyword search.
      this.logger.warn('Inline vector search not supported without RPC function. Returning null for keyword fallback.');
      return null;
    } catch (error: any) {
      this.logger.error('Inline product search failed:', error.message);
      return null;
    }
  }

  private async inlineVendorSearch(
    embedding: number[],
    limit: number,
    options?: { isVerified?: boolean }
  ): Promise<VectorSearchResult[] | null> {
    this.logger.warn('Inline vector search not supported without RPC function. Returning null for keyword fallback.');
    return null;
  }

  /**
   * Store or update a product's embedding in the database.
   */
  async upsertProductEmbedding(productId: string, text: string): Promise<void> {
    try {
      const { embedding } = await this.embeddingService.embed(text);
      if (!embedding || embedding.length === 0) return;

      const { error } = await this.supabase
        .from('products')
        .update({
          embedding,
          embedding_text: text,
          embedding_updated_at: new Date().toISOString(),
        })
        .eq('id', productId);

      if (error) {
        this.logger.error(`Failed to update embedding for product ${productId}:`, error.message);
      }
    } catch (error: any) {
      this.logger.error(`Failed to embed product ${productId}:`, error.message);
    }
  }

  /**
   * Store or update a vendor's embedding in the database.
   */
  async upsertVendorEmbedding(vendorId: string, text: string): Promise<void> {
    try {
      const { embedding } = await this.embeddingService.embed(text);
      if (!embedding || embedding.length === 0) return;

      const { error } = await this.supabase
        .from('user_profiles')
        .update({
          embedding,
          embedding_text: text,
          embedding_updated_at: new Date().toISOString(),
        })
        .eq('id', vendorId);

      if (error) {
        this.logger.error(`Failed to update embedding for vendor ${vendorId}:`, error.message);
      }
    } catch (error: any) {
      this.logger.error(`Failed to embed vendor ${vendorId}:`, error.message);
    }
  }

  /**
   * Get products that don't have embeddings yet.
   */
  async getProductsNeedingEmbeddings(batchSize: number = 50): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('products')
      .select('id, name, description, condition, tags, price, category_id, status')
      .eq('status', 'active')
      .is('deleted_at', null)
      .is('embedding', null)
      .limit(batchSize);

    if (error) {
      this.logger.error('Failed to fetch products needing embeddings:', error.message);
      return [];
    }

    return data || [];
  }

  /**
   * Get vendors that don't have embeddings yet.
   */
  async getVendorsNeedingEmbeddings(batchSize: number = 50): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('user_profiles')
      .select('id, username, bio, store_name, is_verified, is_seller')
      .eq('is_seller', true)
      .is('embedding', null)
      .limit(batchSize);

    if (error) {
      this.logger.error('Failed to fetch vendors needing embeddings:', error.message);
      return [];
    }

    return data || [];
  }
}
