import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, Req, Patch } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  async getMyOrders(@Req() req, @Query() filters: any) {
    const userId = req.user.sub;
    return this.ordersService.getMyOrders(userId, filters);
  }

  @Get('stats')
  async getOrderStats(@Req() req) {
    const userId = req.user.sub;
    return this.ordersService.getOrderStats(userId);
  }

  @Get('search')
  async searchOrders(@Req() req, @Query('q') query: string) {
    const userId = req.user.sub;
    return this.ordersService.searchOrders(userId, query);
  }

  @Get(':id')
  async getOrderDetails(@Req() req, @Param('id') orderId: string) {
    const userId = req.user.sub;
    return this.ordersService.getOrderDetails(userId, orderId);
  }

  @Get(':id/tracking')
  async getOrderTracking(@Req() req, @Param('id') orderId: string) {
    const userId = req.user.sub;
    return this.ordersService.getOrderTracking(userId, orderId);
  }

  @Get(':id/invoice')
  async getOrderInvoice(@Req() req, @Param('id') orderId: string) {
    const userId = req.user.sub;
    return this.ordersService.getOrderInvoice(userId, orderId);
  }

  @Post(':id/cancel')
  async cancelOrder(@Req() req, @Param('id') orderId: string, @Body() body: { reason?: string }) {
    const userId = req.user.sub;
    return this.ordersService.cancelOrder(userId, orderId, body.reason);
  }

  @Post(':id/refund')
  async requestRefund(@Req() req, @Param('id') orderId: string, @Body() body: { reason: string }) {
    const userId = req.user.sub;
    return this.ordersService.requestRefund(userId, orderId, body.reason);
  }

  @Post(':id/items/:itemId/rate')
  async rateOrderItem(
    @Req() req, 
    @Param('id') orderId: string, 
    @Param('itemId') itemId: string,
    @Body() body: { rating: number; review?: string }
  ) {
    const userId = req.user.sub;
    return this.ordersService.rateOrderItem(userId, orderId, itemId, body.rating, body.review);
  }

  @Post(':id/report')
  async reportOrderIssue(@Req() req, @Param('id') orderId: string, @Body() issue: any) {
    const userId = req.user.sub;
    return this.ordersService.reportOrderIssue(userId, orderId, issue);
  }

  @Post(':id/reorder')
  async reorderItems(@Req() req, @Param('id') orderId: string, @Body() body: { itemIds?: string[] }) {
    const userId = req.user.sub;
    return this.ordersService.reorderItems(userId, orderId, body.itemIds);
  }

  // === NEW TRACKING ENDPOINTS ===

  @Get(':id/tracking-data')
  async getOrderTrackingData(@Req() req, @Param('id') orderId: string) {
    const userId = req.user.sub;
    return this.ordersService.getOrderTrackingData(userId, orderId);
  }

  @Patch(':id/status')
  async updateOrderStatus(
    @Req() req, 
    @Param('id') orderId: string, 
    @Body() body: { status: string }
  ) {
    const userId = req.user.sub;
    return this.ordersService.updateOrderStatus(userId, orderId, body.status);
  }

  @Post(':id/confirm-receipt')
  async confirmOrderReceipt(@Req() req, @Param('id') orderId: string) {
    const userId = req.user.sub;
    return this.ordersService.confirmOrderReceipt(userId, orderId);
  }

  @Post(':id/auto-release-escrow')
  async autoReleaseEscrow(@Req() req, @Param('id') orderId: string) {
    const userId = req.user.sub;
    return this.ordersService.autoReleaseEscrow(userId, orderId);
  }

  @Post(':id/update-location')
  async updateRiderLocation(
    @Req() req, 
    @Param('id') orderId: string,
    @Body() body: { 
      latitude: number; 
      longitude: number; 
      heading?: number;
      accuracy?: number;
    }
  ) {
    const userId = req.user.sub;
    return this.ordersService.updateRiderLocation(userId, orderId, body);
  }

  @Get(':id/real-time-updates')
  async getRealTimeUpdates(@Req() req, @Param('id') orderId: string) {
    const userId = req.user.sub;
    return this.ordersService.getRealTimeUpdates(userId, orderId);
  }
}