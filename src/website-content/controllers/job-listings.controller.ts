import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Delete, 
  Body, 
  Param, 
  Query,
  UseGuards,
  HttpStatus,
  HttpCode
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { StaffJwtAuthGuard } from '../../staff/guards/staff-jwt-auth.guard';
import { JobListingsService } from '../services/job-listings.service';
import { CreateJobListingDto, UpdateJobListingDto, JobListingQueryDto } from '../dto/job-listing.dto';

@ApiTags('Website Content - Jobs')
@Controller('admin/website-content/job-listings')
@UseGuards(StaffJwtAuthGuard)
export class JobListingsController {
  constructor(private readonly jobListingsService: JobListingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all job listings' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job listings retrieved successfully' })
  async findAll(@Query() query: JobListingQueryDto) {
    return this.jobListingsService.findAll(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get job listings statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Statistics retrieved successfully' })
  async getStats() {
    const [stats, departmentStats, typeStats] = await Promise.all([
      this.jobListingsService.getJobStats(),
      this.jobListingsService.getDepartmentStats(),
      this.jobListingsService.getTypeStats(),
    ]);

    return {
      ...stats,
      departments: departmentStats,
      types: typeStats,
    };
  }

  @Get('departments')
  @ApiOperation({ summary: 'Get job department statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Department statistics retrieved successfully' })
  async getDepartmentStats() {
    return this.jobListingsService.getDepartmentStats();
  }

  @Get('types')
  @ApiOperation({ summary: 'Get job type statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Type statistics retrieved successfully' })
  async getTypeStats() {
    return this.jobListingsService.getTypeStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get job listing by ID' })
  @ApiParam({ name: 'id', description: 'Job listing ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job listing retrieved successfully' })
  async findById(@Param('id') id: string) {
    return this.jobListingsService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create new job listing' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Job listing created successfully' })
  async create(@Body() createJobListingDto: CreateJobListingDto) {
    return this.jobListingsService.create(createJobListingDto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update job listing' })
  @ApiParam({ name: 'id', description: 'Job listing ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job listing updated successfully' })
  async update(
    @Param('id') id: string,
    @Body() updateJobListingDto: UpdateJobListingDto
  ) {
    return this.jobListingsService.update(id, updateJobListingDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete job listing' })
  @ApiParam({ name: 'id', description: 'Job listing ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job listing deleted successfully' })
  async remove(@Param('id') id: string) {
    return this.jobListingsService.remove(id);
  }
}

// Public controller for website frontend
@ApiTags('Public - Jobs')
@Controller('public/job-listings')
export class PublicJobListingsController {
  constructor(private readonly jobListingsService: JobListingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get published job listings' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Published job listings retrieved successfully' })
  async findPublished(@Query() query: JobListingQueryDto) {
    return this.jobListingsService.findPublished(query);
  }

  @Get('departments')
  @ApiOperation({ summary: 'Get job department statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Department statistics retrieved successfully' })
  async getDepartmentStats() {
    return this.jobListingsService.getDepartmentStats();
  }

  @Get('types')
  @ApiOperation({ summary: 'Get job type statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Type statistics retrieved successfully' })
  async getTypeStats() {
    return this.jobListingsService.getTypeStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get published job listing by ID' })
  @ApiParam({ name: 'id', description: 'Job listing ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Job listing retrieved successfully' })
  async findById(@Param('id') id: string) {
    return this.jobListingsService.findById(id);
  }
}
