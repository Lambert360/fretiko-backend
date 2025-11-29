import { Controller, Post, Get, Patch, Body, Param, Query, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { CreateReportDto, UpdateReportDto, ReviewReportDto, ReportListFilterDto } from './dto/report.dto';

/**
 * Reports Controller
 * Internal reporting system endpoints
 */
@Controller('reports')
@UseGuards(StaffJwtAuthGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /**
   * Create a new report
   * POST /reports
   * Requires: create_reports permission
   */
  @Post()
  @UseGuards(PermissionsGuard)
  @Permissions('create_reports')
  @HttpCode(HttpStatus.CREATED)
  async createReport(@Body() reportDto: CreateReportDto, @Req() req) {
    return this.reportsService.createReport(req.user.sub, reportDto);
  }

  /**
   * Get all reports (filtered by permissions)
   * GET /reports
   */
  @Get()
  @UseGuards(PermissionsGuard)
  @Permissions('view_reports')
  async getReports(@Query() filters: ReportListFilterDto, @Req() req) {
    return this.reportsService.getReports(req.user.sub, filters);
  }

  /**
   * Get report statistics
   * GET /reports/stats
   */
  @Get('stats')
  async getReportStats(@Req() req) {
    return this.reportsService.getReportStats(req.user.sub);
  }

  /**
   * Get report by ID
   * GET /reports/:id
   */
  @Get(':id')
  async getReportById(@Param('id') id: string, @Req() req) {
    return this.reportsService.getReportById(id, req.user.sub);
  }

  /**
   * Update report (only draft reports)
   * PATCH /reports/:id
   */
  @Patch(':id')
  async updateReport(@Param('id') id: string, @Body() updateDto: UpdateReportDto, @Req() req) {
    return this.reportsService.updateReport(id, req.user.sub, updateDto);
  }

  /**
   * Submit report
   * POST /reports/:id/submit
   */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  async submitReport(@Param('id') id: string, @Req() req) {
    return this.reportsService.submitReport(id, req.user.sub);
  }

  /**
   * Review report (department heads and super admin)
   * POST /reports/:id/review
   */
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  async reviewReport(@Param('id') id: string, @Body() reviewDto: ReviewReportDto, @Req() req) {
    return this.reportsService.reviewReport(id, req.user.sub, reviewDto);
  }

  /**
   * Escalate report to super admin
   * POST /reports/:id/escalate
   */
  @Post(':id/escalate')
  @HttpCode(HttpStatus.OK)
  async escalateReport(@Param('id') id: string, @Req() req) {
    return this.reportsService.escalateReport(id, req.user.sub);
  }
}
