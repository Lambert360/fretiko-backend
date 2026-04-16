import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../../shared/supabase.client';
import { CreateJobListingDto, UpdateJobListingDto, JobListingQueryDto, JobStatus } from '../dto/job-listing.dto';

@Injectable()
export class JobListingsService {
  private serviceSupabase;

  constructor(private configService: ConfigService) {
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async findAll(query: JobListingQueryDto) {
    const { status, type, department, location, remoteWork, experienceLevel, search, page = 1, limit = 10 } = query;
    
    let queryBuilder = this.serviceSupabase
      .from('job_listings')
      .select('*', { count: 'exact' });

    // Apply filters
    if (status) {
      queryBuilder = queryBuilder.eq('status', status);
    }

    if (type) {
      queryBuilder = queryBuilder.eq('type', type);
    }

    if (department) {
      queryBuilder = queryBuilder.eq('department', department);
    }

    if (location) {
      queryBuilder = queryBuilder.ilike('location', `%${location}%`);
    }

    if (remoteWork !== undefined) {
      queryBuilder = queryBuilder.eq('remote_work', remoteWork);
    }

    if (experienceLevel) {
      queryBuilder = queryBuilder.eq('experience_level', experienceLevel);
    }

    if (search) {
      queryBuilder = queryBuilder.or(`title.ilike.%${search}%,description.ilike.%${search}%,department.ilike.%${search}%`);
    }

    // Apply pagination
    const offset = (page - 1) * limit;
    queryBuilder = queryBuilder
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await queryBuilder;

    if (error) {
      throw new Error(`Failed to fetch job listings: ${error.message}`);
    }

    return {
      data: data || [],
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    };
  }

    async findOne(id: string) {
    const { data, error } = await this.serviceSupabase
      .from('job_listings')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Job listing with ID ${id} not found`);
    }

    return data;
  }

  async create(createJobListingDto: CreateJobListingDto) {
    // Check if slug already exists
    const { data: existingSlug } = await this.serviceSupabase
      .from('job_listings')
      .select('id')
      .eq('slug', createJobListingDto.slug)
      .single();

    if (existingSlug) {
      throw new ConflictException(`Job listing with slug '${createJobListingDto.slug}' already exists`);
    }

    const { data, error } = await this.serviceSupabase
      .from('job_listings')
      .insert({
        ...createJobListingDto,
        status: createJobListingDto.status || 'draft',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create job listing: ${error.message}`);
    }

    return data;
  }

  async update(id: string, updateJobListingDto: UpdateJobListingDto) {
    // Check if job listing exists
    await this.findOne(id);

    // If updating slug, check for duplicates
    if (updateJobListingDto.slug) {
      const { data: existingSlug } = await this.serviceSupabase
        .from('job_listings')
        .select('id')
        .eq('slug', updateJobListingDto.slug)
        .neq('id', id)
        .single();

      if (existingSlug) {
        throw new ConflictException(`Job listing with slug '${updateJobListingDto.slug}' already exists`);
      }
    }

    const { data, error } = await this.serviceSupabase
      .from('job_listings')
      .update({
        ...updateJobListingDto,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update job listing: ${error.message}`);
    }

    return data;
  }

  async remove(id: string) {
    await this.findOne(id);

    const { error } = await this.serviceSupabase
      .from('job_listings')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete job listing: ${error.message}`);
    }
  }

  async updateStatus(id: string, status: JobStatus) {
    return this.update(id, { status });
  }

  async getStatistics() {
    const [
      { count: totalJobs },
      { count: activeJobs },
      { count: draftJobs },
      { count: closedJobs },
    ] = await Promise.all([
      this.serviceSupabase.from('job_listings').select('*', { count: 'exact', head: true }),
      this.serviceSupabase.from('job_listings').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      this.serviceSupabase.from('job_listings').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
      this.serviceSupabase.from('job_listings').select('*', { count: 'exact', head: true }).eq('status', 'closed'),
    ]);

    return {
      total: totalJobs || 0,
      active: activeJobs || 0,
      draft: draftJobs || 0,
      closed: closedJobs || 0,
    };
  }

  async getJobsByDepartment() {
    const { data, error } = await this.serviceSupabase
      .from('job_listings')
      .select('department')
      .eq('status', 'active');

    if (error) {
      throw new Error(`Failed to fetch jobs by department: ${error.message}`);
    }

    const departmentCounts = data?.reduce((acc, job) => {
      const dept = job.department || 'Unknown';
      acc[dept] = (acc[dept] || 0) + 1;
      return acc;
    }, {}) || {};

    return departmentCounts;
  }

  async getJobsByType() {
    const { data, error } = await this.serviceSupabase
      .from('job_listings')
      .select('type')
      .eq('status', 'active');

    if (error) {
      throw new Error(`Failed to fetch jobs by type: ${error.message}`);
    }

    const typeCounts = data?.reduce((acc, job) => {
      const type = job.type || 'Unknown';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {}) || {};

    return typeCounts;
  }

  async publishJob(id: string) {
    return this.updateStatus(id, JobStatus.ACTIVE);
  }

  async closeJob(id: string) {
    return this.updateStatus(id, JobStatus.CLOSED);
  }

  async getRecentJobs(limit = 5) {
    const { data, error } = await this.serviceSupabase
      .from('job_listings')
      .select('*')
      .eq('status', JobStatus.ACTIVE)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch recent jobs: ${error.message}`);
    }

    return data || [];
  }

  // Alias methods for controller compatibility
  async findById(id: string) {
    return this.findOne(id);
  }

  async findPublished(query: JobListingQueryDto) {
    return this.findAll({ ...query, status: JobStatus.PUBLISHED });
  }

  async getJobStats() {
    return this.getStatistics();
  }

  async getDepartmentStats() {
    return this.getJobsByDepartment();
  }

  async getTypeStats() {
    return this.getJobsByType();
  }
}
