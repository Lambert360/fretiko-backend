import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class WorkspaceService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async getActiveOrders(userId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const allOrders: any[] = [];

      // 1. Get regular orders
      const { data: orders, error: ordersError } = await supabaseClient
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          total,
          subtotal,
          delivery_fee,
          item_count,
          created_at,
          updated_at,
          estimated_preparation_time,
          notes,
          delivery_address,
          customer_name:user_profiles!customer_id(username),
          order_items(
            id,
            product_id,
            service_id,
            name,
            image,
            price,
            quantity,
            category,
            is_service,
            notes
          )
        `)
        .in('status', ['pending', 'processing', 'ready_for_pickup', 'out_for_delivery'])
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .order('created_at', { ascending: false });

      if (ordersError) {
        console.warn('Error fetching regular orders:', ordersError.message);
      } else if (orders) {
        const transformedOrders = orders.map(order => ({
          id: order.id,
          orderNumber: order.order_number,
          status: order.status,
          customerName: order.customer_name?.username || 'Unknown Customer',
          customerId: order.customer_id,
          itemCount: order.item_count,
          total: order.total,
          deliveryAddress: order.delivery_address,
          deliveryFee: order.delivery_fee,
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          estimatedPreparationTime: order.estimated_preparation_time,
          notes: order.notes,
          source: 'regular',
          items: order.order_items?.map(item => ({
            id: item.id,
            productId: item.product_id,
            serviceId: item.service_id,
            name: item.name,
            image: item.image,
            price: item.price,
            quantity: item.quantity,
            category: item.category,
            isService: item.is_service,
            notes: item.notes,
          })) || [],
        }));
        allOrders.push(...transformedOrders);
      }

      // 2. Get live stream transactions
      const { data: liveTransactions, error: liveError } = await supabaseClient
        .from('live_stream_transactions')
        .select(`
          id,
          total_amount,
          status,
          created_at,
          updated_at,
          transaction_type,
          quantity,
          buyer:user_profiles!buyer_id(username),
          product:products(name, image_url),
          service:services(name, image_url)
        `)
        .in('status', ['pending', 'paid', 'escrow'])
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);

      if (liveError) {
        console.warn('Error fetching live stream transactions:', liveError.message);
      } else if (liveTransactions) {
        const transformedLive = liveTransactions.map(tx => ({
          id: tx.id,
          orderNumber: `LS-${tx.id.slice(-8)}`,
          status: this.mapLiveStatusToOrderStatus(tx.status),
          customerName: tx.buyer?.username || 'Unknown Customer',
          customerId: tx.buyer_id,
          itemCount: tx.quantity || 1,
          total: tx.total_amount,
          deliveryAddress: tx.delivery_address,
          deliveryFee: 0,
          createdAt: tx.created_at,
          updatedAt: tx.updated_at,
          estimatedPreparationTime: 15,
          notes: 'Live stream purchase',
          source: 'live_stream',
          items: [{
            id: tx.id,
            productId: tx.product_id,
            serviceId: tx.service_id,
            name: tx.transaction_type === 'product' ? tx.product?.name : tx.service?.name,
            image: tx.transaction_type === 'product' ? tx.product?.image_url : tx.service?.image_url,
            price: tx.total_amount,
            quantity: tx.quantity || 1,
            category: tx.transaction_type,
            isService: tx.transaction_type === 'service',
            notes: tx.service_notes,
          }],
        }));
        allOrders.push(...transformedLive);
      }

      // 3. Get auction sales (only for sellers)
      const { data: auctionSales, error: auctionError } = await supabaseClient
        .from('auction_sales')
        .select(`
          id,
          total_amount,
          payment_status,
          created_at,
          auction:auctions(title, thumbnail_url),
          buyer:user_profiles!buyer_id(username)
        `)
        .in('payment_status', ['pending', 'processing'])
        .eq('seller_id', userId);

      if (auctionError) {
        console.warn('Error fetching auction sales:', auctionError.message);
      } else if (auctionSales) {
        const transformedAuctions = auctionSales.map(sale => ({
          id: sale.id,
          orderNumber: `AU-${sale.id.slice(-8)}`,
          status: this.mapAuctionStatusToOrderStatus(sale.payment_status),
          customerName: sale.buyer?.username || 'Unknown Customer',
          customerId: sale.buyer_id,
          itemCount: 1,
          total: sale.total_amount,
          deliveryAddress: null,
          deliveryFee: 0,
          createdAt: sale.created_at,
          updatedAt: sale.created_at,
          estimatedPreparationTime: 0,
          notes: 'Auction sale',
          source: 'auction',
          items: [{
            id: sale.id,
            productId: sale.auction_id,
            serviceId: null,
            name: sale.auction?.title || 'Auction Item',
            image: sale.auction?.thumbnail_url,
            price: sale.total_amount,
            quantity: 1,
            category: 'auction',
            isService: false,
            notes: null,
          }],
        }));
        allOrders.push(...transformedAuctions);
      }

      // 4. Get service bookings
      const { data: serviceBookings, error: bookingError } = await supabaseClient
        .from('service_bookings')
        .select(`
          id,
          total_price,
          status,
          booking_date,
          booking_time,
          created_at,
          updated_at,
          notes,
          customer:user_profiles!customer_id(username),
          service:services(name, image_url, vendor_id)
        `)
        .in('status', ['pending', 'confirmed', 'in_progress'])
        .eq('service.vendor_id', userId);

      if (bookingError) {
        console.warn('Error fetching service bookings:', bookingError.message);
      } else if (serviceBookings) {
        const transformedBookings = serviceBookings.map(booking => ({
          id: booking.id,
          orderNumber: `SB-${booking.id.slice(-8)}`,
          status: this.mapBookingStatusToOrderStatus(booking.status),
          customerName: booking.customer?.username || 'Unknown Customer',
          customerId: booking.customer_id,
          itemCount: 1,
          total: booking.total_price,
          deliveryAddress: null,
          deliveryFee: 0,
          createdAt: booking.created_at,
          updatedAt: booking.updated_at,
          estimatedPreparationTime: 0,
          notes: booking.notes || 'Service booking',
          source: 'service_booking',
          items: [{
            id: booking.id,
            productId: null,
            serviceId: booking.service_id,
            name: booking.service?.name || 'Service',
            image: booking.service?.image_url,
            price: booking.total_price,
            quantity: 1,
            category: 'service',
            isService: true,
            notes: `Scheduled: ${booking.booking_date} ${booking.booking_time}`,
          }],
        }));
        allOrders.push(...transformedBookings);
      }

      // Sort all orders by creation date (most recent first)
      allOrders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return allOrders;
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

  async getCompletedOrders(userId: string, limit: number, offset: number, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const allOrders: any[] = [];

      // 1. Get regular completed orders
      const { data: orders, error: ordersError } = await supabaseClient
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          total,
          item_count,
          created_at,
          updated_at,
          delivery_address,
          customer_name:user_profiles!customer_id(username)
        `)
        .in('status', ['delivered', 'cancelled'])
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .order('created_at', { ascending: false });

      if (ordersError) {
        console.warn('Error fetching regular completed orders:', ordersError.message);
      } else if (orders) {
        const transformedOrders = orders.map(order => ({
          id: order.id,
          orderNumber: order.order_number,
          status: order.status,
          customerName: order.customer_name?.username || 'Unknown Customer',
          itemCount: order.item_count,
          total: order.total,
          deliveryAddress: order.delivery_address,
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          source: 'regular',
        }));
        allOrders.push(...transformedOrders);
      }

      // 2. Get completed live stream transactions
      const { data: liveTransactions, error: liveError } = await supabaseClient
        .from('live_stream_transactions')
        .select(`
          id,
          total_amount,
          status,
          created_at,
          updated_at,
          transaction_type,
          quantity,
          buyer:user_profiles!buyer_id(username)
        `)
        .in('status', ['completed', 'cancelled', 'refunded'])
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);

      if (liveError) {
        console.warn('Error fetching completed live stream transactions:', liveError.message);
      } else if (liveTransactions) {
        const transformedLive = liveTransactions.map(tx => ({
          id: tx.id,
          orderNumber: `LS-${tx.id.slice(-8)}`,
          status: this.mapLiveStatusToOrderStatus(tx.status),
          customerName: tx.buyer?.username || 'Unknown Customer',
          itemCount: tx.quantity || 1,
          total: tx.total_amount,
          deliveryAddress: tx.delivery_address,
          createdAt: tx.created_at,
          updatedAt: tx.updated_at,
          source: 'live_stream',
        }));
        allOrders.push(...transformedLive);
      }

      // 3. Get completed auction sales
      const { data: auctionSales, error: auctionError } = await supabaseClient
        .from('auction_sales')
        .select(`
          id,
          total_amount,
          payment_status,
          created_at,
          completed_at,
          buyer:user_profiles!buyer_id(username)
        `)
        .in('payment_status', ['completed', 'failed', 'refunded'])
        .eq('seller_id', userId);

      if (auctionError) {
        console.warn('Error fetching completed auction sales:', auctionError.message);
      } else if (auctionSales) {
        const transformedAuctions = auctionSales.map(sale => ({
          id: sale.id,
          orderNumber: `AU-${sale.id.slice(-8)}`,
          status: this.mapAuctionStatusToOrderStatus(sale.payment_status),
          customerName: sale.buyer?.username || 'Unknown Customer',
          itemCount: 1,
          total: sale.total_amount,
          deliveryAddress: null,
          createdAt: sale.created_at,
          updatedAt: sale.completed_at || sale.created_at,
          source: 'auction',
        }));
        allOrders.push(...transformedAuctions);
      }

      // 4. Get completed service bookings
      const { data: serviceBookings, error: bookingError } = await supabaseClient
        .from('service_bookings')
        .select(`
          id,
          total_price,
          status,
          created_at,
          updated_at,
          customer:user_profiles!customer_id(username),
          service:services(name, vendor_id)
        `)
        .in('status', ['completed', 'cancelled'])
        .eq('service.vendor_id', userId);

      if (bookingError) {
        console.warn('Error fetching completed service bookings:', bookingError.message);
      } else if (serviceBookings) {
        const transformedBookings = serviceBookings.map(booking => ({
          id: booking.id,
          orderNumber: `SB-${booking.id.slice(-8)}`,
          status: this.mapBookingStatusToOrderStatus(booking.status),
          customerName: booking.customer?.username || 'Unknown Customer',
          itemCount: 1,
          total: booking.total_price,
          deliveryAddress: null,
          createdAt: booking.created_at,
          updatedAt: booking.updated_at,
          source: 'service_booking',
        }));
        allOrders.push(...transformedBookings);
      }

      // Sort all orders by creation date (most recent first) and apply pagination
      allOrders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const paginatedOrders = allOrders.slice(offset, offset + limit);

      return paginatedOrders;
    } catch (error) {
      console.error('Error fetching completed orders:', error);
      throw error;
    }
  }

  async getWorkspaceStats(userId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const today = new Date().toISOString().split('T')[0];
      let todayOrdersCount = 0;
      let todayRevenue = 0;
      let completedToday = 0;
      let pendingCount = 0;
      let processingCount = 0;
      let readyCount = 0;

      // 1. Regular orders
      const { data: todayOrders, error: todayError } = await supabaseClient
        .from('orders')
        .select('total, status')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      if (!todayError && todayOrders) {
        todayOrdersCount += todayOrders.length;
        todayRevenue += todayOrders.reduce((sum, order) => sum + (order.total || 0), 0);
        completedToday += todayOrders.filter(order => order.status === 'delivered').length;
      }

      // Get counts for different statuses
      const { count: regularPending } = await supabaseClient
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);
      pendingCount += regularPending || 0;

      const { count: regularProcessing } = await supabaseClient
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'processing')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);
      processingCount += regularProcessing || 0;

      const { count: regularReady } = await supabaseClient
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'ready_for_pickup')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);
      readyCount += regularReady || 0;

      // 2. Live stream transactions
      const { data: todayLive, error: liveError } = await supabaseClient
        .from('live_stream_transactions')
        .select('total_amount, status')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      if (!liveError && todayLive) {
        todayOrdersCount += todayLive.length;
        todayRevenue += todayLive.reduce((sum, tx) => sum + (tx.total_amount || 0), 0);
        completedToday += todayLive.filter(tx => tx.status === 'completed').length;
      }

      // Get live stream pending/processing counts
      const { count: livePending } = await supabaseClient
        .from('live_stream_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);
      pendingCount += livePending || 0;

      const { count: liveProcessing } = await supabaseClient
        .from('live_stream_transactions')
        .select('*', { count: 'exact', head: true })
        .in('status', ['paid', 'escrow'])
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);
      processingCount += liveProcessing || 0;

      // 3. Auction sales
      const { data: todayAuctions, error: auctionError } = await supabaseClient
        .from('auction_sales')
        .select('total_amount, payment_status')
        .eq('seller_id', userId)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      if (!auctionError && todayAuctions) {
        todayOrdersCount += todayAuctions.length;
        todayRevenue += todayAuctions.reduce((sum, sale) => sum + (sale.total_amount || 0), 0);
        completedToday += todayAuctions.filter(sale => sale.payment_status === 'completed').length;
      }

      // Get auction pending/processing counts
      const { count: auctionPending } = await supabaseClient
        .from('auction_sales')
        .select('*', { count: 'exact', head: true })
        .eq('payment_status', 'pending')
        .eq('seller_id', userId);
      pendingCount += auctionPending || 0;

      const { count: auctionProcessing } = await supabaseClient
        .from('auction_sales')
        .select('*', { count: 'exact', head: true })
        .eq('payment_status', 'processing')
        .eq('seller_id', userId);
      processingCount += auctionProcessing || 0;

      // 4. Service bookings
      const { data: todayBookings, error: bookingError } = await supabaseClient
        .from('service_bookings')
        .select(`
          total_price,
          status,
          service:services!inner(vendor_id)
        `)
        .eq('service.vendor_id', userId)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      if (!bookingError && todayBookings) {
        todayOrdersCount += todayBookings.length;
        todayRevenue += todayBookings.reduce((sum, booking) => sum + (booking.total_price || 0), 0);
        completedToday += todayBookings.filter(booking => booking.status === 'completed').length;
      }

      // Get service booking pending/processing counts
      const { count: bookingPending } = await supabaseClient
        .from('service_bookings')
        .select('*, service:services!inner(vendor_id)', { count: 'exact', head: true })
        .eq('status', 'pending')
        .eq('service.vendor_id', userId);
      pendingCount += bookingPending || 0;

      const { count: bookingProcessing } = await supabaseClient
        .from('service_bookings')
        .select('*, service:services!inner(vendor_id)', { count: 'exact', head: true })
        .in('status', ['confirmed', 'in_progress'])
        .eq('service.vendor_id', userId);
      processingCount += bookingProcessing || 0;

      // Calculate average preparation time (mock calculation)
      const averagePreparationTime = 25; // In minutes

      // Get customer rating (mock data)
      const customerRating = 4.7;

      // Calculate orders and revenue by source
      const regularOrdersCount = todayOrders?.length || 0;
      const regularRevenue = todayOrders?.reduce((sum, order) => sum + (order.total || 0), 0) || 0;
      const liveStreamOrdersCount = todayLive?.length || 0;
      const liveStreamRevenue = todayLive?.reduce((sum, tx) => sum + (tx.total_amount || 0), 0) || 0;
      const auctionOrdersCount = todayAuctions?.length || 0;
      const auctionRevenue = todayAuctions?.reduce((sum, sale) => sum + (sale.total_amount || 0), 0) || 0;
      const serviceOrdersCount = todayBookings?.length || 0;
      const serviceRevenue = todayBookings?.reduce((sum, booking) => sum + (booking.total_price || 0), 0) || 0;

      // Get live stream stats
      const { data: activeStreams } = await supabaseClient
        .from('live_streams')
        .select('id')
        .eq('vendor_id', userId)
        .eq('status', 'live');

      const activeLiveStreams = activeStreams?.length || 0;
      const liveOrdersPercentage = todayOrdersCount > 0 ? (liveStreamOrdersCount / todayOrdersCount) * 100 : 0;
      const averageLiveOrderValue = liveStreamOrdersCount > 0 ? liveStreamRevenue / liveStreamOrdersCount : 0;

      return {
        todayOrders: todayOrdersCount,
        todayRevenue,
        pendingOrders: pendingCount,
        processingOrders: processingCount,
        readyForPickupOrders: readyCount,
        completedToday,
        averagePreparationTime,
        customerRating,
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
      const { data: order, error } = await supabaseClient
        .from('orders')
        .select(`
          *,
          customer:user_profiles!customer_id(id, username, phone, email, avatar_url),
          order_items(
            id,
            product_id,
            service_id,
            name,
            image,
            price,
            quantity,
            category,
            is_service,
            notes
          )
        `)
        .eq('id', orderId)
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .single();

      if (error || !order) {
        throw new NotFoundException('Order not found');
      }

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
        items: order.order_items?.map(item => ({
          id: item.id,
          productId: item.product_id,
          serviceId: item.service_id,
          name: item.name,
          image: item.image,
          price: item.price,
          quantity: item.quantity,
          category: item.category,
          isService: item.is_service,
          notes: item.notes,
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
      const { data, error } = await supabaseClient
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

      // TODO: Notify available riders

      return { success: true, message: 'Order marked as ready for pickup' };
    } catch (error) {
      console.error('Error marking order ready:', error);
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

  async markDelivered(userId: string, orderId: string, deliveryProof?: any, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data, error } = await supabaseClient
        .from('orders')
        .update({
          status: 'delivered',
          updated_at: new Date().toISOString(),
          delivery_proof: deliveryProof,
        })
        .eq('id', orderId)
        .eq('rider_id', userId)
        .eq('status', 'out_for_delivery');

      if (error) {
        throw new Error(`Failed to mark delivered: ${error.message}`);
      }

      return { success: true, message: 'Order marked as delivered' };
    } catch (error) {
      console.error('Error marking delivered:', error);
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