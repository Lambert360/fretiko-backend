import { Controller, Get, Patch, Post, Param, Query, Body, UseGuards, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Content Moderation Controller
 * Handles moderation of products, services, stories, and live streams
 * Requires staff authentication and appropriate permissions
 */
@Controller('admin/content')
@UseGuards(StaffJwtAuthGuard)
export class ContentModerationController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get products for moderation
   * GET /admin/content/products
   * Requires: view_products permission
   */
  @Get('products')
  @UseGuards(PermissionsGuard)
  @Permissions('view_products')
  async getProductsForModeration(
    @Req() req,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getProductsForModeration(
      req.user.sub,
      {
        status: status as any,
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
        search,
      },
    );
  }

  /**
   * Approve product
   * POST /admin/content/products/:id/approve
   * Requires: approve_products permission
   */
  @Post('products/:id/approve')
  @UseGuards(PermissionsGuard)
  @Permissions('approve_products')
  async approveProduct(@Req() req, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.adminService.approveProduct(req.user.sub, id, body.reason);
  }

  /**
   * Reject/Remove product
   * POST /admin/content/products/:id/reject
   * Requires: remove_products permission
   */
  @Post('products/:id/reject')
  @UseGuards(PermissionsGuard)
  @Permissions('remove_products')
  async rejectProduct(@Req() req, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.adminService.rejectProduct(req.user.sub, id, body.reason);
  }

  /**
   * Get services for moderation
   * GET /admin/content/services
   * Requires: view_services permission
   */
  @Get('services')
  @UseGuards(PermissionsGuard)
  @Permissions('view_services')
  async getServicesForModeration(
    @Req() req,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getServicesForModeration(
      req.user.sub,
      {
        status: status as any,
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
        search,
      },
    );
  }

  /**
   * Approve service
   * POST /admin/content/services/:id/approve
   * Requires: approve_services permission
   */
  @Post('services/:id/approve')
  @UseGuards(PermissionsGuard)
  @Permissions('approve_services')
  async approveService(@Req() req, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.adminService.approveService(req.user.sub, id, body.reason);
  }

  /**
   * Reject/Remove service
   * POST /admin/content/services/:id/reject
   * Requires: remove_services permission
   */
  @Post('services/:id/reject')
  @UseGuards(PermissionsGuard)
  @Permissions('remove_services')
  async rejectService(@Req() req, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.adminService.rejectService(req.user.sub, id, body.reason);
  }

  /**
   * Get stories for moderation
   * GET /admin/content/stories
   * Requires: view_stories permission
   */
  @Get('stories')
  @UseGuards(PermissionsGuard)
  @Permissions('view_stories')
  async getStoriesForModeration(
    @Req() req,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getStoriesForModeration(
      req.user.sub,
      {
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
        search,
      },
    );
  }

  /**
   * Remove story
   * POST /admin/content/stories/:id/remove
   * Requires: remove_stories permission
   */
  @Post('stories/:id/remove')
  @UseGuards(PermissionsGuard)
  @Permissions('remove_stories')
  async removeStory(@Req() req, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.adminService.removeStory(req.user.sub, id, body.reason);
  }

  /**
   * Get live streams for moderation
   * GET /admin/content/live-streams
   * Requires: view_live_streams permission
   */
  @Get('live-streams')
  @UseGuards(PermissionsGuard)
  @Permissions('view_live_streams')
  async getLiveStreamsForModeration(
    @Req() req,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getLiveStreamsForModeration(
      req.user.sub,
      {
        status: status as any,
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
      },
    );
  }

  /**
   * End live stream
   * POST /admin/content/live-streams/:id/end
   * Requires: end_live_streams permission
   */
  @Post('live-streams/:id/end')
  @UseGuards(PermissionsGuard)
  @Permissions('end_live_streams')
  async endLiveStream(@Req() req, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.adminService.endLiveStream(req.user.sub, id, body.reason);
  }

  /**
   * Get auctions for moderation
   * GET /admin/content/auctions
   * Requires: view_products permission (auctions are similar to products)
   */
  @Get('auctions')
  @UseGuards(PermissionsGuard)
  @Permissions('view_products')
  async getAuctionsForModeration(
    @Req() req,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getAuctionsForModeration(
      req.user.sub,
      {
        status: status as any,
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
        search,
      },
    );
  }

  /**
   * Approve auction
   * POST /admin/content/auctions/:id/approve
   * Requires: approve_products permission
   */
  @Post('auctions/:id/approve')
  @UseGuards(PermissionsGuard)
  @Permissions('approve_products')
  async approveAuction(@Req() req, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.adminService.approveAuction(req.user.sub, id, body.reason);
  }

  /**
   * Reject/Cancel auction
   * POST /admin/content/auctions/:id/reject
   * Requires: remove_products permission
   */
  @Post('auctions/:id/reject')
  @UseGuards(PermissionsGuard)
  @Permissions('remove_products')
  async rejectAuction(@Req() req, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.adminService.rejectAuction(req.user.sub, id, body.reason);
  }

  /**
   * Get content moderation statistics
   * GET /admin/content/stats
   * Requires: view_products permission
   */
  @Get('stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_products')
  async getContentModerationStats(@Req() req) {
    return this.adminService.getContentModerationStats(req.user.sub);
  }
}

