import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { CreatePriceAlertDto } from './dto/ai.dto';

export interface PriceAlert {
  id: string;
  userId: string;
  productQuery: string;
  targetPrice?: number;
  productId?: string;
  status: 'active' | 'triggered' | 'disabled' | 'deleted';
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PriceAlertService {
  private readonly logger = new Logger(PriceAlertService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async createAlert(userId: string, dto: CreatePriceAlertDto): Promise<PriceAlert> {
    const { data, error } = await this.supabase
      .from('price_alerts')
      .insert({
        user_id: userId,
        product_query: dto.productQuery,
        target_price: dto.targetPrice,
        product_id: dto.productId,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      this.logger.error('Failed to create price alert:', error);
      throw new Error(`Failed to create price alert: ${error.message}`);
    }

    return this.mapPriceAlert(data);
  }

  async getAlerts(userId: string): Promise<PriceAlert[]> {
    const { data, error } = await this.supabase
      .from('price_alerts')
      .select('*')
      .eq('user_id', userId)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error('Failed to fetch price alerts:', error);
      throw new Error(`Failed to fetch price alerts: ${error.message}`);
    }

    return (data || []).map(row => this.mapPriceAlert(row));
  }

  async deleteAlert(userId: string, alertId: string): Promise<void> {
    const { error } = await this.supabase
      .from('price_alerts')
      .update({ status: 'deleted' })
      .eq('id', alertId)
      .eq('user_id', userId);

    if (error) {
      this.logger.error('Failed to delete price alert:', error);
      throw new Error(`Failed to delete price alert: ${error.message}`);
    }
  }

  private mapPriceAlert(row: any): PriceAlert {
    return {
      id: row.id,
      userId: row.user_id,
      productQuery: row.product_query,
      targetPrice: row.target_price,
      productId: row.product_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
