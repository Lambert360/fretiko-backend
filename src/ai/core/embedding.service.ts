import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('EMBEDDING_BASE_URL')
      || 'https://router.huggingface.co/hf-inference/models';
    this.model = this.configService.get<string>('EMBEDDING_MODEL')
      || 'BAAI/bge-small-en-v1.5';
    this.apiKey = this.configService.get<string>('EMBEDDING_API_KEY')
      || this.configService.get<string>('HUGGINGFACE_API_KEY');
    this.timeoutMs = this.configService.get<number>('EMBEDDING_TIMEOUT_MS') || 15000;
  }

  /**
   * Generate an embedding vector for a single text input.
   * Uses Hugging Face Inference API by default (free tier).
   */
  async embed(text: string): Promise<EmbeddingResult> {
    const cleaned = text.trim();
    if (!cleaned) {
      return { embedding: [], model: this.model, dimensions: 0 };
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await axios.post(
        `${this.baseUrl}/${this.model}`,
        { inputs: cleaned, options: { wait_for_model: true } },
        { headers, timeout: this.timeoutMs }
      );

      const raw = response.data;

      // Hugging Face returns nested arrays: [[0.1, 0.2, ...]]
      // Some models return a flat array: [0.1, 0.2, ...]
      let embedding: number[];
      if (Array.isArray(raw) && Array.isArray(raw[0])) {
        // Nested — take the first (and only) sequence
        embedding = raw[0];
      } else if (Array.isArray(raw)) {
        embedding = raw;
      } else {
        throw new Error('Unexpected embedding response format');
      }

      return {
        embedding,
        model: this.model,
        dimensions: embedding.length,
      };
    } catch (error: any) {
      this.logger.error(`Embedding failed for model ${this.model}:`, error.message);
      if (error.response) {
        this.logger.error('Embedding error response:', JSON.stringify(error.response.data));
      }
      throw new Error(`Embedding request failed: ${error.message}`);
    }
  }

  /**
   * Generate embeddings for multiple texts in a batch.
   * Processes in small batches to respect rate limits.
   */
  async embedBatch(texts: string[], batchSize: number = 4): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      // Process batch sequentially to avoid rate limiting
      for (const text of batch) {
        try {
          const result = await this.embed(text);
          results.push(result);
        } catch (error) {
          this.logger.warn(`Failed to embed text at index ${i}, using empty vector: ${error.message}`);
          results.push({ embedding: [], model: this.model, dimensions: 0 });
        }
      }

      // Small delay between batches to respect free tier rate limits
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  }

  /**
   * Build a searchable text representation of a product for embedding.
   */
  buildProductText(product: any): string {
    const parts = [
      product.name || '',
      product.description || '',
      product.condition || '',
      Array.isArray(product.tags) ? product.tags.join(', ') : '',
      `Price: ${product.price || 0} FRT`,
    ];
    return parts.filter(p => p).join(' | ');
  }

  /**
   * Build a searchable text representation of a vendor for embedding.
   */
  buildVendorText(vendor: any): string {
    const parts = [
      vendor.username || '',
      vendor.bio || '',
      vendor.location || '',
      `Verified: ${vendor.is_verified || false}`,
    ];
    return parts.filter(p => p).join(' | ');
  }
}
