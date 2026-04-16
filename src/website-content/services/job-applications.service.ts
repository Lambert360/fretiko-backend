import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../../shared/supabase.client';
import { CreateJobApplicationDto, UpdateJobApplicationDto, JobApplicationQueryDto, JobApplicationStatus } from '../dto/job-application.dto';

@Injectable()
export class JobApplicationsService {
  private serviceSupabase;

  constructor(private configService: ConfigService) {
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async findAll(query: JobApplicationQueryDto) {
    const { status, jobId, search, page = 1, limit = 10 } = query;
    
    let queryBuilder = this.serviceSupabase
      .from('job_applications')
      .select('*', { count: 'exact' });

    // Apply filters
    if (status) {
      queryBuilder = queryBuilder.eq('status', status);
    }

    if (jobId) {
      queryBuilder = queryBuilder.eq('job_id', jobId);
    }

    if (search) {
      queryBuilder = queryBuilder.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
    }

    // Apply pagination
    const offset = (page - 1) * limit;
    queryBuilder = queryBuilder
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await queryBuilder;

    if (error) {
      throw new Error(`Failed to fetch job applications: ${error.message}`);
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
      .from('job_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Job application with ID ${id} not found`);
    }

    return data;
  }

  async create(createJobApplicationDto: CreateJobApplicationDto) {
    console.log('Creating job application with DTO:', createJobApplicationDto);
    
    // Check if job listing exists and is active
  
    const { data: jobListing } = await this.serviceSupabase
      .from('job_listings')
      .select('id, title, status')
      .eq('id', createJobApplicationDto.jobId)
      .single();

    if (!jobListing) {
      throw new NotFoundException(`Job listing with ID ${createJobApplicationDto.jobId} not found`);
    }

    if (jobListing.status !== 'active') {
      throw new BadRequestException(`Job listing with ID ${createJobApplicationDto.jobId} is not active`);
    }
  

    // Check for duplicate applications (same email for same job)
    const { data: existingApplication } = await this.serviceSupabase
      .from('job_applications')
      .select('id')
      .eq('job_id', createJobApplicationDto.jobId)
      .eq('email', createJobApplicationDto.email)
      .single();

    if (existingApplication) {
      throw new ConflictException(`You have already applied for this job`);
    }

    // Map camelCase DTO fields to snake_case database columns
    const { coverLetter, jobId, jobTitle, ...restOfDto } = createJobApplicationDto;
    
    // Handle job_id - if it's not a valid UUID, use a placeholder
    // TODO: This should be fixed when proper job listings are created
    let jobUuid = jobId;
    if (!jobId || !jobId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) {
      // Use a placeholder UUID for testing - this should be replaced with actual job listing UUIDs
      jobUuid = '00000000-0000-0000-0000-000000000000';
    }
    
    const { data, error } = await this.serviceSupabase
      .from('job_applications')
      .insert({
        ...restOfDto,
        job_id: jobUuid, // Use null if not a valid UUID
        job_title: jobTitle, // Map camelCase to snake_case
        cover_letter: coverLetter, // Map camelCase to snake_case
        status: createJobApplicationDto.status || 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create job application: ${error.message}`);
    }

    return data;
  }

  async update(id: string, updateJobApplicationDto: UpdateJobApplicationDto) {
    // Check if job application exists
    await this.findOne(id);

    const { data, error } = await this.serviceSupabase
      .from('job_applications')
      .update({
        ...updateJobApplicationDto,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update job application: ${error.message}`);
    }

    return data;
  }

  async remove(id: string) {
    await this.findOne(id);

    const { error } = await this.serviceSupabase
      .from('job_applications')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete job application: ${error.message}`);
    }
  }

  async updateStatus(id: string, status: JobApplicationStatus) {
    return this.update(id, { status });
  }

  async getStatistics() {
    const [
      { count: totalApplications },
      { count: pendingApplications },
      { count: underReviewApplications },
      { count: approvedApplications },
      { count: rejectedApplications },
    ] = await Promise.all([
      this.serviceSupabase.from('job_applications').select('*', { count: 'exact', head: true }),
      this.serviceSupabase.from('job_applications').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      this.serviceSupabase.from('job_applications').select('*', { count: 'exact', head: true }).eq('status', 'under_review'),
      this.serviceSupabase.from('job_applications').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
      this.serviceSupabase.from('job_applications').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
    ]);

    return {
      total: totalApplications || 0,
      pending: pendingApplications || 0,
      under_review: underReviewApplications || 0,
      approved: approvedApplications || 0,
      rejected: rejectedApplications || 0,
    };
  }

  async getApplicationsByJob() {
    const { data, error } = await this.serviceSupabase
      .from('job_applications')
      .select('job_id, status')
      .eq('status', 'pending');

    if (error) {
      throw new Error(`Failed to fetch applications by job: ${error.message}`);
    }

    const jobCounts = data?.reduce((acc, app) => {
      const jobId = app.job_id;
      acc[jobId] = (acc[jobId] || 0) + 1;
      return acc;
    }, {}) || {};

    return jobCounts;
  }

  async getApplicationsByStatus() {
    const { data, error } = await this.serviceSupabase
      .from('job_applications')
      .select('status')
      .in('status', ['pending', 'under_review', 'approved', 'rejected']);

    if (error) {
      throw new Error(`Failed to fetch applications by status: ${error.message}`);
    }

    const statusCounts = data?.reduce((acc, app) => {
      const status = app.status;
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}) || {};

    return statusCounts;
  }

  async getRecentApplications(limit: number = 5) {
    const { data, error } = await this.serviceSupabase
      .from('job_applications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch recent applications: ${error.message}`);
    }

    return data || [];
  }

  async approveApplication(id: string) {
    return this.updateStatus(id, JobApplicationStatus.SHORTLISTED);
  }

  async rejectApplication(id: string) {
    return this.updateStatus(id, JobApplicationStatus.REJECTED);
  }

  async getApplicationsByDateRange(startDate: string, endDate: string) {
    const { data, error } = await this.serviceSupabase
      .from('job_applications')
      .select('*')
      .gte('created_at', startDate)
      .lte('created_at', endDate)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch applications by date range: ${error.message}`);
    }

    return data || [];
  }

  // Alias methods for controller compatibility
  async getApplicationStats() {
    return this.getStatistics();
  }

  async getJobApplicationStats(jobId?: string) {
    if (jobId) {
      // Return stats for specific job
      const { data, error } = await this.serviceSupabase
        .from('job_applications')
        .select('status')
        .eq('job_id', jobId);

      if (error) {
        throw new Error(`Failed to fetch job application stats: ${error.message}`);
      }

      const statusCounts = data?.reduce((acc, app) => {
        const status = app.status;
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {}) || {};

      return statusCounts;
    }
    
    // Return general statistics
    return this.getStatistics();
  }

  async findByJobId(jobId: string, query?: JobApplicationQueryDto) {
    let queryBuilder = this.serviceSupabase
      .from('job_applications')
      .select('*')
      .eq('job_id', jobId);

    // Apply filters if provided
    if (query) {
      if (query.status) {
        queryBuilder = queryBuilder.eq('status', query.status);
      }
      
      if (query.search) {
        queryBuilder = queryBuilder.or(`full_name.ilike.%${query.search}%,email.ilike.%${query.search}%,phone.ilike.%${query.search}%`);
      }
    }

    queryBuilder = queryBuilder.order('created_at', { ascending: false });

    const { data, error } = await queryBuilder;

    if (error) {
      throw new Error(`Failed to fetch applications for job ${jobId}: ${error.message}`);
    }

    return data || [];
  }

  async findById(id: string) {
    return this.findOne(id);
  }
}
