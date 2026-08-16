import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { HttpStatus, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { StaffJwtAuthGuard } from '../../staff/guards/staff-jwt-auth.guard';
import { JobApplicationsService } from '../services/job-applications.service';
import { CreateJobApplicationDto, UpdateJobApplicationDto, JobApplicationQueryDto } from '../dto/job-application.dto';

@ApiTags('Website Content - Job Applications')
@Controller('admin/website-content/job-applications')
@UseGuards(StaffJwtAuthGuard)
export class JobApplicationsController {
  constructor(private readonly jobApplicationsService: JobApplicationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all job applications' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job applications retrieved successfully' })
  async findAll(@Query() query: JobApplicationQueryDto) {
    return this.jobApplicationsService.findAll(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get job applications statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Statistics retrieved successfully' })
  async getStats() {
    return this.jobApplicationsService.getApplicationStats();
  }

  @Get('recent')
  @ApiOperation({ summary: 'Get recent job applications' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Recent applications retrieved successfully' })
  async getRecent(@Query('limit') limit?: number) {
    return this.jobApplicationsService.getRecentApplications(limit || 10);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get job application by ID' })
  @ApiParam({ name: 'id', description: 'Job application ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job application retrieved successfully' })
  async findById(@Param('id') id: string) {
    return this.jobApplicationsService.findById(id);
  }

  @Get('job/:jobId')
  @ApiOperation({ summary: 'Get applications for specific job' })
  @ApiParam({ name: 'jobId', description: 'Job listing ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job applications retrieved successfully' })
  async findByJobId(
    @Param('jobId') jobId: string,
    @Query() query: JobApplicationQueryDto
  ) {
    return this.jobApplicationsService.findByJobId(jobId, query);
  }

  @Get('job/:jobId/stats')
  @ApiOperation({ summary: 'Get application statistics for specific job' })
  @ApiParam({ name: 'jobId', description: 'Job listing ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job application statistics retrieved successfully' })
  async getJobStats(@Param('jobId') jobId: string) {
    return this.jobApplicationsService.getJobApplicationStats(jobId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update job application status' })
  @ApiParam({ name: 'id', description: 'Job application ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job application updated successfully' })
  async update(
    @Param('id') id: string,
    @Body() updateJobApplicationDto: UpdateJobApplicationDto
  ) {
    return this.jobApplicationsService.update(id, updateJobApplicationDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete job application' })
  @ApiParam({ name: 'id', description: 'Job application ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job application deleted successfully' })
  async remove(@Param('id') id: string) {
    return this.jobApplicationsService.remove(id);
  }
}

// Public controller for website frontend
@ApiTags('Public - Job Applications')
@Controller('public/website-content/job-applications')
export class PublicJobApplicationsController {
  constructor(private readonly jobApplicationsService: JobApplicationsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit job application' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Job application submitted successfully' })
  async create(@Body() createJobApplicationDto: CreateJobApplicationDto) {
    return this.jobApplicationsService.create(createJobApplicationDto);
  }
}
