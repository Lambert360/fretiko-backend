import { Injectable, NotFoundException, ForbiddenException, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { EscrowService } from '../escrow/escrow.service';

@Injectable()
export class WorkspaceService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async getActiveOrders(userId: string, userToken?: string) {
    const startTime = Date.now();
    console.log('⏱️ [WORKSPACE] Starting getActiveOrders...');
    
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ SIMPLIFIED: ALL order types are in the 'orders' table!
      // Just query orders table filtered by vendor or rider
      const queryStart = Date.now();
      const { data: orders, error: ordersError } = await supabaseClient
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          total_amount,
          delivery_fee,
          created_at,
          updated_at,
          buyer_id,
          delivery_address,
          source,
          metadata,
          order_items(
            id,
            product_id,
          product_name,
          unit_price,
            quantity,
          total_price,
          product_metadata
          )
        `)
        .in('status', ['pending', 'accepted', 'processing', 'ready_for_pickup', 'out_for_delivery', 'paid'])
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .order('created_at', { ascending: false });

      const queryTime = Date.now() - queryStart;
      console.log(`⏱️ [WORKSPACE] Orders query took ${queryTime}ms`);

      if (ordersError) {
        throw new Error(`Error fetching active orders: ${ordersError.message}`);
      }

      if (!orders || orders.length === 0) {
        console.log('⏱️ [WORKSPACE] No active orders found');
        return [];
      }

      console.log(`⏱️ [WORKSPACE] Found ${orders.length} active orders`);

      // ✅ Fetch buyer profiles separately
      const profileStart = Date.now();
      const buyerIds = [...new Set(orders.map(o => o.buyer_id).filter(Boolean))];
      const buyerProfiles: Record<string, any> = {};
      
      if (buyerIds.length > 0) {
        const { data: profiles } = await supabaseClient
          .from('user_profiles')
          .select('id, username, avatar_url')
          .in('id', buyerIds);
        
        profiles?.forEach(p => {
          buyerProfiles[p.id] = p;
        });
        console.log(`⏱️ [WORKSPACE] Profiles fetch took ${Date.now() - profileStart}ms (${buyerIds.length} buyers)`);
      }

      // ✅ Transform orders - use the source field from database!
      const transformStart = Date.now();
        const transformedOrders = orders.map(order => ({
          id: order.id,
          orderNumber: order.order_number,
          status: order.status,
        customerName: buyerProfiles[order.buyer_id]?.username || 'Unknown Customer',
        customerId: order.buyer_id,
        itemCount: order.order_items?.length || 0,
        total: order.total_amount,
          deliveryAddress: order.delivery_address,
          deliveryFee: order.delivery_fee,
          createdAt: order.created_at,
          updatedAt: order.updated_at,
        estimatedPreparationTime: order.metadata?.estimated_preparation_time || 15,
        notes: order.metadata?.notes,
        source: order.source || 'regular', // ✅ Use source from database!
          items: order.order_items?.map(item => ({
            id: item.id,
            productId: item.product_id,
          name: item.product_name,
          image: item.product_metadata?.image || item.product_metadata?.images?.[0] || null,
          price: item.unit_price,
            quantity: item.quantity,
          totalPrice: item.total_price,
          })) || [],
        }));

      const transformTime = Date.now() - transformStart;
      const totalTime = Date.now() - startTime;
      console.log(`⏱️ [WORKSPACE] Transform took ${transformTime}ms`);
      console.log(`⏱️ [WORKSPACE] ✅ getActiveOrders completed in ${totalTime}ms`);

      return transformedOrders;
    } catch (error) {
      console.error('Error fetching active orders:', error);
      throw error;
    }
  }

  private mapLiveStatusToOrderStatus(liveStatus: string): string {
    const statusMap = {
      'pending': 'pending',
      'paid': 'processing',
      'escrow': 'processing',
      'completed': 'delivered',
      'cancelled': 'cancelled',
      'refunded': 'cancelled'
    };
    return statusMap[liveStatus] || 'pending';
  }

  private mapAuctionStatusToOrderStatus(auctionStatus: string): string {
    const statusMap = {
      'pending': 'pending',
      'processing': 'processing',
      'completed': 'delivered',
      'failed': 'cancelled',
      'refunded': 'cancelled'
    };
    return statusMap[auctionStatus] || 'pending';
  }

  private mapBookingStatusToOrderStatus(bookingStatus: string): string {
    const statusMap = {
      'pending': 'pending',
      'confirmed': 'processing',
      'in_progress': 'processing',
      'completed': 'delivered',
      'cancelled': 'cancelled'
    };
    return statusMap[bookingStatus] || 'pending';
  }

  async getCompletedOrders(userId: string, limit: number = 20, offset: number = 0, userToken?: string) {
    const startTime = Date.now();
    console.log('⏱️ [WORKSPACE] Starting getCompletedOrders...');
    
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ SIMPLIFIED: Query ONLY the orders table
      const { data: orders, error: ordersError} = await supabaseClient
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          total_amount,
          created_at,
          updated_at,
          buyer_id,
          delivery_address,
          source
        `)
        .in('status', ['delivered', 'completed', 'cancelled'])
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (ordersError) {
        throw new Error(`Error fetching completed orders: ${ordersError.message}`);
      }

      if (!orders || orders.length === 0) {
        return [];
      }

      // ✅ Fetch buyer profiles separately
      const buyerIds = [...new Set(orders.map(o => o.buyer_id).filter(Boolean))];
      const buyerProfiles: Record<string, any> = {};
      
      if (buyerIds.length > 0) {
        const { data: profiles } = await supabaseClient
          .from('user_profiles')
          .select('id, username, avatar_url')
          .in('id', buyerIds);
        
        profiles?.forEach(p => {
          buyerProfiles[p.id] = p;
        });
      }

      // ✅ Transform orders - use source from database
      const transformedOrders = orders.map(order => ({
        id: order.id,
        orderNumber: order.order_number,
        status: order.status,
        customerName: buyerProfiles[order.buyer_id]?.username || 'Unknown Customer',
          itemCount: 1,
        total: order.total_amount,
        deliveryAddress: order.delivery_address,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        source: order.source || 'regular', // ✅ Use source from database!
      }));

      console.log(`⏱️ [WORKSPACE] ✅ getCompletedOrders completed in ${Date.now() - startTime}ms (${orders.length} orders)`);
      return transformedOrders;
    } catch (error) {
      console.error('Error fetching completed orders:', error);
      throw error;
    }
  }

  async getWorkspaceStats(userId: string, userToken?: string) {
    const startTime = Date.now();
    console.log('⏱️ [WORKSPACE] Starting getWorkspaceStats...');
    
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const today = new Date().toISOString().split('T')[0];

      // ✅ OPTIMIZATION: Get ALL today's orders in ONE query instead of 20+
      const queryStart = Date.now();
      const { data: todayOrders, error: todayError } = await supabaseClient
        .from('orders')
        .select('id, total_amount, status, source, delivery_fee, created_at, updated_at, metadata')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      console.log(`⏱️ [WORKSPACE] Today's orders query: ${Date.now() - queryStart}ms`);

      if (todayError) {
        console.error('Error fetching today orders:', todayError);
        throw new Error('Failed to fetch today orders');
      }

      // ✅ Calculate all stats from the single query result (fast JavaScript processing)
      const todayOrdersCount = todayOrders?.length || 0;
      const todayRevenue = todayOrders?.reduce((sum, order) => sum + (order.total_amount || 0), 0) || 0;
      const completedToday = todayOrders?.filter(order => order.status === 'delivered' || order.status === 'completed').length || 0;

      // ✅ Get active orders in ONE query (for status counts)
      const activeQueryStart = Date.now();
      const { data: activeOrders } = await supabaseClient
        .from('orders')
        .select('id, status, source, created_at, metadata')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .in('status', ['pending', 'processing', 'ready_for_pickup']);
      
      console.log(`⏱️ [WORKSPACE] Active orders query: ${Date.now() - activeQueryStart}ms`);

      // ✅ Calculate counts from active orders (fast - in memory)
      const pendingCount = activeOrders?.filter(o => o.status === 'pending').length || 0;
      const processingCount = activeOrders?.filter(o => o.status === 'processing').length || 0;
      const readyCount = activeOrders?.filter(o => o.status === 'ready_for_pickup').length || 0;

      // ✅ Calculate orders and revenue by source (from today's orders)
      const regularOrdersCount = todayOrders?.filter(o => o.source === 'regular' || !o.source).length || 0;
      const regularRevenue = todayOrders?.filter(o => o.source === 'regular' || !o.source)
        .reduce((sum, order) => sum + (order.total_amount || 0), 0) || 0;
        
      const liveStreamOrdersCount = todayOrders?.filter(o => o.source === 'live_stream').length || 0;
      const liveStreamRevenue = todayOrders?.filter(o => o.source === 'live_stream')
        .reduce((sum, order) => sum + (order.total_amount || 0), 0) || 0;
        
      const auctionOrdersCount = todayOrders?.filter(o => o.source === 'auction').length || 0;
      const auctionRevenue = todayOrders?.filter(o => o.source === 'auction')
        .reduce((sum, order) => sum + (order.total_amount || 0), 0) || 0;
        
      const serviceOrdersCount = todayOrders?.filter(o => o.source === 'service_booking').length || 0;
      const serviceRevenue = todayOrders?.filter(o => o.source === 'service_booking')
        .reduce((sum, order) => sum + (order.total_amount || 0), 0) || 0;

      console.log(`⏱️ [WORKSPACE] Stats calculated from ${todayOrdersCount} orders`);

      // Calculate average preparation time from metadata
      const averagePreparationTime = 25; // In minutes (TODO: Calculate from actual data)

      // Get customer rating (TODO: Get from actual ratings table)
      const customerRating = 4.7;

      // ✅ Get live stream and escrow data in parallel (non-blocking)
      const [activeStreamsResult, vendorEscrowsResult, riderEscrowsResult] = await Promise.all([
        supabaseClient
          .from('live_streams')
          .select('id')
          .eq('vendor_id', userId)
          .eq('status', 'live'),
        supabaseClient
          .from('escrows')
          .select('id, vendor_amount, rider_amount, status, created_at, released_at, auto_release_at, refund_reason, dispute_reason')
          .eq('vendor_id', userId),
        supabaseClient
          .from('escrows')
          .select('id, rider_amount, status')
          .eq('rider_id', userId)
      ]);

      console.log(`⏱️ [WORKSPACE] Parallel queries completed`);

      const activeLiveStreams = activeStreamsResult.data?.length || 0;
      const liveOrdersPercentage = todayOrdersCount > 0 ? (liveStreamOrdersCount / todayOrdersCount) * 100 : 0;
      const averageLiveOrderValue = liveStreamOrdersCount > 0 ? liveStreamRevenue / liveStreamOrdersCount : 0;

      // ✅ Calculate escrow metrics from query results
      const allVendorEscrows = vendorEscrowsResult.data || [];

      // Calculate escrow metrics
      const heldEscrows = allVendorEscrows?.filter(e => e.status === 'held') || [];
      const releasedEscrows = allVendorEscrows?.filter(e => e.status === 'released') || [];
      const refundedEscrows = allVendorEscrows?.filter(e => e.status === 'refunded') || [];
      const disputedEscrows = allVendorEscrows?.filter(e => e.status === 'dispute') || [];

      const totalInEscrow = heldEscrows.reduce((sum, e) => sum + parseFloat(e.vendor_amount || '0'), 0);

      // Calculate average hold time for released escrows
      const escrowHoldTimes = releasedEscrows
        .filter(e => e.created_at && e.released_at)
        .map(e => {
          const created = new Date(e.created_at).getTime();
          const released = new Date(e.released_at).getTime();
          return (released - created) / (1000 * 60 * 60); // Hours
        });
      const averageHoldTime = escrowHoldTimes.length > 0
        ? escrowHoldTimes.reduce((sum, time) => sum + time, 0) / escrowHoldTimes.length
        : 0;

      // Calculate auto-release rate
      const totalReleasedCount = releasedEscrows.length;
      const autoReleasedCount = releasedEscrows.filter(e => 
        e.auto_release_at && e.released_at && 
        new Date(e.released_at).getTime() >= new Date(e.auto_release_at).getTime() - 60000 // Within 1 minute of auto-release
      ).length;
      const autoReleaseRate = totalReleasedCount > 0 
        ? (autoReleasedCount / totalReleasedCount) * 100 
        : 0;

      // Calculate dispute rate
      const totalEscrowsCount = allVendorEscrows?.length || 0;
      const disputeRate = totalEscrowsCount > 0 
        ? (disputedEscrows.length / totalEscrowsCount) * 100 
        : 0;

      // Calculate refund rate
      const refundRate = totalEscrowsCount > 0 
        ? (refundedEscrows.length / totalEscrowsCount) * 100 
        : 0;

      // Get escrows ready for release (within next 24 hours)
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const pendingReleaseEscrows = heldEscrows.filter(e => 
        e.auto_release_at && 
        new Date(e.auto_release_at).getTime() <= tomorrow.getTime()
      );
      const pendingReleaseAmount = pendingReleaseEscrows.reduce((sum, e) => sum + parseFloat(e.vendor_amount || '0'), 0);

      // Get escrows released today
      const releasedTodayEscrows = releasedEscrows.filter(e => 
        e.released_at &&
        new Date(e.released_at).toISOString().split('T')[0] === today
      );
      const releasedTodayAmount = releasedTodayEscrows.reduce((sum, e) => sum + parseFloat(e.vendor_amount || '0'), 0);

      // ✅ Calculate rider escrow from already-fetched data
      const riderHeldEscrows = riderEscrowsResult.data?.filter(e => e.status === 'held') || [];
      const riderInEscrow = riderHeldEscrows.reduce((sum, e) => sum + parseFloat(e.rider_amount || '0'), 0);

      // ✅ VENDOR PERFORMANCE METRICS - Fetch all historical orders for stats
      const performanceQueryStart = Date.now();
      const [allVendorOrdersResult, allRiderOrdersResult] = await Promise.all([
        supabaseClient
          .from('orders')
          .select('id, status, created_at, updated_at, metadata, estimated_delivery')
          .eq('vendor_id', userId),
        supabaseClient
          .from('orders')
          .select('id, status, created_at, updated_at, metadata, estimated_delivery, delivery_address')
          .eq('rider_id', userId)
      ]);
      
      console.log(`⏱️ [WORKSPACE] Performance queries: ${Date.now() - performanceQueryStart}ms`);

      const allOrders = allVendorOrdersResult.data || [];
      const totalOrdersReceived = allOrders.length;
      const acceptedOrders = allOrders?.filter(o => 
        !['pending', 'cancelled'].includes(o.status)
      ).length || 0;
      const cancelledOrders = allOrders?.filter(o => o.status === 'cancelled').length || 0;

      const orderAcceptanceRate = totalOrdersReceived > 0 
        ? (acceptedOrders / totalOrdersReceived) * 100 
        : 0;
      const cancellationRate = totalOrdersReceived > 0 
        ? (cancelledOrders / totalOrdersReceived) * 100 
        : 0;

      // Calculate average preparation time (time from accepted to ready)
      const preparationTimes = allOrders
        ?.filter(o => o.status === 'ready_for_pickup' || o.status === 'out_for_delivery' || o.status === 'delivered')
        .map(o => {
          // Estimate prep time from metadata if available, otherwise use default
          if (o.metadata?.accepted_at && o.metadata?.ready_at) {
            const accepted = new Date(o.metadata.accepted_at).getTime();
            const ready = new Date(o.metadata.ready_at).getTime();
            return (ready - accepted) / (1000 * 60); // Minutes
          }
          return null;
        })
        .filter(time => time !== null) || [];

      const averagePreparationTimeMinutes = preparationTimes.length > 0
        ? preparationTimes.reduce((sum, time) => sum + time, 0) / preparationTimes.length
        : 25; // Default estimate

      // ✅ RIDER PERFORMANCE METRICS (from already-fetched data)
      const riderOrders = allRiderOrdersResult.data || [];

      const totalRiderDeliveries = riderOrders.filter(o => 
        o.status === 'delivered' || o.status === 'completed'
      ).length || 0;

      // Calculate on-time delivery rate
      const onTimeDeliveries = riderOrders
        ?.filter(o => {
          if (o.status !== 'delivered' && o.status !== 'completed') return false;
          if (!o.estimated_delivery || !o.metadata?.delivered_at) return false;
          
          const estimated = new Date(o.estimated_delivery).getTime();
          const delivered = new Date(o.metadata.delivered_at).getTime();
          return delivered <= estimated;
        }).length || 0;

      const onTimeDeliveryRate = totalRiderDeliveries > 0 
        ? (onTimeDeliveries / totalRiderDeliveries) * 100 
        : 0;

      // Calculate average delivery time
      const deliveryTimes = riderOrders
        ?.filter(o => {
          return (o.status === 'delivered' || o.status === 'completed') && 
                 o.metadata?.picked_up_at && 
                 o.metadata?.delivered_at;
        })
        .map(o => {
          const pickedUp = new Date(o.metadata.picked_up_at).getTime();
          const delivered = new Date(o.metadata.delivered_at).getTime();
          return (delivered - pickedUp) / (1000 * 60); // Minutes
        }) || [];

      const averageDeliveryTimeMinutes = deliveryTimes.length > 0
        ? deliveryTimes.reduce((sum, time) => sum + time, 0) / deliveryTimes.length
        : 0;

      // Get rider ratings from user_profiles or orders metadata
      // For now, use a placeholder until rating system is fully implemented
      const riderRating = 4.7; // TODO: Get from actual ratings table
      const totalRatings = totalRiderDeliveries;

      console.log(`⏱️ [WORKSPACE] ✅ getWorkspaceStats completed in ${Date.now() - startTime}ms`);

      return {
        todayOrders: todayOrdersCount,
        todayRevenue,
        pendingOrders: pendingCount,
        processingOrders: processingCount,
        readyForPickupOrders: readyCount,
        completedToday,
        averagePreparationTime: Math.round(averagePreparationTimeMinutes),
        customerRating,
        // ✅ VENDOR PERFORMANCE ANALYTICS
        vendorMetrics: {
          totalOrders: totalOrdersReceived,
          acceptedOrders,
          cancelledOrders,
          orderAcceptanceRate: Math.round(orderAcceptanceRate * 10) / 10, // %
          cancellationRate: Math.round(cancellationRate * 10) / 10, // %
          averagePreparationTime: Math.round(averagePreparationTimeMinutes), // Minutes
        },
        // ✅ RIDER PERFORMANCE ANALYTICS
        riderMetrics: {
          totalDeliveries: totalRiderDeliveries,
          onTimeDeliveries,
          onTimeDeliveryRate: Math.round(onTimeDeliveryRate * 10) / 10, // %
          averageDeliveryTime: Math.round(averageDeliveryTimeMinutes), // Minutes
          rating: riderRating,
          totalRatings,
        },
        liveStreamStats: {
          todayLiveOrders: liveStreamOrdersCount,
          todayLiveRevenue: liveStreamRevenue,
          liveOrdersPercentage,
          averageLiveOrderValue,
          activeLiveStreams,
          totalLiveStreamTime: 0, // TODO: Calculate from stream durations
        },
        ordersBySource: {
          regular: regularOrdersCount,
          live_stream: liveStreamOrdersCount,
          auction: auctionOrdersCount,
          service_booking: serviceOrdersCount,
        },
        revenueBySource: {
          regular: regularRevenue,
          live_stream: liveStreamRevenue,
          auction: auctionRevenue,
          service_booking: serviceRevenue,
        },
        escrowMetrics: {
          totalInEscrow, // Total funds held in escrow (vendor)
          riderInEscrow, // Total delivery fees held in escrow (rider)
          pendingRelease: pendingReleaseAmount, // Funds releasing within 24 hours
          releasedToday: releasedTodayAmount, // Funds released today
          escrowCount: heldEscrows.length, // Number of active escrows
          // Advanced analytics
          averageHoldTimeHours: Math.round(averageHoldTime * 10) / 10, // Average escrow hold time in hours
          autoReleaseRate: Math.round(autoReleaseRate * 10) / 10, // % of escrows auto-released
          disputeRate: Math.round(disputeRate * 10) / 10, // % of escrows disputed
          refundRate: Math.round(refundRate * 10) / 10, // % of escrows refunded
          totalReleased: releasedEscrows.length, // Total released escrows
          totalDisputed: disputedEscrows.length, // Total disputed escrows
          totalRefunded: refundedEscrows.length, // Total refunded escrows
          pendingReleaseCount: pendingReleaseEscrows.length, // Count of escrows releasing within 24h
        },
      };
    } catch (error) {
      console.error('Error fetching workspace stats:', error);
      throw error;
    }
  }

  async getOrderDetails(userId: string, orderId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      console.log(`🔍 [WORKSPACE] Fetching order details for orderId: ${orderId}, userId: ${userId}`);
      
      const { data: order, error } = await supabaseClient
        .from('orders')
        .select(`
          *,
          customer:user_profiles!orders_buyer_id_fkey(id, username, phone, avatar_url),
          order_items(
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
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .single();

      if (error) {
        console.error(`❌ [WORKSPACE] Error fetching order: ${error.message}`, error);
        throw new NotFoundException(`Order not found: ${error.message}`);
      }

      if (!order) {
        console.error(`❌ [WORKSPACE] No order data returned for ID: ${orderId}`);
        throw new NotFoundException('Order not found');
      }

      console.log(`✅ [WORKSPACE] Order found:`, {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        has_pickup_pin: !!order.pickup_pin,
        has_delivery_pin: !!order.delivery_pin,
      });

      // Get order timeline (mock data for now)
      const timeline = [
        {
          status: 'pending',
          timestamp: order.created_at,
          note: 'Order received',
        },
      ];

      if (order.status !== 'pending') {
        timeline.push({
          status: 'processing',
          timestamp: order.updated_at,
          note: 'Order accepted and being prepared',
        });
      }

      return {
        ...order,
        orderNumber: order.order_number,
        customerName: order.customer?.username || 'Unknown Customer',
        // ✅ Include PINs for handoff verification
        pickupPin: order.pickup_pin,
        deliveryPin: order.delivery_pin,
        pickupPinVerifiedAt: order.pickup_pin_verified_at,
        deliveryPinVerifiedAt: order.delivery_pin_verified_at,
        items: order.order_items?.map(item => ({
          id: item.id,
          productId: item.product_id,
          name: item.product_name,
          image: item.product_metadata?.image || item.product_metadata?.images?.[0] || null,
          price: item.unit_price,
          quantity: item.quantity,
          totalPrice: item.total_price,
          category: item.product_metadata?.category || null,
          isService: item.product_metadata?.is_service || false,
          notes: item.product_metadata?.notes || null,
        })) || [],
        customer: {
          id: order.customer?.id,
          name: order.customer?.username,
          phone: order.customer?.phone,
          email: order.customer?.email,
          avatar: order.customer?.avatar_url,
        },
        deliveryDetails: {
          address: order.delivery_address,
          instructions: order.delivery_instructions,
        },
        timeline,
      };
    } catch (error) {
      console.error('Error fetching order details:', error);
      throw error;
    }
  }

  async acceptOrder(userId: string, orderId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // Fetch order details for notification
      const { data: order } = await supabaseClient
        .from('orders')
        .select('order_number, buyer_id, status')
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .single();

      if (!order) {
        throw new Error('Order not found or unauthorized');
      }

      if (order.status !== 'pending') {
        throw new Error(`Order cannot be accepted. Current status: ${order.status}`);
      }

      // Update order status to processing
      const { data, error } = await supabaseClient
        .from('orders')
        .update({
          status: 'processing',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'pending');

      if (error) {
        throw new Error(`Failed to accept order: ${error.message}`);
      }

      // ✅ NOTIFY BUYER OF ORDER ACCEPTANCE
      try {
        await this.notificationHelper.notifyOrderAccepted(order.buyer_id, {
          orderId,
          orderNumber: order.order_number,
          vendorId: userId,
        });
        console.log(`✅ Buyer ${order.buyer_id} notified of order acceptance`);
      } catch (notifyError) {
        console.error('Failed to notify buyer (non-critical):', notifyError);
      }

      return { success: true, message: 'Order accepted successfully' };
    } catch (error) {
      console.error('Error accepting order:', error);
      throw error;
    }
  }

  async declineOrder(userId: string, orderId: string, reason?: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data, error } = await supabaseClient
        .from('orders')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString(),
          notes: reason ? `Declined: ${reason}` : 'Order declined by vendor',
        })
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'pending');

      if (error) {
        throw new Error(`Failed to decline order: ${error.message}`);
      }

      return { success: true, message: 'Order declined successfully' };
    } catch (error) {
      console.error('Error declining order:', error);
      throw error;
    }
  }

  async markOrderReady(userId: string, orderId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ Verify vendor owns order and it's in processing status
      const { data: order, error: fetchError } = await supabaseClient
        .from('orders')
        .select('id, order_number, rider_id, buyer_id, vendor_id, delivery_type')
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'processing')
        .single();

      if (fetchError || !order) {
        throw new Error('Order not found or unauthorized');
      }

      // ✅ Update status to ready_for_pickup (NO PIN VERIFICATION YET)
      const { error } = await supabaseClient
        .from('orders')
        .update({
          status: 'ready_for_pickup',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'processing');

      if (error) {
        throw new Error(`Failed to mark order ready: ${error.message}`);
      }

      // ✅ Notify rider and buyer that order is ready
      // Skip rider notification for self-pickup orders (rider_id is null)
      try {
        // Get vendor name for notifications
        const { data: vendorProfile } = await supabaseClient
          .from('user_profiles')
          .select('username')
          .eq('id', userId)
          .single();

        // Only notify rider if there's a rider (not self-pickup)
        const riderId = order.delivery_type === 'pickup' ? null : order.rider_id;
        
        await this.notificationHelper.notifyOrderReadyForPickup(
          riderId,
          order.buyer_id,
          {
            id: orderId,
            orderNumber: order.order_number,
            vendorName: vendorProfile?.username,
          }
        );
        if (riderId) {
          console.log(`✅ Notified rider ${riderId} and buyer ${order.buyer_id} that order is ready`);
        } else {
          console.log(`✅ Notified buyer ${order.buyer_id} that order is ready (self-pickup)`);
        }
      } catch (notifyError) {
        console.error('Failed to send ready notifications (non-critical):', notifyError);
      }

      console.log(`✅ Order ${orderId} marked as ready for pickup`);

      return { success: true, message: 'Order marked as ready for pickup. Waiting for rider to arrive.' };
    } catch (error) {
      console.error('Error marking order ready:', error);
      throw error;
    }
  }

  async markOrderReadyForPickup(userId: string, orderId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ Verify vendor owns order and it's in processing status
      const { data: order, error: fetchError } = await supabaseClient
        .from('orders')
        .select('id, order_number, delivery_type, delivery_pin, buyer_id, vendor_id')
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'processing')
        .single();

      if (fetchError || !order) {
        throw new Error('Order not found or unauthorized');
      }

      // Log order details for debugging
      console.log('🚚 [DEBUG] Order details for ready-for-pickup:', {
        orderId,
        delivery_type: order.delivery_type,
        rider_id: order.rider_id,
        status: order.status
      });

      // ✅ Verify this is a self-pickup order (no rider)
      if (order.delivery_type !== 'pickup') {
        console.error('❌ [DEBUG] Delivery type mismatch:', {
          expected: 'pickup',
          actual: order.delivery_type
        });
        throw new Error('This action is only for self-pickup orders');
      }

      // ✅ Update status to ready_for_pickup
      const { error } = await supabaseClient
        .from('orders')
        .update({
          status: 'ready_for_pickup',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'processing');

      if (error) {
        throw new Error(`Failed to mark order ready for pickup: ${error.message}`);
      }

      // ✅ Notify buyer that order is ready for collection
      try {
        // Get vendor name for notification
        const { data: vendorProfile } = await supabaseClient
          .from('user_profiles')
          .select('username')
          .eq('id', userId)
          .single();

        await this.notificationHelper.notifyBuyerOrderReadyForPickup(
          order.buyer_id,
          {
            id: orderId,
            orderNumber: order.order_number,
            vendorName: vendorProfile?.username,
            deliveryPin: order.delivery_pin,
          }
        );
        console.log(`✅ Notified buyer ${order.buyer_id} that order is ready for pickup`);
      } catch (notifyError) {
        console.error('Failed to send ready notification (non-critical):', notifyError);
      }

      console.log(`✅ Order ${orderId} marked as ready for self-pickup`);

      return { success: true, message: 'Order is ready! Buyer will be notified to collect it.' };
    } catch (error) {
      console.error('Error marking order ready for pickup:', error);
      throw error;
    }
  }

  /**
   * Calculate category-based escrow countdown (shared with orders.service.ts)
   */
  private getCategoryBasedCountdown(categories: string[]): { 
    countdownMs: number; 
    countdownHours: number; 
    primaryCategory: string 
  } {
    const categoryTimers: { [key: string]: number } = {
      'Food & Beverages': 3, 'Fresh Produce': 3, 'Bakery': 3, 'Fast Food': 3, 'Restaurant': 3, 'Catering': 3,
      'Flowers': 6, 'Plants': 6, 'Perishables': 6,
      'Health & Personal Care': 24, 'Clothing & Apparel': 24, 'Home & Garden': 24, 'Books & Media': 24,
      'Toys & Games': 24, 'Sports & Outdoors': 24, 'Beauty & Cosmetics': 24, 'General': 24,
      'Services': 48, 'Professional Services': 48, 'Home Services': 48, 'Beauty Services': 48, 'Repair Services': 48,
      'Electronics': 72, 'Computers & Accessories': 72, 'Jewelry & Watches': 72, 'Luxury Goods': 72,
      'Vehicles & Parts': 72, 'Furniture': 72, 'Appliances': 72,
    };

    let shortestHours = 24;
    let primaryCategory = 'General';

    for (const category of categories) {
      const hours = categoryTimers[category];
      if (hours && hours < shortestHours) {
        shortestHours = hours;
        primaryCategory = category;
      }
    }

    return {
      countdownMs: shortestHours * 60 * 60 * 1000,
      countdownHours: shortestHours,
      primaryCategory,
    };
  }

  async confirmSelfPickupWithPin(userId: string, orderId: string, deliveryPin: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ Verify vendor owns order and it's ready for pickup
      const { data: order, error: fetchError } = await supabaseClient
        .from('orders')
        .select('id, order_number, delivery_pin, delivery_type, buyer_id, vendor_id, total_amount')
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'ready_for_pickup')
        .single();

      if (fetchError || !order) {
        throw new Error('Order not found or unauthorized');
      }

      // ✅ Verify this is a self-pickup order
      if (order.delivery_type !== 'pickup') {
        throw new Error('This action is only for self-pickup orders');
      }

      // ✅ Validate buyer's delivery PIN
      if (order.delivery_pin !== deliveryPin) {
        throw new Error('Invalid PIN. Please check the buyer\'s PIN and try again.');
      }

      // ✅ FETCH ORDER ITEMS WITH CATEGORIES
      const { data: orderItems } = await supabaseClient
        .from('order_items')
        .select('category')
        .eq('order_id', orderId);

      const categories = orderItems?.map(item => item.category).filter(Boolean) || ['General'];

      // ✅ CALCULATE CATEGORY-BASED COUNTDOWN
      const { countdownMs, countdownHours, primaryCategory } = this.getCategoryBasedCountdown(categories);

      // ✅ Update status to delivered and set escrow countdown
      const { error } = await supabaseClient
        .from('orders')
        .update({
          status: 'delivered',
          delivered_at: new Date().toISOString(),
          order_confirmed_at: new Date().toISOString(), // Auto-confirm for self-pickup
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'ready_for_pickup');

      if (error) {
        throw new Error(`Failed to confirm self-pickup: ${error.message}`);
      }

      // ✅ SET ESCROW AUTO-RELEASE TIMER (category-based)
      try {
        const autoReleaseAt = new Date(Date.now() + countdownMs).toISOString();
        
        const { error: escrowError } = await supabaseClient
          .from('escrows')
          .update({
            auto_release_at: autoReleaseAt,
            countdown_hours: countdownHours,
            category_based: true,
            primary_category: primaryCategory,
            updated_at: new Date().toISOString(),
          })
          .eq('order_id', orderId)
          .eq('status', 'held');

        if (escrowError) {
          console.error('Failed to update escrow auto-release:', escrowError);
        } else {
          console.log(`✅ Escrow for self-pickup order ${orderId} will auto-release in ${countdownHours}h (Category: ${primaryCategory})`);
        }
      } catch (escrowError) {
        console.error('Failed to set escrow auto-release timer (non-critical):', escrowError);
      }

      // ✅ Notify buyer that order was collected
      try {
        const { data: vendorProfile } = await supabaseClient
          .from('user_profiles')
          .select('username')
          .eq('id', userId)
          .single();

        await this.notificationHelper.notifyOrderDelivered(
          order.buyer_id,
          order.vendor_id,
          {
            id: orderId,
            orderNumber: order.order_number,
            totalAmount: order.total_amount,
          }
        );
        console.log(`✅ Notified buyer ${order.buyer_id} of self-pickup confirmation`);
      } catch (notifyError) {
        console.error('Failed to send pickup confirmation notification (non-critical):', notifyError);
      }

      console.log(`✅ Self-pickup confirmed for order ${orderId} with ${countdownHours}h countdown`);

      return { success: true, message: `Order collected successfully! Buyer has ${countdownHours} hours to report issues.` };
    } catch (error) {
      console.error('Error confirming self-pickup:', error);
      throw error;
    }
  }

  async confirmPickupWithPin(userId: string, orderId: string, pickupPin: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ Verify vendor owns order and it's ready for pickup
      const { data: order, error: fetchError } = await supabaseClient
        .from('orders')
        .select('id, order_number, pickup_pin, rider_id, buyer_id, vendor_id')
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'ready_for_pickup')
        .single();

      if (fetchError || !order) {
        throw new Error('Order not found or unauthorized');
      }

      // ✅ Verify pickup PIN
      if (order.pickup_pin !== pickupPin) {
        throw new Error('Invalid pickup PIN');
      }

      // ✅ PIN verified - update status to out_for_delivery
      const { error } = await supabaseClient
        .from('orders')
        .update({
          status: 'out_for_delivery',
          pickup_pin_verified_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('status', 'ready_for_pickup');

      if (error) {
        throw new Error(`Failed to confirm pickup: ${error.message}`);
      }

      // ✅ Notify buyer and vendor that order was picked up
      try {
        // Get rider name for notifications
        const { data: riderProfile } = await supabaseClient
          .from('user_profiles')
          .select('username')
          .eq('id', order.rider_id)
          .single();

        await this.notificationHelper.notifyOrderPickedUp(
          order.buyer_id,
          order.vendor_id,
          {
            id: orderId,
            orderNumber: order.order_number,
            riderName: riderProfile?.username,
          }
        );
        console.log(`✅ Notified buyer and vendor that order ${orderId} was picked up`);
      } catch (notifyError) {
        console.error('Failed to send pickup notifications (non-critical):', notifyError);
      }

      console.log(`✅ Order ${orderId} pickup confirmed with PIN, now out for delivery`);

      return { success: true, message: 'Pickup confirmed! Order is now out for delivery.' };
    } catch (error) {
      console.error('Error confirming pickup:', error);
      throw error;
    }
  }

  async confirmPickup(userId: string, orderId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data, error } = await supabaseClient
        .from('orders')
        .update({
          status: 'out_for_delivery',
          updated_at: new Date().toISOString(),
          rider_id: userId,
        })
        .eq('id', orderId)
        .eq('status', 'ready_for_pickup');

      if (error) {
        throw new Error(`Failed to confirm pickup: ${error.message}`);
      }

      return { success: true, message: 'Pickup confirmed' };
    } catch (error) {
      console.error('Error confirming pickup:', error);
      throw error;
    }
  }

  async markDelivered(userId: string, orderId: string, deliveryPin: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ Verify delivery PIN
      const { data: order, error: fetchError } = await supabaseClient
        .from('orders')
        .select('id, order_number, delivery_pin, buyer_id, vendor_id, total_amount')
        .eq('id', orderId)
        .eq('rider_id', userId)
        .eq('status', 'out_for_delivery')
        .single();

      if (fetchError || !order) {
        console.error(`❌ Order not found or unauthorized:`, fetchError);
        throw new Error('Order not found or unauthorized');
      }

      console.log(`🔍 PIN Verification Debug:`, {
        orderId,
        storedPIN: order.delivery_pin,
        receivedPIN: deliveryPin,
        match: order.delivery_pin === deliveryPin,
        storedType: typeof order.delivery_pin,
        receivedType: typeof deliveryPin,
      });

      if (order.delivery_pin !== deliveryPin) {
        throw new Error('Invalid delivery PIN');
      }

      // ✅ PIN verified - update order status to delivered AND mark as received
      const { error } = await supabaseClient
        .from('orders')
        .update({
          status: 'delivered',
          delivery_pin_verified_at: new Date().toISOString(),
          delivered_at: new Date().toISOString(),
          order_confirmed_at: new Date().toISOString(), // ✅ Mark as received immediately
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .eq('rider_id', userId)
        .eq('status', 'out_for_delivery');

      if (error) {
        throw new Error(`Failed to mark delivered: ${error.message}`);
      }

      // ✅ UPDATE ESCROW AUTO-RELEASE TIMER (24 hours from delivery)
      try {
        const autoReleaseAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        
        const { error: escrowError } = await supabaseClient
          .from('escrows')
          .update({
            auto_release_at: autoReleaseAt,
            updated_at: new Date().toISOString(),
          })
          .eq('order_id', orderId)
          .eq('status', 'held');

        if (escrowError) {
          console.error('Failed to update escrow auto-release (non-critical):', escrowError);
        } else {
          console.log(`✅ Escrow for order ${orderId} will auto-release at ${autoReleaseAt}`);
        }
      } catch (escrowError) {
        console.error('Failed to set escrow auto-release timer (non-critical):', escrowError);
      }

      // ✅ Notify buyer and vendor that order was delivered
      try {
        await this.notificationHelper.notifyOrderDelivered(
          order.buyer_id,
          order.vendor_id,
          {
            id: orderId,
            orderNumber: order.order_number,
            totalAmount: parseFloat(order.total_amount),
          }
        );
        console.log(`✅ Notified buyer and vendor that order ${orderId} was delivered`);
      } catch (notifyError) {
        console.error('Failed to send delivery notifications (non-critical):', notifyError);
      }

      console.log(`✅ Order ${orderId} marked as delivered and received. 24-hour dispute window started.`);

      return { 
        success: true, 
        message: 'Order delivered and received! Buyer has 24 hours to report issues or funds will be released automatically.' 
      };
    } catch (error) {
      console.error('Error marking delivered:', error);
      throw error;
    }
  }

  /**
   * Mark service booking as completed (vendor completes service)
   * This triggers escrow release after 24-hour dispute window
   */
  async completeServiceBooking(userId: string, orderId: string, completionNotes?: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // 1. Verify vendor owns the order
      const { data: order, error: orderError } = await supabaseClient
        .from('orders')
        .select('id, order_number, status, vendor_id, buyer_id, source, metadata')
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .eq('source', 'service_booking')
        .single();

      if (orderError || !order) {
        throw new Error('Service booking not found or unauthorized');
      }

      // 2. Check order is ready for completion
      if (!['paid', 'accepted', 'processing'].includes(order.status)) {
        throw new Error(`Service cannot be marked as completed from status: ${order.status}`);
      }

      // 3. Update order status to delivered (services use 'delivered' to trigger escrow timer)
      const { error: updateError } = await supabaseClient
        .from('orders')
        .update({
          status: 'delivered',
          updated_at: new Date().toISOString(),
          metadata: {
            ...order.metadata,
            completed_at: new Date().toISOString(),
            completion_notes: completionNotes || null,
          },
        })
        .eq('id', orderId);

      if (updateError) {
        throw new Error('Failed to update service booking status');
      }

      // 4. Update service_bookings table status to 'pending_confirmation'
      try {
        await supabaseClient
          .from('service_bookings')
          .update({
            status: 'pending_confirmation', // Waiting for buyer confirmation
            updated_at: new Date().toISOString(),
          })
          .eq('order_id', orderId);
      } catch (bookingError) {
        console.error('Failed to update service_bookings record (non-critical):', bookingError);
      }

      // ⚠️ DO NOT set auto-release timer yet - buyer must confirm first
      // The auto-release timer will be set when buyer confirms receipt (via confirmOrderReceipt)

      // 5. Notify buyer that service is completed and needs confirmation
      try {
        await this.notificationHelper.notifyOrderAccepted(order.buyer_id, {
          orderId,
          orderNumber: order.order_number,
          vendorId: userId,
        });
        console.log(`✅ Buyer ${order.buyer_id} notified of service completion (pending confirmation)`);
      } catch (notifyError) {
        console.error('Failed to notify buyer (non-critical):', notifyError);
      }

      return { 
        success: true, 
        message: 'Service marked as completed. Waiting for buyer confirmation before escrow release.' 
      };
    } catch (error) {
      console.error('Error completing service booking:', error);
      throw error;
    }
  }

  async updatePreparationTime(userId: string, orderId: string, estimatedMinutes: number, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data, error } = await supabaseClient
        .from('orders')
        .update({
          estimated_preparation_time: estimatedMinutes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .eq('vendor_id', userId);

      if (error) {
        throw new Error(`Failed to update preparation time: ${error.message}`);
      }

      return { success: true };
    } catch (error) {
      console.error('Error updating preparation time:', error);
      throw error;
    }
  }

  async requestEscrowRelease(userId: string, orderId: string, reason?: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // 1. Verify vendor owns the order
      const { data: order, error: orderError } = await supabaseClient
        .from('orders')
        .select('id, order_number, status, vendor_id, buyer_id')
        .eq('id', orderId)
        .eq('vendor_id', userId)
        .single();

      if (orderError || !order) {
        throw new Error('Order not found or unauthorized');
      }

      // 2. Check order is delivered (24-hour dispute window)
      if (order.status !== 'delivered') {
        throw new Error('Order must be delivered before requesting escrow release');
      }

      // 3. Find escrow for this order
      const { data: escrow, error: escrowError } = await supabaseClient
        .from('escrows')
        .select('id, status, created_at')
        .eq('order_id', orderId)
        .eq('status', 'held')
        .single();

      if (escrowError || !escrow) {
        throw new Error('No held escrow found for this order');
      }

      // 4. Check if 24-hour dispute window has passed
      const deliveryTime = new Date(order.status === 'delivered' ? Date.now() : 0);
      const hoursSinceDelivery = (Date.now() - deliveryTime.getTime()) / (1000 * 60 * 60);

      if (hoursSinceDelivery < 24) {
        return {
          success: false,
          message: `Escrow will auto-release after 24-hour dispute window. ${Math.ceil(24 - hoursSinceDelivery)} hours remaining.`,
          hoursRemaining: Math.ceil(24 - hoursSinceDelivery),
        };
      }

      // 5. Release escrow
      await this.escrowService.releaseEscrow(
        escrow.id,
        reason || 'Vendor requested release after dispute window',
      );

      return {
        success: true,
        message: 'Escrow released successfully. Funds have been credited to your wallet.',
      };
    } catch (error) {
      console.error('Error requesting escrow release:', error);
      throw error;
    }
  }

  async addOrderNotes(userId: string, orderId: string, notes: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data, error } = await supabaseClient
        .from('orders')
        .update({
          notes: notes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);

      if (error) {
        throw new Error(`Failed to add notes: ${error.message}`);
      }

      return { success: true };
    } catch (error) {
      console.error('Error adding notes:', error);
      throw error;
    }
  }

  async getOrdersByStatus(userId: string, status: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data: orders, error } = await supabaseClient
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          total,
          item_count,
          created_at,
          delivery_address,
          customer_name:user_profiles!customer_id(username)
        `)
        .eq('status', status)
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Failed to fetch orders by status: ${error.message}`);
      }

      const transformedOrders = orders?.map(order => ({
        id: order.id,
        orderNumber: order.order_number,
        status: order.status,
        customerName: order.customer_name?.username || 'Unknown Customer',
        itemCount: order.item_count,
        total: order.total,
        deliveryAddress: order.delivery_address,
        createdAt: order.created_at,
      })) || [];

      return transformedOrders;
    } catch (error) {
      console.error('Error fetching orders by status:', error);
      throw error;
    }
  }
}