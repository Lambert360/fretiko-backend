import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkspaceService } from './workspace.service';

@Controller('workspace')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get('orders/active')
  async getActiveOrders(@Request() req) {
    return await this.workspaceService.getActiveOrders(
      req.user.sub,
      req.supabaseToken,
    );
  }

  @Get('orders/completed')
  async getCompletedOrders(
    @Request() req,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return await this.workspaceService.getCompletedOrders(
      req.user.sub,
      parseInt(limit || '50') || 50,
      parseInt(offset || '0') || 0,
      req.supabaseToken,
    );
  }

  @Get('stats')
  async getWorkspaceStats(@Request() req) {
    return await this.workspaceService.getWorkspaceStats(
      req.user.sub,
      req.supabaseToken,
    );
  }

  @Get('orders/:id')
  async getOrderDetails(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return await this.workspaceService.getOrderDetails(
      req.user.sub,
      orderId,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/accept')
  async acceptOrder(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return await this.workspaceService.acceptOrder(
      req.user.sub,
      orderId,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/decline')
  async declineOrder(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body: { reason?: string },
  ) {
    return await this.workspaceService.declineOrder(
      req.user.sub,
      orderId,
      body.reason,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/ready')
  async markOrderReady(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return await this.workspaceService.markOrderReady(
      req.user.sub,
      orderId,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/ready-for-pickup')
  async markOrderReadyForPickup(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return await this.workspaceService.markOrderReadyForPickup(
      req.user.sub,
      orderId,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/confirm-self-pickup')
  async confirmSelfPickupWithPin(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body: { deliveryPin: string },
  ) {
    return await this.workspaceService.confirmSelfPickupWithPin(
      req.user.sub,
      orderId,
      body.deliveryPin,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/confirm-pickup')
  async confirmPickupWithPin(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body: { pickupPin: string },
  ) {
    return await this.workspaceService.confirmPickupWithPin(
      req.user.sub,
      orderId,
      body.pickupPin,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/pickup')
  async confirmPickup(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    return await this.workspaceService.confirmPickup(
      req.user.sub,
      orderId,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/delivered')
  async markDelivered(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body: { deliveryPin: string },
  ) {
    return await this.workspaceService.markDelivered(
      req.user.sub,
      orderId,
      body.deliveryPin,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/complete-service')
  async completeServiceBooking(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body?: {
      completionNotes?: string;
    },
  ) {
    return await this.workspaceService.completeServiceBooking(
      req.user.sub,
      orderId,
      body?.completionNotes,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/release-escrow')
  async requestEscrowRelease(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body?: { reason?: string },
  ) {
    return await this.workspaceService.requestEscrowRelease(
      req.user.sub,
      orderId,
      body?.reason,
      req.supabaseToken,
    );
  }

  @Patch('orders/:id/prep-time')
  async updatePreparationTime(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body: { estimatedMinutes: number },
  ) {
    return await this.workspaceService.updatePreparationTime(
      req.user.sub,
      orderId,
      body.estimatedMinutes,
      req.supabaseToken,
    );
  }

  @Post('orders/:id/notes')
  async addOrderNotes(
    @Request() req,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body: { notes: string },
  ) {
    return await this.workspaceService.addOrderNotes(
      req.user.sub,
      orderId,
      body.notes,
      req.supabaseToken,
    );
  }

  @Get('orders/status/:status')
  async getOrdersByStatus(
    @Request() req,
    @Param('status') status: string,
  ) {
    return await this.workspaceService.getOrdersByStatus(
      req.user.sub,
      status,
      req.supabaseToken,
    );
  }
}