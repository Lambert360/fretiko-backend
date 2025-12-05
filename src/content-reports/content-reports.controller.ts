import { Controller, Post, Get, Body, Param, Req, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ContentReportsService } from './content-reports.service';
import type { CreateContentReportDto, ReviewContentReportDto } from './content-reports.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';

@Controller('content-reports')
@UseGuards(JwtAuthGuard)
export class ContentReportsController {
  constructor(private readonly contentReportsService: ContentReportsService) {}

  /**
   * Create a new content report
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createContentReport(@Req() req, @Body() createDto: CreateContentReportDto) {
    return this.contentReportsService.createContentReport(req.user.sub, createDto);
  }

  /**
   * Get all reports for current user
   */
  @Get('my-reports')
  async getMyReports(@Req() req) {
    return this.contentReportsService.getUserReports(req.user.sub);
  }

  /**
   * Get content report details
   */
  @Get(':id')
  async getContentReport(@Req() req, @Param('id') reportId: string) {
    return this.contentReportsService.getContentReport(req.user.sub, reportId);
  }

  /**
   * Add a message to a report thread
   */
  @Post(':id/messages')
  async addMessage(
    @Req() req,
    @Param('id') reportId: string,
    @Body() body: { message: string; attachments?: Array<{ type: string; url: string }> },
  ) {
    return this.contentReportsService.addReportMessage(req.user.sub, reportId, body.message, body.attachments);
  }

  /**
   * Get all pending reports (moderators only)
   */
  @Get('admin/pending')
  @UseGuards(AdminGuard)
  async getAllPendingReports(@Req() req) {
    return this.contentReportsService.getAllPendingReports();
  }

  /**
   * Get all reports with filters (moderators only)
   */
  @Get('admin/all')
  @UseGuards(AdminGuard)
  async getAllReports(
    @Req() req,
    @Query('status') status?: 'pending' | 'under_review' | 'approved' | 'action_taken' | 'dismissed',
    @Query('category') category?: 'product' | 'service' | 'chat' | 'user',
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.contentReportsService.getAllReports({
      status,
      category,
      search,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  /**
   * Get content report statistics (moderators only)
   */
  @Get('admin/stats')
  @UseGuards(AdminGuard)
  async getStats(@Req() req) {
    return this.contentReportsService.getContentReportStats();
  }

  /**
   * Review content report (moderators only)
   */
  @Post(':id/review')
  @UseGuards(AdminGuard)
  async reviewContentReport(
    @Req() req,
    @Param('id') reportId: string,
    @Body() reviewDto: ReviewContentReportDto,
  ) {
    return this.contentReportsService.reviewContentReport(req.user.sub, reportId, reviewDto);
  }
}

