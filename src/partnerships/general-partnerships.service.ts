import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';

export interface CreateGeneralPartnershipDto {
  name: string;
  email: string;
  company: string;
  phone?: string;
  partnership_type: string;
  message?: string;
}

export interface GeneralPartnership {
  id: string;
  name: string;
  email: string;
  company: string;
  phone?: string;
  partnership_type: string;
  message?: string;
  status: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class GeneralPartnershipsService {
  private readonly logger = new Logger(GeneralPartnershipsService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Create a new general partnership application
   */
  async createPartnership(data: CreateGeneralPartnershipDto): Promise<{ id: string }> {
    this.logger.log(`Creating general partnership application for ${data.name}`);

    try {
      const { data: partnership, error } = await this.supabase
        .from('general_partnerships')
        .insert({
          name: data.name,
          email: data.email,
          company: data.company,
          phone: data.phone,
          partnership_type: data.partnership_type,
          message: data.message,
          status: 'pending'
        })
        .select('id')
        .single();

      if (error) {
        this.logger.error('Failed to create general partnership:', error);
        throw new Error('Failed to create partnership application');
      }

      if (!partnership?.id) {
        this.logger.error('No ID returned from database');
        throw new Error('Failed to create partnership application');
      }

      this.logger.log(`General partnership created with ID: ${partnership.id}`);
      return { id: partnership.id };
    } catch (error) {
      this.logger.error('Error creating general partnership:', error);
      throw new Error('Failed to create partnership application');
    }
  }

  /**
   * Get all general partnership applications
   */
  async getPartnerships(filters?: {
    status?: string;
    page?: string;
    limit?: string;
    search?: string;
  }): Promise<{ partnerships: GeneralPartnership[]; total: number }> {
    this.logger.log('Fetching general partnerships with filters:', filters);

    try {
      let query = this.supabase
        .from('general_partnerships')
        .select('*')
        .order('created_at', { ascending: false });

      // Apply filters
      if (filters?.status) {
        query = query.eq('status', filters.status);
      }
      if (filters?.page && filters?.limit) {
        const offset = (parseInt(filters.page) - 1) * parseInt(filters.limit);
        query = query.range(offset, parseInt(filters.limit));
      }
      if (filters?.search) {
        query = query.or(`name.ilike.%${filters.search}%`, `company.ilike.%${filters.search}%`);
      }

      const { data: partnerships, error, count } = await query;

      if (error) {
        this.logger.error('Failed to fetch general partnerships:', error);
        throw new Error('Failed to fetch partnerships');
      }

      const total = count || 0;
      return { partnerships, total };
    } catch (error) {
      this.logger.error('Error fetching general partnerships:', error);
      throw new Error('Failed to fetch partnerships');
    }
  }

  /**
   * Get partnership by ID
   */
  async getPartnershipById(id: string): Promise<GeneralPartnership> {
    this.logger.log(`Fetching general partnership by ID: ${id}`);

    try {
      const { data: partnership, error } = await this.supabase
        .from('general_partnerships')
        .select('*')
        .eq('id', id)
        .single();

      if (error) {
        this.logger.error('Failed to fetch partnership by ID:', error);
        throw new Error('Failed to fetch partnership');
      }

      if (!partnership) {
        this.logger.error('Partnership not found');
        throw new Error('Partnership not found');
      }

      return partnership;
    } catch (error) {
      this.logger.error('Error fetching partnership by ID:', error);
      throw new Error('Failed to fetch partnership');
    }
  }

  /**
   * Update partnership status
   */
  async updatePartnershipStatus(id: string, status: string): Promise<void> {
    this.logger.log(`Updating partnership status to ${status} for ID: ${id}`);

    try {
      const { error } = await this.supabase
        .from('general_partnerships')
        .update({ status })
        .eq('id', id);

      if (error) {
        this.logger.error('Failed to update partnership status:', error);
        throw new Error('Failed to update partnership status');
      }

      this.logger.log(`Partnership status updated successfully for ID: ${id}`);
    } catch (error) {
      this.logger.error('Error updating partnership status:', error);
      throw new Error('Failed to update partnership status');
    }
  }
}
