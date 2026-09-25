/**
 * BROADCASTS CONTROLLER
 * Admin endpoints for vendor/user promotional broadcasts.
 * Auth: staff JWT + department permission 'send_broadcasts'.
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { BroadcastsService, SendBroadcastInput, BroadcastAudience } from './broadcasts.service';

@Controller('admin/broadcasts')
@UseGuards(StaffJwtAuthGuard)
export class BroadcastsController {
  constructor(private readonly broadcastsService: BroadcastsService) {}

  // ---------- Templates ----------

  @Get('templates')
  @UseGuards(PermissionsGuard)
  @Permissions('send_broadcasts')
  async listTemplates() {
    return this.broadcastsService.listTemplates();
  }

  @Post('templates')
  @UseGuards(PermissionsGuard)
  @Permissions('send_broadcasts')
  async createTemplate(@Body() body: any, @Req() req) {
    return this.broadcastsService.createTemplate(body, req.user?.sub);
  }

  @Patch('templates/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('send_broadcasts')
  async updateTemplate(@Param('id') id: string, @Body() body: any) {
    return this.broadcastsService.updateTemplate(id, body);
  }

  @Delete('templates/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('send_broadcasts')
  async deleteTemplate(@Param('id') id: string) {
    return this.broadcastsService.deleteTemplate(id);
  }

  // ---------- Audience ----------

  @Get('audience-count')
  @UseGuards(PermissionsGuard)
  @Permissions('send_broadcasts')
  async getAudienceCount(@Query('audience') audience: BroadcastAudience = 'vendors') {
    const count = await this.broadcastsService.getAudienceCount(audience);
    return { audience, count };
  }

  // ---------- Sends ----------

  @Get()
  @UseGuards(PermissionsGuard)
  @Permissions('send_broadcasts')
  async listSends(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.broadcastsService.listSends(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Post('send')
  @UseGuards(PermissionsGuard)
  @Permissions('send_broadcasts')
  async sendBroadcast(@Body() body: SendBroadcastInput, @Req() req) {
    return this.broadcastsService.sendBroadcast(body, req.user?.sub, 'manual');
  }

  @Post('test')
  @UseGuards(PermissionsGuard)
  @Permissions('send_broadcasts')
  async testBroadcast(@Body() body: SendBroadcastInput & { userId: string }, @Req() req) {
    return this.broadcastsService.testBroadcast(body, body.userId);
  }
}
