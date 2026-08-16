import { Controller, Get, Post, Body, Param, Query, UseGuards, Request } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger'
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard'
import { PartnershipsService } from './partnerships.service'

@ApiTags('admin-partnerships')
@Controller('admin/partnerships')
@UseGuards(StaffJwtAuthGuard)
@ApiBearerAuth()
export class PartnershipsController {
  constructor(private readonly partnershipsService: PartnershipsService) {}

  @Get('logistics')
  @ApiOperation({ summary: 'Get logistics partnership applications' })
  @ApiResponse({ status: 200, description: 'Logistics applications retrieved successfully' })
  async getLogisticsApplications(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.partnershipsService.getLogisticsApplications({
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      status,
      search,
    })
  }

  @Get('general')
  @ApiOperation({ summary: 'Get general partnership applications' })
  @ApiResponse({ status: 200, description: 'General applications retrieved successfully' })
  async getGeneralApplications(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.partnershipsService.getGeneralApplications({
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      status,
      search,
    })
  }

  @Post('general')
  @ApiOperation({ summary: 'Create general partnership application' })
  @ApiResponse({ status: 201, description: 'Application created successfully' })
  async createGeneralApplication(@Body() applicationData: any) {
    return this.partnershipsService.createGeneralApplication(applicationData)
  }

  @Get('logistics/:id')
  @ApiOperation({ summary: 'Get logistics application by ID' })
  @ApiResponse({ status: 200, description: 'Application retrieved successfully' })
  async getLogisticsApplicationById(@Param('id') id: string) {
    return this.partnershipsService.getLogisticsApplicationById(id)
  }

  @Get('general/:id')
  @ApiOperation({ summary: 'Get general application by ID' })
  @ApiResponse({ status: 200, description: 'Application retrieved successfully' })
  async getGeneralApplicationById(@Param('id') id: string) {
    return this.partnershipsService.getGeneralApplicationById(id)
  }

  @Post('logistics/:id/verify')
  @ApiOperation({ summary: 'Verify logistics application' })
  @ApiResponse({ status: 200, description: 'Application verified successfully' })
  async verifyLogisticsApplication(
    @Param('id') id: string,
    @Request() req: any,
    @Body() data: { notes?: string }
  ) {
    return this.partnershipsService.verifyLogisticsApplication(id, req.user.id, data.notes)
  }

  @Post('logistics/:id/reject')
  @ApiOperation({ summary: 'Reject logistics application' })
  @ApiResponse({ status: 200, description: 'Application rejected successfully' })
  async rejectLogisticsApplication(
    @Param('id') id: string,
    @Request() req: any,
    @Body() data: { reason: string; notes?: string }
  ) {
    return this.partnershipsService.rejectLogisticsApplication(id, req.user.id, data.reason, data.notes)
  }

  @Post('general/:id/approve')
  @ApiOperation({ summary: 'Approve general application' })
  @ApiResponse({ status: 200, description: 'Application approved successfully' })
  async approveGeneralApplication(
    @Param('id') id: string,
    @Request() req: any,
    @Body() data: { notes?: string }
  ) {
    return this.partnershipsService.approveGeneralApplication(id, req.user.id, data.notes)
  }

  @Post('general/:id/reject')
  @ApiOperation({ summary: 'Reject general application' })
  @ApiResponse({ status: 200, description: 'Application rejected successfully' })
  async rejectGeneralApplication(
    @Param('id') id: string,
    @Request() req: any,
    @Body() data: { reason: string; notes?: string }
  ) {
    return this.partnershipsService.rejectGeneralApplication(id, req.user.id, data.reason, data.notes)
  }
}
