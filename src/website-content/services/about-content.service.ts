import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../../shared/supabase.client';
import { CreateAboutContentDto, UpdateAboutContentDto, UpdateOrderDto } from '../dto/about-content.dto';

@Injectable()
export class AboutContentService {
  private serviceSupabase;

  constructor(private configService: ConfigService) {
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async findAll() {
    const { data, error } = await this.serviceSupabase
      .from('about_content')
      .select('*')
      .order('order_num', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch about content: ${error.message}`);
    }

    return data || [];
  }

  async findActive() {
    const { data, error } = await this.serviceSupabase
      .from('about_content')
      .select('*')
      .eq('is_active', true)
      .order('order_num', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch active about content: ${error.message}`);
    }

    return data || [];
  }

  async findOne(id: string) {
    const { data, error } = await this.serviceSupabase
      .from('about_content')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException(`About content with ID ${id} not found`);
    }

    return data;
  }

  async findById(id: string) {
    return this.findOne(id);
  }

  async findBySection(section: string) {
    const { data, error } = await this.serviceSupabase
      .from('about_content')
      .select('*')
      .eq('section', section)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      throw new NotFoundException(`About content section '${section}' not found`);
    }

    return data;
  }

  async create(createAboutContentDto: CreateAboutContentDto) {
    // Check if section already exists
    const { data: existingSection } = await this.serviceSupabase
      .from('about_content')
      .select('id')
      .eq('section', createAboutContentDto.section)
      .single();

    if (existingSection) {
      throw new ConflictException(`About content section '${createAboutContentDto.section}' already exists`);
    }

    const { data, error } = await this.serviceSupabase
      .from('about_content')
      .insert({
        ...createAboutContentDto,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create about content: ${error.message}`);
    }

    return data;
  }

  async update(id: string, updateAboutContentDto: UpdateAboutContentDto) {
    // Check if about content exists
    await this.findOne(id);

    // If updating section, check for duplicates
    if (updateAboutContentDto.section) {
      const { data: existingSection } = await this.serviceSupabase
        .from('about_content')
        .select('id')
        .eq('section', updateAboutContentDto.section)
        .neq('id', id)
        .single();

      if (existingSection) {
        throw new ConflictException(`About content section '${updateAboutContentDto.section}' already exists`);
      }
    }

    const { data, error } = await this.serviceSupabase
      .from('about_content')
      .update({
        ...updateAboutContentDto,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update about content: ${error.message}`);
    }

    return data;
  }

  async remove(id: string) {
    await this.findOne(id);

    const { error } = await this.serviceSupabase
      .from('about_content')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete about content: ${error.message}`);
    }
  }

  async updateOrder(updateOrderDto: UpdateOrderDto) {
    const { sectionIds } = updateOrderDto;

    // Update each item's order in a transaction
    const updates = sectionIds.map((id, index) =>
      this.serviceSupabase
        .from('about_content')
        .update({ order: index + 1, updated_at: new Date().toISOString() })
        .eq('id', id)
    );

    const results = await Promise.all(updates);
    
    // Check if any update failed
    const failedUpdate = results.find(result => result.error);
    if (failedUpdate) {
      throw new Error(`Failed to update order: ${failedUpdate.error.message}`);
    }

    return { success: true, message: 'Order updated successfully' };
  }

  async getStatistics() {
    const [
      { count: totalSections },
      { count: activeSections },
      { count: inactiveSections },
    ] = await Promise.all([
      this.serviceSupabase.from('about_content').select('*', { count: 'exact', head: true }),
      this.serviceSupabase.from('about_content').select('*', { count: 'exact', head: true }).eq('is_active', true),
      this.serviceSupabase.from('about_content').select('*', { count: 'exact', head: true }).eq('is_active', false),
    ]);

    return {
      total: totalSections || 0,
      active: activeSections || 0,
      inactive: inactiveSections || 0,
    };
  }

  async activateSection(id: string) {
    return this.update(id, { isActive: true });
  }

  async deactivateSection(id: string) {
    return this.update(id, { isActive: false });
  }

  async getNextOrder() {
    const { data, error } = await this.serviceSupabase
      .from('about_content')
      .select('order_num')
      .order('order_num', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return 1; // First item
    }

    return (data.order_num || 0) + 1;
  }

  async findPublished(query: any = {}) {
    const { section } = query;
    
    let queryBuilder = this.serviceSupabase
      .from('about_content')
      .select('*')
      .eq('is_active', true);

    if (section) {
      queryBuilder = queryBuilder.eq('section', section);
    }

    const { data, error } = await queryBuilder
      .order('order_num', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch published about content: ${error.message}`);
    }

    return data || [];
  }

  async getSectionStats() {
    const { data, error } = await this.serviceSupabase
      .from('about_content')
      .select('section')
      .eq('is_active', true);

    if (error) {
      throw new Error(`Failed to fetch section stats: ${error.message}`);
    }

    const sectionCounts = data?.reduce((acc, item) => {
      const section = item.section || 'Unknown';
      acc[section] = (acc[section] || 0) + 1;
      return acc;
    }, {}) || {};

    return sectionCounts;
  }
}
