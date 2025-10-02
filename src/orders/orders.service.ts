import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { InvoiceService } from '../chat/invoice.service';

@Injectable()
export class OrdersService {
  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => InvoiceService))
    private invoiceService: InvoiceService
  ) {}

  async getMyOrders(userId: string, filters?: any) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    let query = supabase
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        total,
        subtotal,
        delivery_fee,
        tax,
        item_count,
        order_date,
        estimated_delivery,
        delivery_address,
        order_items (
          id,
          product_id,
          service_id,
          name,
          image,
          price,
          original_price,
          quantity,
          seller_id,
          seller_name,
          category,
          is_service,
          service_date,
          service_time
        )
      `)
      .eq('user_id', userId)
      .order('order_date', { ascending: false });

    // Apply filters
    if (filters?.status?.length) {
      query = query.in('status', filters.status.split(','));
    }
    if (filters?.startDate) {
      query = query.gte('order_date', filters.startDate);
    }
    if (filters?.endDate) {
      query = query.lte('order_date', filters.endDate);
    }
    if (filters?.minAmount) {
      query = query.gte('total', parseInt(filters.minAmount));
    }
    if (filters?.maxAmount) {
      query = query.lte('total', parseInt(filters.maxAmount));
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch orders: ${error.message}`);
    }

    // Transform data to match frontend interface
    return data.map(order => ({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      total: order.total,
      subtotal: order.subtotal,
      deliveryFee: order.delivery_fee,
      tax: order.tax,
      itemCount: order.item_count,
      orderDate: order.order_date,
      estimatedDelivery: order.estimated_delivery,
      deliveryAddress: order.delivery_address,
      items: order.order_items.map(item => ({
        id: item.id,
        productId: item.product_id,
        serviceId: item.service_id,
        name: item.name,
        image: item.image,
        price: item.price,
        originalPrice: item.original_price,
        quantity: item.quantity,
        sellerId: item.seller_id,
        sellerName: item.seller_name,
        category: item.category,
        isService: item.is_service,
        serviceDate: item.service_date,
        serviceTime: item.service_time
      }))
    }));
  }

  async getOrderDetails(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        total,
        subtotal,
        delivery_fee,
        tax,
        item_count,
        order_date,
        estimated_delivery,
        delivery_address,
        payment_method,
        payment_status,
        tracking_number,
        notes,
        order_items (
          id,
          product_id,
          service_id,
          name,
          image,
          price,
          original_price,
          quantity,
          seller_id,
          seller_name,
          category,
          is_service,
          service_date,
          service_time
        )
      `)
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error) {
      throw new Error(`Failed to fetch order details: ${error.message}`);
    }

    // Transform data to match frontend interface
    return {
      id: data.id,
      orderNumber: data.order_number,
      status: data.status,
      total: data.total,
      subtotal: data.subtotal,
      deliveryFee: data.delivery_fee,
      tax: data.tax,
      itemCount: data.item_count,
      orderDate: data.order_date,
      estimatedDelivery: data.estimated_delivery,
      deliveryAddress: data.delivery_address,
      paymentMethod: data.payment_method,
      paymentStatus: data.payment_status,
      trackingNumber: data.tracking_number,
      notes: data.notes,
      items: data.order_items.map(item => ({
        id: item.id,
        productId: item.product_id,
        serviceId: item.service_id,
        name: item.name,
        image: item.image,
        price: item.price,
        originalPrice: item.original_price,
        quantity: item.quantity,
        sellerId: item.seller_id,
        sellerName: item.seller_name,
        category: item.category,
        isService: item.is_service,
        serviceDate: item.service_date,
        serviceTime: item.service_time
      }))
    };
  }

  async getOrderTracking(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    // First verify the order belongs to the user
    const { data: order } = await supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (!order) {
      throw new Error('Order not found or access denied');
    }

    const { data, error } = await supabase
      .from('order_tracking')
      .select('*')
      .eq('order_id', orderId)
      .order('timestamp', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch tracking information: ${error.message}`);
    }

    return data.map(event => ({
      id: event.id,
      status: event.status,
      description: event.description,
      timestamp: event.timestamp,
      location: event.location,
      isCompleted: event.is_completed
    }));
  }

  async getOrderStats(userId: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { data, error } = await supabase
      .from('orders')
      .select('status, total')
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to fetch order stats: ${error.message}`);
    }

    const stats = {
      totalOrders: data.length,
      completedOrders: data.filter(o => o.status === 'delivered').length,
      pendingOrders: data.filter(o => ['pending', 'processing', 'shipped', 'out_for_delivery'].includes(o.status)).length,
      cancelledOrders: data.filter(o => o.status === 'cancelled').length,
      totalSpent: data.reduce((sum, o) => sum + (o.total || 0), 0)
    };

    return stats;
  }

  async searchOrders(userId: string, query: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        total,
        subtotal,
        delivery_fee,
        tax,
        item_count,
        order_date,
        estimated_delivery,
        delivery_address,
        order_items (
          id,
          product_id,
          service_id,
          name,
          image,
          price,
          original_price,
          quantity,
          seller_id,
          seller_name,
          category,
          is_service,
          service_date,
          service_time
        )
      `)
      .eq('user_id', userId)
      .or(`order_number.ilike.%${query}%,order_items.name.ilike.%${query}%`)
      .order('order_date', { ascending: false });

    if (error) {
      throw new Error(`Failed to search orders: ${error.message}`);
    }

    return data.map(order => ({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      total: order.total,
      subtotal: order.subtotal,
      deliveryFee: order.delivery_fee,
      tax: order.tax,
      itemCount: order.item_count,
      orderDate: order.order_date,
      estimatedDelivery: order.estimated_delivery,
      deliveryAddress: order.delivery_address,
      items: order.order_items.map(item => ({
        id: item.id,
        productId: item.product_id,
        serviceId: item.service_id,
        name: item.name,
        image: item.image,
        price: item.price,
        originalPrice: item.original_price,
        quantity: item.quantity,
        sellerId: item.seller_id,
        sellerName: item.seller_name,
        category: item.category,
        isService: item.is_service,
        serviceDate: item.service_date,
        serviceTime: item.service_time
      }))
    }));
  }

  async cancelOrder(userId: string, orderId: string, reason?: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { error } = await supabase
      .from('orders')
      .update({ 
        status: 'cancelled',
        notes: reason || 'Cancelled by user'
      })
      .eq('id', orderId)
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to cancel order: ${error.message}`);
    }
  }

  async requestRefund(userId: string, orderId: string, reason: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { error } = await supabase
      .from('refund_requests')
      .insert({
        order_id: orderId,
        user_id: userId,
        reason,
        status: 'pending',
        created_at: new Date().toISOString()
      });

    if (error) {
      throw new Error(`Failed to request refund: ${error.message}`);
    }
  }

  async rateOrderItem(userId: string, orderId: string, itemId: string, rating: number, review?: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { error } = await supabase
      .from('order_item_ratings')
      .insert({
        order_id: orderId,
        order_item_id: itemId,
        user_id: userId,
        rating,
        review: review || null,
        created_at: new Date().toISOString()
      });

    if (error) {
      throw new Error(`Failed to rate order item: ${error.message}`);
    }
  }

  async reportOrderIssue(userId: string, orderId: string, issue: any) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { error } = await supabase
      .from('order_issues')
      .insert({
        order_id: orderId,
        user_id: userId,
        issue_type: issue.type,
        description: issue.description,
        images: issue.images || [],
        status: 'open',
        created_at: new Date().toISOString()
      });

    if (error) {
      throw new Error(`Failed to report order issue: ${error.message}`);
    }
  }

  async reorderItems(userId: string, orderId: string, itemIds?: string[]) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    // Get order items
    let query = supabase
      .from('order_items')
      .select('*')
      .eq('order_id', orderId);
      
    if (itemIds && itemIds.length > 0) {
      query = query.in('id', itemIds);
    }

    const { data: items, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch order items for reorder: ${error.message}`);
    }

    // Add items to cart
    const cartItems = items.map(item => ({
      user_id: userId,
      product_id: item.product_id,
      service_id: item.service_id,
      quantity: item.quantity,
      service_date: item.service_date,
      service_time: item.service_time,
      created_at: new Date().toISOString()
    }));

    const { error: cartError } = await supabase
      .from('cart_items')
      .insert(cartItems);

    if (cartError) {
      throw new Error(`Failed to add items to cart: ${cartError.message}`);
    }

    return {
      cartId: 'user_cart', // In a real app, you might have cart IDs
      addedItems: items.length,
      failedItems: []
    };
  }

  async getOrderInvoice(userId: string, orderId: string) {
    // In a real implementation, you would generate/fetch invoice from storage
    return {
      invoiceUrl: `https://invoices.fretiko.com/${orderId}.pdf`,
      invoiceNumber: `INV-${orderId.slice(0, 8).toUpperCase()}`
    };
  }

  // === NEW TRACKING SERVICE METHODS ===

  async getOrderTrackingData(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    // Get order with rider info
    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        *,
        rider_locations!orders_rider_id_fkey (
          latitude,
          longitude,
          last_ping,
          accuracy
        ),
        user_profiles!orders_seller_id_fkey (
          username,
          location
        )
      `)
      .eq('id', orderId)
      .or(`buyer_id.eq.${userId},seller_id.eq.${userId},rider_id.eq.${userId}`)
      .single();

    if (error) {
      throw new Error(`Failed to get tracking data: ${error.message}`);
    }

    if (!order) {
      throw new Error('Order not found or access denied');
    }

    // Determine current phase and calculate timers
    const currentPhase = this.calculateCurrentPhase(order);
    const timerInfo = this.calculateTimerInfo(order, currentPhase);
    const escrowInfo = this.calculateEscrowInfo(order);

    // Mock locations for now - in production these would come from database
    const vendorLocation = {
      latitude: 6.5200,
      longitude: 3.3750,
      address: order.pickup_address || "Vendor Location, Lagos"
    };

    const buyerLocation = {
      latitude: 6.5300,
      longitude: 3.3850,
      address: order.delivery_address?.address || "Delivery Address"
    };

    let riderLocation: any = null;
    if (order.rider_locations && order.rider_locations.length > 0) {
      const location = order.rider_locations[0];
      riderLocation = {
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: location.last_ping,
        accuracy: location.accuracy
      };
    } else if (currentPhase.phase === 'rider') {
      // Mock rider location if not found
      riderLocation = {
        latitude: 6.5244,
        longitude: 3.3792,
        timestamp: new Date().toISOString()
      };
    }

    // Get rider info
    let riderInfo: any = null;
    if (order.rider_id) {
      const { data: rider } = await supabase
        .from('user_profiles')
        .select('username, avatar_url, preferences')
        .eq('id', order.rider_id)
        .single();

      if (rider) {
        riderInfo = {
          riderId: order.rider_id,
          riderName: rider.username || 'Delivery Rider',
          vehicleType: rider.preferences?.vehicleType || 'bike',
          phone: '+234 XXX XXX XXXX', // Would be from rider profile
          avatar: rider.avatar_url
        };
      }
    }

    return {
      currentPhase,
      timerInfo,
      riderLocation,
      vendorLocation,
      buyerLocation,
      riderInfo,
      escrowInfo
    };
  }

  async updateOrderStatus(userId: string, orderId: string, status: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    // Verify user can update this order
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('buyer_id, seller_id, rider_id, status as current_status')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      throw new Error('Order not found');
    }

    // Check permissions based on status transition
    const canUpdate = this.canUserUpdateStatus(userId, order, status);
    if (!canUpdate) {
      throw new Error('Unauthorized to update this order status');
    }

    // Update order status
    const updateData: any = {
      status,
      updated_at: new Date().toISOString()
    };

    // Special handling for specific status updates
    if (status === 'ready_for_pickup') {
      updateData.ready_for_pickup_at = new Date().toISOString();
    } else if (status === 'picked_up') {
      updateData.picked_up_at = new Date().toISOString();
    } else if (status === 'delivered') {
      updateData.delivered_at = new Date().toISOString();
      updateData.escrow_release_at = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // 6 hours
    }

    const { error } = await supabase
      .from('orders')
      .update(updateData)
      .eq('id', orderId);

    if (error) {
      throw new Error(`Failed to update order status: ${error.message}`);
    }

    // Create tracking event
    await this.createTrackingEvent(orderId, status, this.getStatusDescription(status));

    // Send notifications based on status change
    await this.sendOrderStatusNotifications(orderId, status, order);

    return { success: true };
  }

  async confirmOrderReceipt(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);

    // Verify this is the buyer
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('buyer_id, total, seller_id, escrow_fee, source, metadata')
      .eq('id', orderId)
      .eq('buyer_id', userId)
      .single();

    if (fetchError || !order) {
      throw new Error('Order not found or access denied');
    }

    // Release escrow funds
    await this.releaseEscrowFunds(orderId, order.seller_id, order.total);

    // Update order status
    const { error } = await supabase
      .from('orders')
      .update({
        status: 'completed',
        order_confirmed_at: new Date().toISOString(),
        escrow_released_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (error) {
      throw new Error(`Failed to confirm order receipt: ${error.message}`);
    }

    // Create tracking event
    await this.createTrackingEvent(orderId, 'completed', 'Order confirmed by buyer, funds released');

    // Mark invoice as paid if this order came from an invoice
    if (order.source === 'invoice' && order.metadata?.invoiceId) {
      try {
        await this.invoiceService.markInvoiceAsPaid(order.metadata.invoiceId, orderId);
      } catch (error) {
        console.error('Failed to mark invoice as paid:', error);
        // Don't throw - invoice marking is not critical to order completion
      }
    }

    return { success: true, message: 'Order confirmed and funds released' };
  }

  async autoReleaseEscrow(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      throw new Error('Order not found');
    }

    // Check if auto-release is due
    const releaseTime = new Date(order.escrow_release_at);
    const now = new Date();
    
    if (now < releaseTime) {
      throw new Error('Auto-release time not yet reached');
    }

    // Release funds
    await this.releaseEscrowFunds(orderId, order.seller_id, order.total);

    const { error } = await supabase
      .from('orders')
      .update({
        status: 'completed',
        escrow_released_at: new Date().toISOString(),
        auto_released: true
      })
      .eq('id', orderId);

    if (error) {
      throw new Error(`Failed to auto-release escrow: ${error.message}`);
    }

    await this.createTrackingEvent(orderId, 'auto_completed', 'Funds automatically released after timeout');

    // Mark invoice as paid if this order came from an invoice
    if (order.source === 'invoice' && order.metadata?.invoiceId) {
      try {
        await this.invoiceService.markInvoiceAsPaid(order.metadata.invoiceId, orderId);
      } catch (error) {
        console.error('Failed to mark invoice as paid:', error);
        // Don't throw - invoice marking is not critical to order completion
      }
    }

    return { success: true, message: 'Escrow funds automatically released' };
  }

  async updateRiderLocation(userId: string, orderId: string, locationData: any) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    // Verify this is the assigned rider
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('rider_id')
      .eq('id', orderId)
      .eq('rider_id', userId)
      .single();

    if (fetchError || !order) {
      throw new Error('Order not found or access denied');
    }

    // Update or insert rider location
    const { error } = await supabase
      .from('rider_locations')
      .upsert({
        user_id: userId,
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        accuracy: locationData.accuracy,
        last_ping: new Date().toISOString(),
        is_online: true,
        current_order_id: orderId
      });

    if (error) {
      throw new Error(`Failed to update rider location: ${error.message}`);
    }

    return { success: true };
  }

  async getRealTimeUpdates(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    // Get latest order status and location
    const { data, error } = await supabase
      .from('orders')
      .select(`
        status,
        updated_at,
        rider_locations!orders_rider_id_fkey (
          latitude,
          longitude,
          last_ping
        )
      `)
      .eq('id', orderId)
      .or(`buyer_id.eq.${userId},seller_id.eq.${userId},rider_id.eq.${userId}`)
      .single();

    if (error) {
      throw new Error(`Failed to get real-time updates: ${error.message}`);
    }

    return {
      status: data.status,
      lastUpdate: data.updated_at,
      riderLocation: data.rider_locations?.[0] || null
    };
  }

  // === HELPER METHODS ===

  private calculateCurrentPhase(order: any) {
    const status = order.status;
    
    if (['pending', 'confirmed', 'processing'].includes(status)) {
      return { phase: 'vendor', status: 'active' };
    } else if (['assigned', 'ready_for_pickup', 'picked_up', 'in_transit', 'out_for_delivery'].includes(status)) {
      return { phase: 'rider', status: 'active' };
    } else if (status === 'delivered') {
      return { phase: 'buyer', status: 'active' };
    } else {
      return { phase: 'completed', status: 'completed' };
    }
  }

  private calculateTimerInfo(order: any, currentPhase: any) {
    const now = new Date();
    let estimatedDuration = 30 * 60; // 30 minutes default
    let startTime = new Date(order.created_at);

    // Adjust based on phase and order type
    if (currentPhase.phase === 'vendor') {
      // Use promised delivery time from order
      estimatedDuration = order.estimated_duration_minutes * 60 || 60 * 60; // 1 hour default
    } else if (currentPhase.phase === 'rider') {
      startTime = new Date(order.ready_for_pickup_at || order.created_at);
      estimatedDuration = 30 * 60; // 30 minutes for delivery
    } else if (currentPhase.phase === 'buyer') {
      startTime = new Date(order.delivered_at);
      estimatedDuration = 6 * 60 * 60; // 6 hours for confirmation
    }

    const elapsed = (now.getTime() - startTime.getTime()) / 1000;
    const remaining = Math.max(0, estimatedDuration - elapsed);
    const isOverdue = remaining === 0;

    return {
      timeRemaining: Math.floor(remaining),
      totalTime: estimatedDuration,
      isOverdue,
      overdueBy: isOverdue ? Math.floor(elapsed - estimatedDuration) : 0
    };
  }

  private calculateEscrowInfo(order: any) {
    const now = new Date();
    let autoReleaseTime = null;
    
    if (order.escrow_release_at) {
      autoReleaseTime = order.escrow_release_at;
    }

    return {
      status: order.escrow_released_at ? 'released' : 'held',
      autoReleaseTime,
      canRelease: order.status === 'delivered' && !order.escrow_released_at
    };
  }

  private canUserUpdateStatus(userId: string, order: any, newStatus: string): boolean {
    // Vendor can update to processing/ready_for_pickup
    if (order.seller_id === userId && ['processing', 'ready_for_pickup'].includes(newStatus)) {
      return true;
    }

    // Rider can update to picked_up/delivered
    if (order.rider_id === userId && ['picked_up', 'in_transit', 'delivered'].includes(newStatus)) {
      return true;
    }

    // Buyer can confirm receipt
    if (order.buyer_id === userId && newStatus === 'completed') {
      return true;
    }

    return false;
  }

  private async createTrackingEvent(orderId: string, status: string, description: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    await supabase
      .from('order_tracking_events')
      .insert({
        order_id: orderId,
        status,
        description,
        timestamp: new Date().toISOString(),
        is_completed: true
      });
  }

  private getStatusDescription(status: string): string {
    const descriptions = {
      'processing': 'Vendor is preparing your order',
      'ready_for_pickup': 'Order is ready for pickup',
      'picked_up': 'Order has been picked up by rider',
      'in_transit': 'Order is on the way to you',
      'delivered': 'Order has been delivered',
      'completed': 'Order confirmed by buyer'
    };
    return descriptions[status] || `Order status updated to ${status}`;
  }

  private async releaseEscrowFunds(orderId: string, sellerId: string, amount: number) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    // In a real implementation, this would:
    // 1. Move funds from escrow to seller's wallet
    // 2. Update transaction records
    // 3. Send notifications
    
    console.log(`🏦 Releasing ₣${amount} from escrow to seller ${sellerId} for order ${orderId}`);
    
    // For now, just log the transaction
    await supabase
      .from('wallet_transactions')
      .insert({
        user_id: sellerId,
        amount,
        type: 'escrow_release',
        description: `Funds released for order ${orderId}`,
        order_id: orderId,
        status: 'completed',
        created_at: new Date().toISOString()
      });
  }

  /**
   * Send notifications based on order status changes
   */
  private async sendOrderStatusNotifications(orderId: string, status: string, orderData: any): Promise<void> {
    try {
      const supabase = createServiceSupabaseClient(this.configService);
      
      // Get full order details for notifications
      const { data: fullOrder, error } = await supabase
        .from('orders')
        .select(`
          id,
          order_number,
          total,
          buyer_id,
          seller_id,
          rider_id,
          tracking_number,
          estimated_delivery,
          user_profiles!orders_buyer_id_fkey (username, avatar_url),
          seller_profile:user_profiles!orders_seller_id_fkey (username, avatar_url),
          rider_profile:user_profiles!orders_rider_id_fkey (username, avatar_url)
        `)
        .eq('id', orderId)
        .single();

      if (error || !fullOrder) {
        console.error('Failed to fetch order details for notifications:', error);
        return;
      }

      // Prepare order data for notifications
      const orderForNotification = {
        id: fullOrder.id,
        order_number: fullOrder.order_number,
        total_amount: fullOrder.total
      };

      // Send notifications based on status
      switch (status) {
        case 'confirmed':
        case 'processing':
          // Notify buyer that order is confirmed/being processed
          if (fullOrder.buyer_id) {
            await this.notificationHelper.notifyOrderCreated(fullOrder.buyer_id, orderForNotification);
          }
          break;

        case 'ready_for_pickup':
          // Notify rider that order is ready for pickup
          if (fullOrder.rider_id) {
            await this.notificationHelper.notifyRiderOnTheWay(fullOrder.buyer_id, {
              id: fullOrder.rider_id,
              name: (fullOrder.rider_profile as any)?.username || 'Your rider',
              avatar_url: (fullOrder.rider_profile as any)?.avatar_url,
              estimated_arrival_mins: '15-20'
            }, orderForNotification);
          }
          break;

        case 'picked_up':
        case 'out_for_delivery':
          // Notify buyer that order is on the way
          if (fullOrder.rider_id && fullOrder.buyer_id) {
            await this.notificationHelper.notifyRiderOnTheWay(fullOrder.buyer_id, {
              id: fullOrder.rider_id,
              name: (fullOrder.rider_profile as any)?.username || 'Your rider',
              avatar_url: (fullOrder.rider_profile as any)?.avatar_url,
              estimated_arrival_mins: '10-15'
            }, orderForNotification);
          }
          break;

        case 'shipped':
          // Notify buyer that order has been shipped
          if (fullOrder.buyer_id) {
            const trackingData = fullOrder.tracking_number ? {
              tracking_number: fullOrder.tracking_number,
              estimated_delivery: fullOrder.estimated_delivery
            } : undefined;
            
            await this.notificationHelper.notifyOrderShipped(fullOrder.buyer_id, orderForNotification, trackingData);
          }
          break;

        case 'delivered':
          // Notify buyer that order has been delivered
          if (fullOrder.buyer_id) {
            await this.notificationHelper.notifyOrderDelivered(fullOrder.buyer_id, orderForNotification);
          }
          break;

        case 'cancelled':
          // Could add cancellation notifications here
          console.log(`Order ${orderId} was cancelled - notifications could be sent here`);
          break;

        default:
          console.log(`Order status changed to ${status} - no specific notifications configured`);
      }

    } catch (error) {
      console.error('Error sending order status notifications:', error);
      // Don't throw - notifications shouldn't break the main order flow
    }
  }
}