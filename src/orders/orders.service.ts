import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { InvoiceService } from '../chat/invoice.service';
import { ConnectionsService } from '../connections/connections.service';
import { EscrowService } from '../escrow/escrow.service';
import { RewardsService } from '../rewards/rewards.service';

@Injectable()
export class OrdersService {
  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => InvoiceService))
    private invoiceService: InvoiceService,
    @Inject(forwardRef(() => ConnectionsService))
    private connectionsService: ConnectionsService,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
    @Inject(forwardRef(() => RewardsService))
    private rewardsService: RewardsService
  ) {}

  async getMyOrders(userId: string, filters?: any) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    let query = supabase
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        total_amount,
        delivery_fee,
        platform_fee,
        estimated_delivery,
        delivery_address,
        metadata,
        created_at,
        buyer_id,
        vendor_id,
        rider_id,
        escrow_enabled,
        delivery_type,
        rider_info,
        source,
        order_items (
          id,
          product_id,
          product_name,
          unit_price,
          quantity,
          total_price,
          product_metadata
        )
      `)
      .eq('buyer_id', userId)
      .order('created_at', { ascending: false });

    // Apply filters
    if (filters?.status?.length) {
      query = query.in('status', filters.status.split(','));
    }
    if (filters?.startDate) {
      query = query.gte('created_at', filters.startDate);
    }
    if (filters?.endDate) {
      query = query.lte('created_at', filters.endDate);
    }
    if (filters?.minAmount) {
      query = query.gte('total_amount', parseInt(filters.minAmount));
    }
    if (filters?.maxAmount) {
      query = query.lte('total_amount', parseInt(filters.maxAmount));
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
      total: order.total_amount,
      subtotal: order.metadata?.subtotal || order.total_amount - order.delivery_fee,
      deliveryFee: order.delivery_fee,
      tax: order.metadata?.tax_amount || 0,
      platformFee: order.platform_fee,
      escrowFee: order.metadata?.escrow_fee || 0,
      itemCount: order.order_items?.length || 0,
      orderDate: order.created_at,
      estimatedDelivery: order.estimated_delivery,
      deliveryAddress: order.delivery_address,
      escrowEnabled: order.escrow_enabled,
      deliveryType: order.delivery_type,
      riderInfo: order.rider_info,
      source: order.source,
      buyerId: order.buyer_id,
      vendorId: order.vendor_id,
      riderId: order.rider_id,
      items: order.order_items.map(item => ({
        id: item.id,
        productId: item.product_id,
        name: item.product_name,
        price: item.unit_price,
        quantity: item.quantity,
        totalPrice: item.total_price,
        metadata: item.product_metadata,
      }))
    }));
  }

  async getOrderDetails(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);
    
    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (
          id,
          product_id,
          product_name,
          unit_price,
          quantity,
          total_price,
          product_metadata
        )
      `)
      .eq('id', orderId)
      .eq('buyer_id', userId)
      .single();

    if (error) {
      throw new Error(`Failed to fetch order details: ${error.message}`);
    }

    // Transform data to match frontend interface
    return {
      id: data.id,
      orderNumber: data.order_number,
      status: data.status,
      total: data.total_amount,
      subtotal: data.metadata?.subtotal || data.total_amount - data.delivery_fee,
      deliveryFee: data.delivery_fee,
      platformFee: data.platform_fee,
      tax: data.metadata?.tax_amount || 0,
      escrowFee: data.metadata?.escrow_fee || 0,
      itemCount: data.order_items?.length || 0,
      orderDate: data.created_at,
      estimatedDelivery: data.estimated_delivery,
      deliveryAddress: data.delivery_address,
      deliveryInstructions: data.delivery_instructions,
      deliveryType: data.delivery_type,
      riderInfo: data.rider_info,
      escrowEnabled: data.escrow_enabled,
      source: data.source,
      buyerId: data.buyer_id,
      vendorId: data.vendor_id,
      riderId: data.rider_id,
      metadata: data.metadata,
      items: data.order_items.map(item => ({
        id: item.id,
        productId: item.product_id,
        name: item.product_name,
        price: item.unit_price,
        quantity: item.quantity,
        totalPrice: item.total_price,
        metadata: item.product_metadata,
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
      .eq('buyer_id', userId)
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

    // 1) Verify buyer owns order and status is cancellable
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('id, buyer_id, status')
      .eq('id', orderId)
      .eq('buyer_id', userId)
      .single();

    if (fetchError || !order) {
      throw new Error('Failed to cancel order: Order not found or access denied');
    }

    // Only allow cancel before vendor accepts/processing/delivered
    const nonCancellable = ['accepted', 'processing', 'ready_for_pickup', 'picked_up', 'delivered', 'completed'];
    if (nonCancellable.includes(order.status)) {
      throw new Error('Failed to cancel order: Order is already in progress or completed');
    }

    // 2) Refund escrow if exists and held
    const { data: escrow } = await supabase
      .from('escrows')
      .select('id, status')
      .eq('order_id', orderId)
      .single();

    if (escrow && escrow.status === 'held') {
      await this.escrowService.refundEscrow(escrow.id, reason || 'Buyer cancelled order');
    }

    // 3) Mark order cancelled
    const { error: updateError } = await supabase
      .from('orders')
      .update({ 
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId)
      .eq('buyer_id', userId);

    if (updateError) {
      throw new Error(`Failed to cancel order: ${updateError.message}`);
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
    
    try {
      // Get order data first (faster, simpler query)
      const { data: order, error: orderError } = await supabase
      .from('orders')
        .select('*')
      .eq('id', orderId)
        .or(`buyer_id.eq.${userId},vendor_id.eq.${userId},rider_id.eq.${userId}`)
      .single();

      if (orderError) {
        console.error('Order fetch error:', orderError);
        throw new Error(`Failed to get tracking data: ${orderError.message}`);
    }

    if (!order) {
      throw new Error('Order not found or access denied');
    }

      // Fetch profiles in parallel for better performance
      const [vendorProfile, buyerProfile, riderProfile, riderLocationData] = await Promise.all([
        // Vendor profile
        order.vendor_id
          ? (async () => {
              try {
                const { data } = await supabase
                  .from('user_profiles')
                  .select('id, username, avatar_url, location, phone')
                  .eq('id', order.vendor_id)
                  .single();
                return data;
              } catch {
                return null;
              }
            })()
          : Promise.resolve(null),
        
        // Buyer profile
        order.buyer_id
          ? (async () => {
              try {
                const { data } = await supabase
                  .from('user_profiles')
                  .select('id, username, avatar_url, location, phone')
                  .eq('id', order.buyer_id)
                  .single();
                return data;
              } catch {
                return null;
              }
            })()
          : Promise.resolve(null),
        
        // Rider profile
        order.rider_id
          ? (async () => {
              try {
                const { data } = await supabase
                  .from('user_profiles')
                  .select('id, username, avatar_url, phone, preferences')
                  .eq('id', order.rider_id)
                  .single();
                return data;
              } catch {
                return null;
              }
            })()
          : Promise.resolve(null),
        
        // Rider location
        order.rider_id
          ? (async () => {
              try {
                const { data } = await supabase
                  .from('rider_locations')
                  .select('latitude, longitude, last_ping, accuracy, is_online')
                  .eq('user_id', order.rider_id)
                  .single();
                return data;
              } catch {
                return null;
              }
            })()
          : Promise.resolve(null),
      ]);

      // Attach profiles to order object
      order.vendor_profile = vendorProfile;
      order.buyer_profile = buyerProfile;
      order.rider_profile = riderProfile;

    // Determine current phase and calculate timers
    const currentPhase = this.calculateCurrentPhase(order);
    const timerInfo = this.calculateTimerInfo(order, currentPhase);
    const escrowInfo = this.calculateEscrowInfo(order);

      // Get vendor location from profile or use mock
    const vendorLocation = {
        latitude: vendorProfile?.location?.latitude || 6.5200,
        longitude: vendorProfile?.location?.longitude || 3.3750,
        address: vendorProfile?.location?.address || "Vendor Location, Lagos"
      };

      // Get buyer location from delivery address or profile
    const buyerLocation = {
        latitude: order.delivery_address?.latitude || buyerProfile?.location?.latitude || 6.5300,
        longitude: order.delivery_address?.longitude || buyerProfile?.location?.longitude || 3.3850,
      address: order.delivery_address?.address || "Delivery Address"
    };

      // Use fetched rider location data
    let riderLocation: any = null;
      if (riderLocationData) {
      riderLocation = {
          latitude: riderLocationData.latitude,
          longitude: riderLocationData.longitude,
          timestamp: riderLocationData.last_ping,
          accuracy: riderLocationData.accuracy,
          isOnline: riderLocationData.is_online
        };
      } else if (currentPhase.phase === 'rider' && order.rider_id) {
        // Mock rider location if not found but rider assigned
      riderLocation = {
        latitude: 6.5244,
        longitude: 3.3792,
          timestamp: new Date().toISOString(),
          isOnline: false
      };
    }

      // Build rider info from fetched profile
    let riderInfo: any = null;
      if (order.rider_id && riderProfile) {
        riderInfo = {
          riderId: order.rider_id,
          riderName: riderProfile.username || 'Delivery Rider',
          vehicleType: riderProfile.preferences?.vehicleType || 'bike',
          phone: riderProfile.phone || 'Not available',
          avatar: riderProfile.avatar_url
        };
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
    } catch (error) {
      console.error('Error in getOrderTrackingData:', error);
      throw error;
    }
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

  /**
   * Calculate category-based escrow countdown
   * Returns countdown in milliseconds based on order categories
   */
  private getCategoryBasedCountdown(categories: string[]): { 
    countdownMs: number; 
    countdownHours: number; 
    primaryCategory: string 
  } {
    // Category-based countdown rules (in hours)
    const categoryTimers: { [key: string]: number } = {
      // Perishables - shortest countdown (3 hours)
      'Food & Beverages': 3,
      'Fresh Produce': 3,
      'Bakery': 3,
      'Fast Food': 3,
      'Restaurant': 3,
      'Catering': 3,
      
      // Semi-perishables (6 hours)
      'Flowers': 6,
      'Plants': 6,
      'Perishables': 6,
      
      // Regular products (24 hours - default)
      'Health & Personal Care': 24,
      'Clothing & Apparel': 24,
      'Home & Garden': 24,
      'Books & Media': 24,
      'Toys & Games': 24,
      'Sports & Outdoors': 24,
      'Beauty & Cosmetics': 24,
      'General': 24,
      
      // Services (48 hours - more time to verify quality)
      'Services': 48,
      'Professional Services': 48,
      'Home Services': 48,
      'Beauty Services': 48,
      'Repair Services': 48,
      
      // High-value items (72 hours - inspection/authentication time)
      'Electronics': 72,
      'Computers & Accessories': 72,
      'Jewelry & Watches': 72,
      'Luxury Goods': 72,
      'Vehicles & Parts': 72,
      'Furniture': 72,
      'Appliances': 72,
    };

    // Find shortest countdown (most restrictive) - protects buyer for perishables
    let shortestHours = 24; // Default 24 hours
    let primaryCategory = 'General';

    for (const category of categories) {
      const hours = categoryTimers[category];
      if (hours && hours < shortestHours) {
        shortestHours = hours;
        primaryCategory = category;
      }
    }

    const countdownMs = shortestHours * 60 * 60 * 1000;
    
    console.log(`📊 Category-based countdown: ${shortestHours}h (Primary: ${primaryCategory})`);
    
    return {
      countdownMs,
      countdownHours: shortestHours,
      primaryCategory,
    };
  }

  async confirmOrderReceipt(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);

    // Verify this is the buyer
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('id, buyer_id, vendor_id, total_amount, source, metadata, status')
      .eq('id', orderId)
      .eq('buyer_id', userId)
      .single();

    if (fetchError || !order) {
      throw new Error('Order not found or access denied');
    }

    // Check if order can be confirmed
    if (order.status !== 'delivered') {
      throw new Error('Order must be delivered before confirmation');
    }

    // ✅ FETCH ORDER ITEMS WITH CATEGORIES
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('category')
      .eq('order_id', orderId);

    const categories = orderItems?.map(item => item.category).filter(Boolean) || ['General'];

    // ✅ CALCULATE CATEGORY-BASED COUNTDOWN
    const { countdownMs, countdownHours, primaryCategory } = this.getCategoryBasedCountdown(categories);

    // ✅ IMMEDIATELY RELEASE ESCROW (buyer confirmed = instant release)
    console.log(`💰 Releasing escrow for order ${orderId} to vendor ${order.vendor_id}`);
    
    // Find the escrow record for this order
    const { data: escrow, error: escrowFetchError } = await supabase
      .from('escrows')
      .select('id, status, total_amount, vendor_amount, rider_amount')
      .eq('order_id', orderId)
      .single();

    if (escrowFetchError || !escrow) {
      console.error(`❌ CRITICAL: No escrow found for order ${orderId}`);
      console.error(`   This order has ₣${order.total_amount} that should be in escrow!`);
      console.error(`   Error:`, escrowFetchError);
      throw new Error('Escrow not found for this order');
    }

    console.log(`🔍 Found escrow for order:`, {
      escrowId: escrow.id,
      status: escrow.status,
      totalAmount: escrow.total_amount,
      vendorAmount: escrow.vendor_amount,
      riderAmount: escrow.rider_amount
    });

    // Check if already released
    if (escrow.status === 'released') {
      console.log(`ℹ️ Escrow already released - order was previously confirmed`);
    } else if (escrow.status === 'held') {
      // ✅ USE ESCROW SERVICE TO PROPERLY RELEASE FUNDS
      try {
        await this.escrowService.releaseEscrow(escrow.id, 'Buyer confirmed order receipt');
        console.log(`✅ Escrow ${escrow.id} released successfully via EscrowService`);
      } catch (releaseError) {
        console.error('❌ Failed to release escrow:', releaseError);
        throw new Error('Failed to release escrow funds');
      }
    } else {
      console.warn(`⚠️ Escrow has unexpected status: ${escrow.status}`);
    }

    // ✅ UPDATE ORDER STATUS TO COMPLETED
    const { error } = await supabase
      .from('orders')
      .update({
        status: 'completed',
        order_confirmed_at: new Date().toISOString(),
        escrow_released_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (error) {
      throw new Error(`Failed to confirm order receipt: ${error.message}`);
    }

    console.log(`✅ Order ${orderId} marked as completed with immediate escrow release`);

    // Update service_bookings status if this is a service booking
    if (order.source === 'service_booking') {
      try {
        await supabase
          .from('service_bookings')
          .update({
            status: 'completed',
            updated_at: new Date().toISOString(),
          })
          .eq('order_id', orderId);
        console.log(`✅ Service booking updated to completed`);
      } catch (bookingError) {
        console.error('Failed to update service_bookings (non-critical):', bookingError);
      }
    }

    // Create tracking event
    await this.createTrackingEvent(orderId, 'completed', 'Order confirmed by buyer. Funds will be released in 24 hours.');

    // Update client relationship - buyer is now a client of the vendor
    try {
      await this.connectionsService.createClientRelationship(order.vendor_id, {
        clientId: userId,
        relationshipType: 'customer',
        totalOrders: 1,
        totalSpent: order.total_amount,
      });
      console.log(`✅ Updated client relationship for vendor ${order.vendor_id} and buyer ${userId}`);
    } catch (error) {
      console.error('⚠️ Failed to update client relationship:', error);
      // Don't throw - client relationship update is not critical
    }

    // Mark invoice as paid if this order came from an invoice
    if (order.source === 'invoice' && order.metadata?.invoiceId) {
      try {
        await this.invoiceService.markInvoiceAsPaid(order.metadata.invoiceId, orderId);
      } catch (error) {
        console.error('Failed to mark invoice as paid:', error);
        // Don't throw - invoice marking is not critical to order completion
      }
    }

    return { 
      success: true, 
      message: 'Order confirmed! Payment will be released to the vendor in 24 hours (7-day dispute window).' 
    };
  }

  /**
   * Buyer manually releases escrow funds immediately (no 24-hour wait)
   */
  async confirmAndReleaseFunds(userId: string, orderId: string) {
    const supabase = createServiceSupabaseClient(this.configService);

    try {
      // Verify this is the buyer
      const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('id, order_number, buyer_id, vendor_id, rider_id, total_amount, status')
        .eq('id', orderId)
        .eq('buyer_id', userId)
        .single();

      if (fetchError || !order) {
        throw new Error('Order not found or access denied');
      }

      // Check if order is delivered
      if (order.status !== 'delivered') {
        throw new Error('Order must be delivered before releasing funds');
      }

      // Get escrow details
      const { data: escrow, error: escrowFetchError } = await supabase
        .from('escrows')
        .select('id, status')
        .eq('order_id', orderId)
        .eq('status', 'held')
        .single();

      if (escrowFetchError || !escrow) {
        throw new Error('Escrow not found or already released');
      }

      // Release escrow immediately
      await this.escrowService.releaseEscrow(
        escrow.id,
        'Buyer manually confirmed and released funds'
      );

      console.log(`✅ Buyer ${userId} manually released escrow for order ${orderId}`);

      // Create tracking event
      await this.createTrackingEvent(
        orderId,
        'completed',
        'Buyer confirmed receipt and released funds immediately'
      );

      return {
        success: true,
        message: 'Funds released successfully! Vendor and rider have been paid.',
      };
    } catch (error) {
      console.error('Error releasing funds:', error);
      throw error;
    }
  }

  /**
   * Buyer reports an issue with the order (stops escrow release, initiates refund)
   */
  async reportIssue(userId: string, orderId: string, reason: string, description?: string) {
    const supabase = createServiceSupabaseClient(this.configService);

    try {
      // Verify this is the buyer
      const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('id, order_number, buyer_id, vendor_id, rider_id, total_amount, delivery_fee, status')
        .eq('id', orderId)
        .eq('buyer_id', userId)
        .single();

      if (fetchError || !order) {
        throw new Error('Order not found or access denied');
      }

      // Check if order is delivered
      if (order.status !== 'delivered') {
        throw new Error('Can only report issues for delivered orders');
      }

      // Get escrow details
      const { data: escrow, error: escrowFetchError } = await supabase
        .from('escrows')
        .select('id, status, auto_release_at, vendor_amount, rider_amount')
        .eq('order_id', orderId)
        .eq('status', 'held')
        .single();

      if (escrowFetchError || !escrow) {
        throw new Error('Escrow not found or already released');
      }

      // Check if auto-release timer has expired
      if (escrow.auto_release_at) {
        const autoReleaseTime = new Date(escrow.auto_release_at);
        const now = new Date();
        if (now > autoReleaseTime) {
          throw new Error('Dispute window has expired. Funds have been released.');
        }
      }

      // Stop escrow auto-release
      const { error: escrowUpdateError } = await supabase
        .from('escrows')
        .update({
          status: 'dispute',
          auto_release_at: null, // Stop auto-release
          dispute_reason: reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', escrow.id);

      if (escrowUpdateError) {
        throw new Error('Failed to update escrow status');
      }

      // Update order status
      const { error: orderUpdateError } = await supabase
        .from('orders')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      if (orderUpdateError) {
        console.error('Failed to update order status (non-critical):', orderUpdateError);
      }

      // Create dispute record (if disputes table exists)
      try {
        await supabase
          .from('disputes')
          .insert({
            order_id: orderId,
            complainant_id: userId,
            respondent_id: order.vendor_id,
            reason: reason,
            description: description || '',
            status: 'open',
            created_at: new Date().toISOString(),
          });
      } catch (disputeError) {
        console.error('Failed to create dispute record (non-critical):', disputeError);
      }

      // Calculate refund amount (total - rider fee, rider keeps their fee)
      const refundAmount = parseFloat(order.total_amount) - parseFloat(order.delivery_fee || '0');

      // Process refund to buyer (buyer gets total - rider fee)
      try {
        const { error: refundError } = await supabase.rpc('process_wallet_transaction', {
          p_user_id: userId,
          p_transaction_type: 'refund',
          p_amount: refundAmount,
          p_description: `Refund for order ${order.order_number} (issue reported)`,
          p_reference_id: orderId,
          p_reference_type: 'order',
        });

        if (refundError) {
          console.error('Failed to process refund:', refundError);
          throw new Error('Failed to process refund');
        }

        console.log(`✅ Refunded ₣${refundAmount} to buyer ${userId}`);
      } catch (refundError) {
        console.error('Refund processing error:', refundError);
        throw refundError;
      }

      // Pay rider their delivery fee (they did their job)
      if (order.rider_id && order.delivery_fee && parseFloat(order.delivery_fee) > 0) {
        try {
          const { error: riderPaymentError } = await supabase.rpc('process_wallet_transaction', {
            p_user_id: order.rider_id,
            p_transaction_type: 'delivery_payment',
            p_amount: parseFloat(order.delivery_fee),
            p_description: `Delivery fee for order ${order.order_number}`,
            p_reference_id: orderId,
            p_reference_type: 'order',
          });

          if (riderPaymentError) {
            console.error('Failed to pay rider (non-critical):', riderPaymentError);
          } else {
            console.log(`✅ Paid rider ${order.rider_id} delivery fee: ₣${order.delivery_fee}`);
          }
        } catch (riderPaymentError) {
          console.error('Rider payment error (non-critical):', riderPaymentError);
        }
      }

      // ✅ REVERSE REWARDS IF USED
      const { data: orderWithRewards } = await supabase
        .from('orders')
        .select('rewards_used')
        .eq('id', orderId)
        .single();

      if (orderWithRewards && orderWithRewards.rewards_used > 0) {
        console.log(`🔄 Reversing ${orderWithRewards.rewards_used} rewards for cancelled order ${orderId}`);
        try {
          await this.rewardsService.reverseRewardsRedemption(
            userId,
            orderWithRewards.rewards_used,
            orderId
          );
          console.log(`✅ Reversed ${orderWithRewards.rewards_used} rewards for user ${userId}`);
        } catch (rewardsError) {
          console.error('Failed to reverse rewards (non-critical):', rewardsError);
        }
      }

      // Notify vendor of issue
      try {
        const notification = {
          user_id: order.vendor_id,
          type: 'order',
          title: '⚠️ Order Issue Reported',
          message: `Buyer reported an issue with order #${order.order_number}: ${reason}`,
          priority: 'high',
          data: {
            order_id: orderId,
            order_number: order.order_number,
            reason: reason,
          },
        };

        await supabase.from('notifications').insert(notification);
        console.log(`✅ Notified vendor ${order.vendor_id} of issue`);
      } catch (notifyError) {
        console.error('Failed to notify vendor (non-critical):', notifyError);
      }

      // Create tracking event
      await this.createTrackingEvent(
        orderId,
        'cancelled',
        `Buyer reported issue: ${reason}. Refund processed (minus rider fee).`
      );

      return {
        success: true,
        message: `Issue reported successfully. You have been refunded ₣${refundAmount.toFixed(2)} (order total minus delivery fee). The rider has been paid for their service.`,
        refundAmount: refundAmount,
      };
    } catch (error) {
      console.error('Error reporting issue:', error);
      throw error;
    }
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

    // Update client relationship - buyer is now a client of the seller
    try {
      await this.connectionsService.createClientRelationship(order.seller_id, {
        clientId: order.buyer_id,
        relationshipType: 'customer',
        totalOrders: 1,
        totalSpent: order.total,
      });
      console.log(`✅ Updated client relationship for seller ${order.seller_id} and buyer ${order.buyer_id}`);
    } catch (error) {
      console.error('⚠️ Failed to update client relationship:', error);
      // Don't throw - client relationship update is not critical
    }

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
          // Notify buyer and vendor that order has been delivered
          if (fullOrder.buyer_id && fullOrder.seller_id) {
            await this.notificationHelper.notifyOrderDelivered(
              fullOrder.buyer_id,
              fullOrder.seller_id,
              {
                id: fullOrder.id,
                orderNumber: fullOrder.order_number,
                totalAmount: parseFloat(fullOrder.total)
              }
            );
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

  // ========== MULTI-VENDOR ORDER GROUP METHODS ==========

  // Get order group details
  async getOrderGroup(groupId: string, userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : createServiceSupabaseClient(this.configService);
    
    // Fetch order group
    const { data: group, error: groupError } = await client
      .from('order_groups')
      .select('*')
      .eq('id', groupId)
      .eq('buyer_id', userId)
      .single();
      
    if (groupError || !group) {
      throw new Error('Order group not found');
    }
    
    // Fetch all orders in group
    const { data: orders, error: ordersError } = await client
      .from('orders')
      .select(`
        *,
        order_items(*),
        user_profiles!orders_vendor_id_fkey(username, avatar_url)
      `)
      .eq('order_group_id', groupId)
      .order('group_sequence', { ascending: true });
      
    if (ordersError) {
      throw new Error('Failed to fetch orders in group');
    }
    
    // Format orders with vendor info
    const formattedOrders = orders.map(order => ({
      ...order,
      vendor_name: order.user_profiles?.username || 'Unknown Vendor',
      items: order.order_items,
    }));
    
    return {
      group: group,
      orders: formattedOrders,
    };
  }

  // Confirm multiple orders (bulk confirmation)
  async confirmMultipleOrders(orderIds: string[], userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : createServiceSupabaseClient(this.configService);
    
    // Verify all orders belong to user and are in 'delivered' status
    const { data: orders, error } = await client
      .from('orders')
      .select('id, vendor_id, rider_id, total_amount, escrow_enabled')
      .in('id', orderIds)
      .eq('buyer_id', userId)
      .eq('status', 'delivered');
      
    if (error || !orders || orders.length !== orderIds.length) {
      throw new Error('Some orders cannot be confirmed or do not belong to you');
    }
    
    // Confirm each order (reuse existing confirmOrderReceipt logic)
    for (const order of orders) {
      await this.confirmOrderReceipt(userId, order.id);
    }

    return { success: true, confirmed: orders.length };
  }
}