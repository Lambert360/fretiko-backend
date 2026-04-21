import { Injectable, HttpException, HttpStatus, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Import ExcelJS and PDFKit (CommonJS modules - use require with type assertions)
// @ts-ignore - CommonJS module without default export
const ExcelJS = require('exceljs');
// @ts-ignore - CommonJS module  
const PDFDocument = require('pdfkit');

interface CacheEntry {
  data: any;
  expiresAt: number;
}

/**
 * Custom error class for analytics operations
 * ✅ ERROR HANDLING FIX: Standardized error handling
 */
class AnalyticsError extends HttpException {
  constructor(
    message: string,
    public code: string,
    statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR
  ) {
    super({ message, code }, statusCode);
    this.name = 'AnalyticsError';
  }
}

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private supabase;
  private serviceSupabase; // Service role client for inserts (bypasses RLS)
  
  // ✅ PERFORMANCE FIX: Configuration constants
  private readonly MAX_HISTORICAL_DAYS = 90; // Limit historical queries to 90 days
  private readonly MAX_QUERY_RESULTS = 10000; // Hard limit on query results
  
  // ✅ PHASE 5 FIX: Configurable values (can be overridden via environment variables)
  private readonly PLATFORM_COMMISSION_RATE: number;
  private readonly EXPORT_EXPIRY_HOURS = 24; // Export files expire after 24 hours
  
  // ✅ PERFORMANCE FIX: Caching layer
  private analyticsCache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL = {
    REALTIME: 5 * 60 * 1000, // 5 minutes
    HISTORICAL: 60 * 60 * 1000, // 1 hour
  };

  // ✅ PHASE 6 FIX: Event batching for high-frequency events
  private eventBatch: Map<string, Array<{
    type: string;
    data: any;
    timestamp: number;
  }>> = new Map();
  private readonly BATCH_INTERVAL = 5 * 1000; // 5 seconds
  private readonly BATCH_SIZE = 50; // Max events per batch
  private batchIntervalId: NodeJS.Timeout | null = null;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
    
    // PHASE 5 FIX: Load configurable values from environment
    this.PLATFORM_COMMISSION_RATE = parseFloat(
      this.configService.get<string>('PLATFORM_COMMISSION_RATE', '0.1')
    );
    
    // ✅ PERFORMANCE FIX: Cleanup expired cache entries every 10 minutes
    setInterval(() => this.cleanupExpiredCache(), 10 * 60 * 1000);
    
    // ✅ PHASE 6 FIX: Start event batching interval
    this.batchIntervalId = setInterval(() => this.processEventBatch(), this.BATCH_INTERVAL);
  }

  /**
   * On module destruction, cleanup intervals
   * ✅ PHASE 6 FIX: Cleanup lifecycle hook
   */
  onModuleDestroy() {
    if (this.batchIntervalId) {
      clearInterval(this.batchIntervalId);
      this.batchIntervalId = null;
    }
    // Clear all batches before shutdown
    this.eventBatch.clear();
    // Clear cache
    this.analyticsCache.clear();
  }

  async getAnalytics(userId: string, period: string, date?: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ PHASE 5 FIX: Input validation
      if (!userId) {
        throw new AnalyticsError(
          'User ID is required',
          'INVALID_USER_ID',
          HttpStatus.BAD_REQUEST
        );
      }

      const validPeriods = ['daily', 'weekly', 'monthly'];
      if (!validPeriods.includes(period)) {
        throw new AnalyticsError(
          `Invalid period: ${period}. Valid periods are: ${validPeriods.join(', ')}`,
          'INVALID_PERIOD',
          HttpStatus.BAD_REQUEST
        );
      }

      if (date && isNaN(Date.parse(date))) {
        throw new AnalyticsError(
          `Invalid date format: ${date}. Expected ISO date string.`,
          'INVALID_DATE',
          HttpStatus.BAD_REQUEST
        );
      }

      // ✅ PERFORMANCE FIX: Check cache first
      const cacheKey = this.getCacheKey('getAnalytics', { userId, period, date });
      const cached = this.getCachedData(cacheKey);
      if (cached) {
        return cached;
      }

      const dateRange = this.getDateRange(period, date);
      // ✅ PERFORMANCE FIX: Apply 90-day limit to historical queries
      const effectiveDateRange = this.applyHistoricalDateLimit(dateRange);
      
      let totalOrdersProcessed = 0;
      let totalTransactionValue = 0;
      let totalCompletedTransactions = 0;
      const allCustomers = new Set();

      // ✅ PERFORMANCE FIX: Execute all queries in parallel using Promise.all
      const [
        ordersResult,
        liveTransactionsResult,
        liveGiftsResult,
        auctionSalesResult,
        serviceBookingsResult
      ] = await Promise.all([
        // 1. Get regular orders data for the period
        supabaseClient
          .from('orders')
          .select('*')
          .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
          .gte('created_at', effectiveDateRange.start)
          .lte('created_at', effectiveDateRange.end)
          .limit(this.MAX_QUERY_RESULTS),
        
        // 2. Get live stream transactions
        supabaseClient
          .from('live_stream_transactions')
          .select('*')
          .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
          .gte('created_at', effectiveDateRange.start)
          .lte('created_at', effectiveDateRange.end)
          .limit(this.MAX_QUERY_RESULTS),
        
        // 2b. Get live stream gifts (additional revenue stream)
        supabaseClient
          .from('live_stream_gifts')
          .select(`
            *,
            stream:live_streams!inner(vendor_id)
          `)
          .eq('stream.vendor_id', userId)
          .gte('created_at', effectiveDateRange.start)
          .lte('created_at', effectiveDateRange.end)
          .limit(this.MAX_QUERY_RESULTS),
        
        // 3. Get auction sales
        supabaseClient
          .from('auction_sales')
          .select('*')
          .eq('seller_id', userId)
          .gte('created_at', effectiveDateRange.start)
          .lte('created_at', effectiveDateRange.end)
          .limit(this.MAX_QUERY_RESULTS),
        
        // 4. Get service bookings
        supabaseClient
          .from('service_bookings')
          .select(`
            *,
            service:services!inner(vendor_id)
          `)
          .eq('service.vendor_id', userId)
          .gte('created_at', effectiveDateRange.start)
          .lte('created_at', effectiveDateRange.end)
          .limit(this.MAX_QUERY_RESULTS)
      ]);

      const { data: orders, error: ordersError } = ordersResult;
      const { data: liveTransactions, error: liveError } = liveTransactionsResult;
      const { data: liveGifts, error: giftsError } = liveGiftsResult;
      const { data: auctionSales, error: auctionError } = auctionSalesResult;
      const { data: serviceBookings, error: bookingError } = serviceBookingsResult;

      if (!ordersError && orders) {
        totalOrdersProcessed += orders.length;
        totalTransactionValue += orders.reduce((sum, order) => sum + (order.total || 0), 0);
        totalCompletedTransactions += orders.filter(order => order.status === 'delivered').length;
        orders.forEach(order => order.customer_id && allCustomers.add(order.customer_id));
      }

      if (!liveError && liveTransactions) {
        totalOrdersProcessed += liveTransactions.length;
        totalTransactionValue += liveTransactions.reduce((sum, tx) => sum + (tx.total_amount || 0), 0);
        totalCompletedTransactions += liveTransactions.filter(tx => tx.status === 'completed').length;
        liveTransactions.forEach(tx => tx.buyer_id && allCustomers.add(tx.buyer_id));
      }

      let totalGiftValue = 0;
      if (!giftsError && liveGifts) {
        totalGiftValue = liveGifts.reduce((sum, gift) => sum + (gift.total_amount || 0), 0);
        totalTransactionValue += totalGiftValue;
        // Gifts count as completed transactions immediately
        totalCompletedTransactions += liveGifts.length;
        liveGifts.forEach(gift => gift.sender_id && allCustomers.add(gift.sender_id));
      }

      if (!auctionError && auctionSales) {
        totalOrdersProcessed += auctionSales.length;
        totalTransactionValue += auctionSales.reduce((sum, sale) => sum + (sale.total_amount || 0), 0);
        totalCompletedTransactions += auctionSales.filter(sale => sale.payment_status === 'completed').length;
        auctionSales.forEach(sale => sale.buyer_id && allCustomers.add(sale.buyer_id));
      }

      if (!bookingError && serviceBookings) {
        totalOrdersProcessed += serviceBookings.length;
        totalTransactionValue += serviceBookings.reduce((sum, booking) => sum + (booking.total_price || 0), 0);
        totalCompletedTransactions += serviceBookings.filter(booking => booking.status === 'completed').length;
        serviceBookings.forEach(booking => booking.customer_id && allCustomers.add(booking.customer_id));
      }

      // ✅ ERROR HANDLING FIX: Check for critical errors
      if (ordersError) {
        console.error(`[Analytics] Error fetching orders for user ${userId}:`, ordersError);
        throw new AnalyticsError(
          `Failed to fetch order analytics: ${ordersError.message}`,
          'ORDERS_FETCH_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Log non-critical errors (other data sources can still provide partial data)
      if (liveError) {
        console.error(`[Analytics] Warning: Error fetching live transactions for user ${userId}:`, liveError);
      }
      if (giftsError) {
        console.error(`[Analytics] Warning: Error fetching live gifts for user ${userId}:`, giftsError);
      }
      if (auctionError) {
        console.error(`[Analytics] Warning: Error fetching auction sales for user ${userId}:`, auctionError);
      }
      if (bookingError) {
        console.error(`[Analytics] Warning: Error fetching service bookings for user ${userId}:`, bookingError);
      }

      // Calculate unified metrics
      const ordersProcessed = totalOrdersProcessed;
      const transactionValue = totalTransactionValue;
      const transactionCount = totalCompletedTransactions;
      const revenue = transactionValue;
      const activeCustomers = allCustomers.size;
      const averageOrderValue = ordersProcessed > 0 ? transactionValue / ordersProcessed : 0;

      // Generate chart data (simplified example - using combined data)
      const chartData = this.generateChartData({ orders, liveTransactions, auctionSales, serviceBookings }, period);

      // Generate sample reports
      const reports = [
        {
          id: '1',
          title: `${period.charAt(0).toUpperCase() + period.slice(1)} Sales Report`,
          subtitle: `Generated on ${new Date().toLocaleDateString()}`,
          status: 'completed',
          createdAt: new Date().toISOString(),
          type: period,
        },
        {
          id: '2',
          title: 'Customer Analytics Report',
          subtitle: `${activeCustomers} customers analyzed`,
          status: 'completed',
          createdAt: new Date().toISOString(),
          type: 'custom',
        },
      ];

      // Calculate real trends by comparing with previous period
      const trends = await this.calculateTrends(
        userId,
        period,
        date,
        { ordersProcessed, revenue, activeCustomers },
        supabaseClient
      );

      const result = {
        period,
        date: date || new Date().toISOString().split('T')[0],
        ordersProcessed,
        transactionValue,
        transactionCount,
        revenue,
        activeCustomers,
        averageOrderValue,
        completionRate: ordersProcessed > 0 ? (transactionCount / ordersProcessed) * 100 : 0,
        customerSatisfaction: await this.calculateCustomerSatisfaction(userId, supabaseClient),
        chartData,
        reports,
        trends,
      };

      // ✅ PERFORMANCE FIX: Cache the result
      this.setCachedData(cacheKey, result, this.CACHE_TTL.HISTORICAL);
      
      return result;
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Unexpected error in getAnalytics for user ${userId}:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while fetching analytics',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  async getAnalyticsSummary(userId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      let totalRevenue = 0;
      let totalOrders = 0;
      const allCustomers = new Set();

      // 1. Get all-time regular orders
      const { data: allOrders, error: ordersError } = await supabaseClient
        .from('orders')
        .select('*')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);

      if (!ordersError && allOrders) {
        totalRevenue += allOrders.reduce((sum, order) => sum + (order.total || 0), 0);
        totalOrders += allOrders.length;
        allOrders.forEach(order => order.customer_id && allCustomers.add(order.customer_id));
      }

      // 2. Get all-time live stream transactions
      const { data: allLiveTransactions, error: liveError } = await supabaseClient
        .from('live_stream_transactions')
        .select('*')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);

      if (!liveError && allLiveTransactions) {
        totalRevenue += allLiveTransactions.reduce((sum, tx) => sum + (tx.total_amount || 0), 0);
        totalOrders += allLiveTransactions.length;
        allLiveTransactions.forEach(tx => tx.buyer_id && allCustomers.add(tx.buyer_id));
      }

      // 3. Get all-time auction sales
      const { data: allAuctionSales, error: auctionError } = await supabaseClient
        .from('auction_sales')
        .select('*')
        .eq('seller_id', userId);

      if (!auctionError && allAuctionSales) {
        totalRevenue += allAuctionSales.reduce((sum, sale) => sum + (sale.total_amount || 0), 0);
        totalOrders += allAuctionSales.length;
        allAuctionSales.forEach(sale => sale.buyer_id && allCustomers.add(sale.buyer_id));
      }

      // 4. Get all-time service bookings
      const { data: allServiceBookings, error: bookingError } = await supabaseClient
        .from('service_bookings')
        .select(`
          *,
          service:services!inner(vendor_id)
        `)
        .eq('service.vendor_id', userId);

      if (!bookingError && allServiceBookings) {
        totalRevenue += allServiceBookings.reduce((sum, booking) => sum + (booking.total_price || 0), 0);
        totalOrders += allServiceBookings.length;
        allServiceBookings.forEach(booking => booking.customer_id && allCustomers.add(booking.customer_id));
      }

      const totalCustomers = allCustomers.size;

      // Get top selling products/services from all sources
      const topSellingProducts = await this.getTopSellingItems(userId, supabaseClient);

      // ✅ PHASE 5 FIX: Get recent activity from actual orders
      const { data: recentOrders } = await supabaseClient
        .from('orders')
        .select('id, order_number, total, status, created_at')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .order('created_at', { ascending: false })
        .limit(10);

      const recentActivity = (recentOrders || []).slice(0, 5).map(order => ({
        type: order.status === 'delivered' ? 'payment' : 'order',
        description: order.status === 'delivered' 
          ? `Payment received for order #${order.order_number}`
          : `New order #${order.order_number} received`,
        timestamp: order.created_at,
      }));

      return {
        totalRevenue,
        totalOrders,
        totalCustomers,
        averageRating: 4.7,
        topSellingProducts,
        recentActivity,
      };
    } catch (error) {
      console.error('Error fetching analytics summary:', error);
      throw error;
    }
  }

  async getRevenueAnalytics(userId: string, period: string, startDate?: string, endDate?: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = startDate && endDate
        ? { start: startDate, end: endDate }
        : this.getDateRange(period);

      const { data: orders, error } = await supabaseClient
        .from('orders')
        .select(`
          *,
          order_items(*)
        `)
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end)
        .eq('status', 'delivered');

      if (error) {
        throw new Error(`Failed to fetch revenue analytics: ${error.message}`);
      }

      const totalRevenue = orders?.reduce((sum, order) => sum + (order.total || 0), 0) || 0;

      // Revenue by day (simplified)
      const revenueByDay = this.groupRevenueByDay(orders);

      // ✅ PHASE 5 FIX: Calculate revenue by category from actual order items
      const { data: orderItems } = await supabaseClient
        .from('order_items')
        .select(`
          category,
          total_price,
          orders!inner(vendor_id, created_at, status)
        `)
        .eq('orders.vendor_id', userId)
        .eq('orders.status', 'delivered')
        .gte('orders.created_at', dateRange.start)
        .lte('orders.created_at', dateRange.end);

      const categoryRevenue = new Map<string, number>();
      orderItems?.forEach(item => {
        const category = item.category || 'Uncategorized';
        const existing = categoryRevenue.get(category) || 0;
        categoryRevenue.set(category, existing + (item.total_price || 0));
      });

      const revenueByCategory = Array.from(categoryRevenue.entries())
        .map(([category, revenue]) => ({
          category,
          revenue,
          percentage: totalRevenue > 0 ? (revenue / totalRevenue) * 100 : 0
        }))
        .sort((a, b) => b.revenue - a.revenue);

      // If no category data, return empty array
      if (revenueByCategory.length === 0) {
        revenueByCategory.push({ category: 'Uncategorized', revenue: totalRevenue, percentage: 100 });
      }

      // Revenue by product (simplified)
      const revenueByProduct = orders?.slice(0, 5).map(order => ({
        productId: order.id,
        productName: `Order ${order.order_number}`,
        revenue: order.total,
        orders: 1,
      })) || [];

      return {
        totalRevenue,
        revenueByDay,
        revenueByCategory,
        revenueByProduct,
      };
    } catch (error) {
      console.error('Error fetching revenue analytics:', error);
      throw error;
    }
  }

  async getCustomerAnalytics(userId: string, period: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period);

      // ✅ BUG FIX: Fetch actual orders with customer and total data
      const { data: orders, error } = await supabaseClient
        .from('orders')
        .select('customer_id, created_at, total, buyer_id')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      if (error) {
        console.error(`[Analytics] Error fetching customer analytics for user ${userId}:`, error);
        throw new AnalyticsError(
          `Failed to fetch customer analytics: ${error.message}`,
          'CUSTOMER_ANALYTICS_FETCH_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      if (!orders || orders.length === 0) {
        return {
          totalCustomers: 0,
          newCustomers: 0,
          returningCustomers: 0,
          customerRetentionRate: 0,
          averageOrdersPerCustomer: 0,
          topCustomers: [],
        };
      }

      // ✅ BUG FIX: Get customer first order dates (all-time, not just period)
      const customerFirstOrders = await this.getCustomerFirstOrderDates(userId, supabaseClient);

      // ✅ BUG FIX: Calculate new vs returning customers from actual data
      const newCustomers = new Set<string>();
      const returningCustomers = new Set<string>();
      const periodStart = new Date(dateRange.start);

      orders.forEach(order => {
        const customerId = order.customer_id || order.buyer_id;
        if (!customerId) return;

        const firstOrderDate = customerFirstOrders.get(customerId);
        
        if (!firstOrderDate) {
          // No previous order found - this is a new customer
          newCustomers.add(customerId);
        } else {
          // Check if first order was before this period
          if (firstOrderDate < periodStart) {
            returningCustomers.add(customerId);
          } else {
            // First order is within this period - new customer
            newCustomers.add(customerId);
          }
        }
      });

      const totalCustomers = newCustomers.size + returningCustomers.size;
      const customerRetentionRate = totalCustomers > 0 
        ? (returningCustomers.size / totalCustomers) * 100 
        : 0;
      const averageOrdersPerCustomer = totalCustomers > 0 
        ? orders.length / totalCustomers 
        : 0;

      // ✅ BUG FIX: Calculate top customers from real order data
      const customerSpending = new Map<string, { orders: number; total: number }>();
      
      orders.forEach(order => {
        const customerId = order.customer_id || order.buyer_id;
        if (!customerId) return;

        const current = customerSpending.get(customerId) || { orders: 0, total: 0 };
        customerSpending.set(customerId, {
          orders: current.orders + 1,
          total: current.total + (order.total || 0)
        });
      });

      // Sort by total spent and get top 10
      const topCustomersData = Array.from(customerSpending.entries())
        .map(([customerId, data]) => ({
          customerId,
          totalOrders: data.orders,
          totalSpent: data.total
        }))
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, 10);

      // ✅ BUG FIX: Fetch customer names from user_profiles
      const customerIds = topCustomersData.map(c => c.customerId);
      let profileMap = new Map<string, string>();
      
      if (customerIds.length > 0) {
        const { data: profiles } = await supabaseClient
          .from('user_profiles')
          .select('id, username, name')
          .in('id', customerIds);

        profiles?.forEach(profile => {
          profileMap.set(profile.id, profile.username || profile.name || 'Unknown Customer');
        });
      }

      const topCustomers = topCustomersData.map(c => ({
        customerId: c.customerId,
        customerName: profileMap.get(c.customerId) || 'Unknown Customer',
        totalOrders: c.totalOrders,
        totalSpent: c.totalSpent,
      }));

      return {
        totalCustomers,
        newCustomers: newCustomers.size,
        returningCustomers: returningCustomers.size,
        customerRetentionRate: Math.round(customerRetentionRate * 10) / 10,
        averageOrdersPerCustomer: Math.round(averageOrdersPerCustomer * 10) / 10,
        topCustomers,
      };
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Unexpected error in getCustomerAnalytics for user ${userId}:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while fetching customer analytics',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Helper method to get customer first order dates
   * ✅ BUG FIX: New helper method for accurate customer analytics
   */
  private async getCustomerFirstOrderDates(
    userId: string, 
    supabaseClient: any
  ): Promise<Map<string, Date>> {
    try {
      const { data: allOrders } = await supabaseClient
        .from('orders')
        .select('customer_id, created_at, buyer_id')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .order('created_at', { ascending: true });

      const firstOrderMap = new Map<string, Date>();
      
      allOrders?.forEach(order => {
        const customerId = order.customer_id || order.buyer_id;
        if (!customerId) return;

        if (!firstOrderMap.has(customerId)) {
          firstOrderMap.set(customerId, new Date(order.created_at));
        }
      });

      return firstOrderMap;
    } catch (error) {
      console.error('Error fetching customer first order dates:', error);
      return new Map();
    }
  }

  async getProductAnalytics(userId: string, period: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period);

      // ✅ BUG FIX: Fetch actual order items with product details
      const { data: orderItems, error: itemsError } = await supabaseClient
        .from('order_items')
        .select(`
          id,
          product_id,
          product_name,
          category,
          quantity,
          price,
          total_price,
          orders!inner(
            id,
            vendor_id,
            created_at,
            status
          )
        `)
        .eq('orders.vendor_id', userId)
        .gte('orders.created_at', dateRange.start)
        .lte('orders.created_at', dateRange.end)
        .eq('orders.status', 'delivered');

      if (itemsError) {
        console.error(`[Analytics] Error fetching product analytics for user ${userId}:`, itemsError);
        throw new AnalyticsError(
          `Failed to fetch product analytics: ${itemsError.message}`,
          'PRODUCT_ANALYTICS_FETCH_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // ✅ BUG FIX: Get total products count
      const { data: products, error: productsError } = await supabaseClient
        .from('products')
        .select('id, name, stock_quantity, min_stock_level')
        .eq('vendor_id', userId);

      if (productsError) {
        console.error('Error fetching products:', productsError);
      }

      const totalProducts = products?.length || 0;

      if (!orderItems || orderItems.length === 0) {
    return {
          totalProducts,
          totalSales: 0,
          topSellingProducts: [],
          categoryPerformance: [],
          lowStockProducts: products?.filter(p => 
            p.stock_quantity <= (p.min_stock_level || 0)
          ).map(p => ({
            productId: p.id,
            productName: p.name,
            currentStock: p.stock_quantity,
            minStock: p.min_stock_level || 0
          })) || [],
        };
      }

      // ✅ BUG FIX: Aggregate by product
      const productSales = new Map<string, {
        productId: string;
        productName: string;
        category: string;
        quantitySold: number;
        revenue: number;
        orderCount: number;
      }>();

      const categorySales = new Map<string, {
        productsCount: Set<string>;
        totalSales: number;
        revenue: number;
      }>();

      orderItems.forEach(item => {
        // Product aggregation
        if (item.product_id) {
          const existing = productSales.get(item.product_id) || {
            productId: item.product_id,
            productName: item.product_name || 'Unknown',
            category: item.category || 'Uncategorized',
            quantitySold: 0,
            revenue: 0,
            orderCount: 0
          };

          existing.quantitySold += item.quantity || 0;
          existing.revenue += item.total_price || 0;
          existing.orderCount += 1;

          productSales.set(item.product_id, existing);
        }

        // Category aggregation
        const category = item.category || 'Uncategorized';
        const catExisting = categorySales.get(category) || {
          productsCount: new Set<string>(),
          totalSales: 0,
          revenue: 0
        };

        if (item.product_id) {
          catExisting.productsCount.add(item.product_id);
        }
        catExisting.totalSales += item.quantity || 0;
        catExisting.revenue += item.total_price || 0;

        categorySales.set(category, catExisting);
      });

      // ✅ BUG FIX: Get product ratings
      const productIds = Array.from(productSales.keys());
      const ratingMap = new Map<string, { sum: number; count: number }>();

      if (productIds.length > 0) {
        const { data: ratings } = await supabaseClient
          .from('product_ratings')
          .select('product_id, rating')
          .in('product_id', productIds);

        ratings?.forEach(r => {
          const existing = ratingMap.get(r.product_id) || { sum: 0, count: 0 };
          existing.sum += r.rating;
          existing.count += 1;
          ratingMap.set(r.product_id, existing);
        });
      }

      // ✅ BUG FIX: Calculate top selling products with ratings
      const topSellingProducts = Array.from(productSales.values())
        .map(product => {
          const rating = ratingMap.get(product.productId);
          return {
            productId: product.productId,
            productName: product.productName,
            category: product.category,
            quantitySold: product.quantitySold,
            revenue: product.revenue,
            averageRating: rating && rating.count > 0
              ? parseFloat((rating.sum / rating.count).toFixed(1))
              : 0
          };
        })
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

      // ✅ BUG FIX: Format category performance
      const categoryPerformance = Array.from(categorySales.entries()).map(([category, data]) => ({
        category,
        productsCount: data.productsCount.size,
        totalSales: data.totalSales,
        revenue: data.revenue
      }));

      // ✅ BUG FIX: Get low stock products
      const lowStockProducts = products?.filter(p => 
        p.stock_quantity <= (p.min_stock_level || 0)
      ).map(p => ({
        productId: p.id,
        productName: p.name,
        currentStock: p.stock_quantity,
        minStock: p.min_stock_level || 0
      })) || [];

      const totalSales = orderItems.reduce((sum, item) => sum + (item.quantity || 0), 0);

      return {
        totalProducts,
        totalSales,
        topSellingProducts,
        categoryPerformance,
        lowStockProducts,
      };
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Unexpected error in getProductAnalytics for user ${userId}:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while fetching product analytics',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  async generateReport(userId: string, reportData: any, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const reportId = `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const reportType = reportData.type || 'daily';
      const reportSource = reportData.source || 'all'; // 'all', 'auctions', 'live_stream', 'regular'
      const format = reportData.format || 'pdf';

      // Generate report data based on type and source
      let reportContent: any = {};

      if (reportSource === 'auctions' || reportSource === 'all') {
        // Fetch auction data for the report
        const auctionAnalytics = await this.getAuctionAnalytics(
          userId,
          reportType,
          reportData.startDate,
          userToken
        );
        reportContent.auctionData = auctionAnalytics;
      }

      if (reportSource === 'live_stream' || reportSource === 'all') {
        // Fetch live stream data for the report
        const liveStreamAnalytics = await this.getLiveStreamingAnalytics(
          userId,
          reportType,
          reportData.startDate,
          userToken
        );
        reportContent.liveStreamData = liveStreamAnalytics;
      }

      if (reportSource === 'regular' || reportSource === 'all') {
        // Fetch regular sales data
        const regularAnalytics = await this.getAnalytics(
          userId,
          reportType,
          reportData.startDate,
          userToken
        );
        reportContent.regularData = regularAnalytics;
      }

      // Save report metadata to database
      await supabaseClient.from('analytics_reports').insert({
        id: reportId,
        user_id: userId,
        report_type: reportType,
        report_source: reportSource,
        format,
        status: 'processing',
        created_at: new Date().toISOString(),
        data: reportContent,
      });

      // ✅ PHASE 4 FIX: Generate actual file and upload to storage
      try {
        const filePath = await this.generateReportFile(reportContent, format, reportId);
        const downloadUrl = await this.uploadReportToStorage(filePath, reportId, userId, format);

        // Update report status to completed
        await supabaseClient
          .from('analytics_reports')
          .update({
            status: 'completed',
            download_url: downloadUrl,
            updated_at: new Date().toISOString(),
          })
          .eq('id', reportId);

        // Cleanup temporary file
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }

        return {
          reportId,
          downloadUrl,
          status: 'completed',
          message: 'Report generated successfully.',
        };
      } catch (fileError) {
        console.error(`[Analytics] Error generating report file for ${reportId}:`, fileError);
        
        // Update report status to failed
        await supabaseClient
          .from('analytics_reports')
          .update({
            status: 'failed',
            error_message: fileError instanceof Error ? fileError.message : 'Unknown error',
            updated_at: new Date().toISOString(),
          })
          .eq('id', reportId);

        throw new AnalyticsError(
          `Failed to generate report file: ${fileError instanceof Error ? fileError.message : 'Unknown error'}`,
          'REPORT_GENERATION_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Error generating report for user ${userId}:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while generating report',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Generate report file based on format
   * ✅ PHASE 4 FIX: Actual file generation
   */
  private async generateReportFile(data: any, format: string, reportId: string): Promise<string> {
    const tempDir = os.tmpdir();
    const fileName = `${reportId}.${format === 'excel' ? 'xlsx' : format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : 'json'}`;
    const filePath = path.join(tempDir, fileName);

    switch (format) {
      case 'json':
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        break;

      case 'csv':
        const csvContent = this.convertToCSV(data);
        fs.writeFileSync(filePath, csvContent, 'utf-8');
        break;

      case 'excel':
        // ✅ IMPLEMENTATION: Generate actual Excel file using ExcelJS
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Fretiko Analytics';
        workbook.created = new Date();
        
        // Create main report worksheet
        const worksheet = workbook.addWorksheet('Analytics Report');
        this.populateExcelWorksheet(worksheet, data);
        
        // Save the workbook
        await workbook.xlsx.writeFile(filePath);
        break;

      case 'pdf':
        // ✅ IMPLEMENTATION: Generate actual PDF file using PDFKit
        await new Promise<void>((resolve, reject) => {
          const doc = new PDFDocument({ margin: 50 });
          const stream = fs.createWriteStream(filePath);
          
          doc.pipe(stream);
          
          // Populate PDF with data
          this.populatePDFDocument(doc, data);
          
          doc.end();
          
          stream.on('finish', () => {
            resolve();
          });
          
          stream.on('error', (error) => {
            reject(new AnalyticsError(
              `Failed to generate PDF: ${error.message}`,
              'PDF_GENERATION_ERROR',
              HttpStatus.INTERNAL_SERVER_ERROR
            ));
          });
        });
        break;

      default:
        throw new AnalyticsError(
          `Unsupported format: ${format}. Supported formats: json, csv, excel, pdf`,
          'UNSUPPORTED_FORMAT',
          HttpStatus.BAD_REQUEST
        );
    }

    return filePath;
  }

  /**
   * Convert data to CSV format
   * ✅ PHASE 4 FIX: CSV export functionality
   */
  private convertToCSV(data: any): string {
    const lines: string[] = [];
    
    // Helper to escape CSV values
    const escapeCSV = (value: any): string => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Flatten data structure for CSV
    const flattenData = (obj: any, prefix = ''): any => {
      const result: any = {};
      for (const key in obj) {
        const value = obj[key];
        const newKey = prefix ? `${prefix}.${key}` : key;
        
        if (value === null || value === undefined) {
          result[newKey] = '';
        } else if (Array.isArray(value)) {
          // For arrays, create rows for each item
          value.forEach((item, index) => {
            if (typeof item === 'object') {
              Object.assign(result, flattenData(item, `${newKey}[${index}]`));
            } else {
              result[`${newKey}[${index}]`] = item;
            }
          });
        } else if (typeof value === 'object' && !(value instanceof Date)) {
          Object.assign(result, flattenData(value, newKey));
        } else {
          result[newKey] = value;
        }
      }
      return result;
    };

    const flattened = flattenData(data);
    const keys = Object.keys(flattened);
    
    // Write header
    lines.push(keys.map(escapeCSV).join(','));
    
    // Write data row
    lines.push(keys.map(key => escapeCSV(flattened[key])).join(','));

    return lines.join('\n');
  }

  /**
   * Populate Excel worksheet with analytics data
   * ✅ IMPLEMENTATION: Excel generation helper
   */
  private populateExcelWorksheet(worksheet: any, data: any): void {
    // Add title
    worksheet.addRow(['Fretiko Analytics Report']);
    worksheet.mergeCells(1, 1, 1, 5);
    worksheet.getCell(1, 1).font = { size: 16, bold: true };
    worksheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.addRow([]); // Empty row

    // Helper function to add a section
    const addSection = (title: string, items: any) => {
      // Section header
      const headerRow = worksheet.addRow([title]);
      headerRow.font = { size: 14, bold: true };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
      };

      if (Array.isArray(items) && items.length > 0) {
        // Add headers if items are objects
        if (typeof items[0] === 'object') {
          const headers = Object.keys(items[0]);
          const headerRow = worksheet.addRow(headers);
          headerRow.font = { bold: true };
          headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF0F0F0' }
          };

          // Add data rows
          items.forEach((item: any) => {
            const values = headers.map(header => {
              const value = item[header];
              // Handle arrays and objects
              if (Array.isArray(value)) {
                return value.join(', ');
              }
              if (typeof value === 'object' && value !== null) {
                return JSON.stringify(value);
              }
              return value ?? '';
            });
            worksheet.addRow(values);
          });
        } else {
          // Simple array values
          items.forEach((item: any) => {
            worksheet.addRow([item]);
          });
        }
      } else if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
        // Object with key-value pairs
        Object.entries(items).forEach(([key, value]) => {
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            // Nested object - add as sub-section
            worksheet.addRow([key + ':']);
            worksheet.getRow(worksheet.rowCount).font = { bold: true };
            Object.entries(value as any).forEach(([nestedKey, nestedValue]) => {
              worksheet.addRow(['', nestedKey, nestedValue]);
            });
          } else {
            worksheet.addRow([key, Array.isArray(value) ? value.join(', ') : value]);
          }
        });
      } else {
        worksheet.addRow([String(items)]);
      }

      worksheet.addRow([]); // Empty row after section
    };

    // Add data sections
    if (data.regularData) {
      addSection('Regular Sales Data', data.regularData);
    }
    if (data.auctionData) {
      addSection('Auction Data', data.auctionData);
    }
    if (data.liveStreamData) {
      addSection('Live Stream Data', data.liveStreamData);
    }

    // If no sections, add all data
    if (!data.regularData && !data.auctionData && !data.liveStreamData) {
      Object.entries(data).forEach(([key, value]) => {
        addSection(key, value);
      });
    }

    // Auto-size columns
    worksheet.columns.forEach((column) => {
      if (column.header) {
        column.width = 15;
      }
    });

    // Add generated timestamp
    worksheet.addRow([]);
    worksheet.addRow(['Generated:', new Date().toLocaleString()]);
    worksheet.getRow(worksheet.rowCount - 1).font = { italic: true };
  }

  /**
   * Populate PDF document with analytics data
   * ✅ IMPLEMENTATION: PDF generation helper
   */
  private populatePDFDocument(doc: any, data: any): void {
    // Set up fonts
    const titleFont = 'Helvetica-Bold';
    const headingFont = 'Helvetica-Bold';
    const bodyFont = 'Helvetica';

    // Add title
    doc.font(titleFont)
      .fontSize(20)
      .text('Fretiko Analytics Report', { align: 'center' });

    doc.moveDown();
    doc.fontSize(10)
      .font(bodyFont)
      .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });

    doc.moveDown(2);

    // Helper function to add a section
    const addSection = (title: string, items: any) => {
      // Section title
      doc.font(headingFont)
        .fontSize(14)
        .text(title, { underline: true });

      doc.moveDown(0.5);

      if (Array.isArray(items) && items.length > 0) {
        if (typeof items[0] === 'object') {
          // Table format for object arrays
          const headers = Object.keys(items[0]);
          
          // Draw table header
          const tableTop = doc.y;
          const tableLeft = 50;
          const rowHeight = 20;
          const colWidth = (doc.page.width - 100) / headers.length;

          // Header row
          doc.font(headingFont).fontSize(10);
          headers.forEach((header, i) => {
            doc.text(header, tableLeft + i * colWidth, tableTop, {
              width: colWidth - 5,
              align: 'left'
            });
          });

          // Draw line under header
          doc.moveTo(tableLeft, tableTop + rowHeight)
            .lineTo(tableLeft + colWidth * headers.length, tableTop + rowHeight)
            .stroke();

          // Data rows
          doc.font(bodyFont).fontSize(9);
          items.slice(0, 50).forEach((item: any, rowIndex: number) => { // Limit to 50 rows
            const y = tableTop + rowHeight + (rowIndex * rowHeight);
            
            headers.forEach((header, colIndex) => {
              const value = item[header];
              let text = '';
              
              if (Array.isArray(value)) {
                text = value.join(', ');
              } else if (typeof value === 'object' && value !== null) {
                text = JSON.stringify(value);
              } else {
                text = String(value ?? '');
              }

              // Truncate long text
              if (text.length > 30) {
                text = text.substring(0, 27) + '...';
              }

              doc.text(text, tableLeft + colIndex * colWidth, y, {
                width: colWidth - 5,
                align: 'left'
              });
            });
          });

          doc.moveDown(1);
        } else {
          // Simple list
          doc.font(bodyFont).fontSize(10);
          items.slice(0, 100).forEach((item: any) => { // Limit to 100 items
            doc.text(`• ${String(item)}`, { indent: 20 });
          });
          doc.moveDown(0.5);
        }
      } else if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
        // Key-value pairs
        doc.font(bodyFont).fontSize(10);
        Object.entries(items).forEach(([key, value]) => {
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            doc.text(`${key}:`, { continued: false, indent: 20 });
            Object.entries(value as any).forEach(([nestedKey, nestedValue]) => {
              doc.text(`  ${nestedKey}: ${String(nestedValue)}`, { indent: 40 });
            });
          } else {
            const valueText = Array.isArray(value) 
              ? value.join(', ') 
              : String(value ?? '');
            doc.text(`${key}: ${valueText}`, { indent: 20 });
          }
        });
        doc.moveDown(0.5);
      } else {
        doc.font(bodyFont).fontSize(10).text(String(items ?? ''), { indent: 20 });
        doc.moveDown(0.5);
      }

      doc.moveDown(1);
    };

    // Add data sections
    if (data.regularData) {
      addSection('Regular Sales Data', data.regularData);
      doc.addPage(); // New page for next section
    }
    if (data.auctionData) {
      addSection('Auction Data', data.auctionData);
      doc.addPage();
    }
    if (data.liveStreamData) {
      addSection('Live Stream Data', data.liveStreamData);
    }

    // If no sections, add all data
    if (!data.regularData && !data.auctionData && !data.liveStreamData) {
      Object.entries(data).forEach(([key, value], index) => {
        if (index > 0) {
          doc.addPage();
        }
        addSection(key, value);
      });
    }
  }

  /**
   * Upload report file to Supabase Storage
   * ✅ PHASE 4 FIX: File storage implementation
   * 
   * NOTE: Storage bucket 'analytics-reports' must be created in Supabase dashboard or via CLI
   * Bucket should be public for download URLs to work
   */
  private async uploadReportToStorage(
    filePath: string,
    reportId: string,
    userId: string,
    format: string
  ): Promise<string> {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = `${userId}/${reportId}.${format === 'excel' ? 'xlsx' : format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : 'json'}`;
      
      // ✅ PHASE 4 FIX: Upload to Supabase Storage
      const { data, error } = await this.supabase.storage
        .from('analytics-reports')
        .upload(fileName, fileBuffer, {
          contentType: format === 'json' ? 'application/json' : 
                      format === 'csv' ? 'text/csv' :
                      format === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
                      'application/pdf',
          upsert: false
        });

      if (error) {
        // Check if bucket doesn't exist
        if (error.message?.includes('Bucket not found') || error.message?.includes('does not exist')) {
          console.error(`[Analytics] Storage bucket 'analytics-reports' does not exist. Please create it in Supabase dashboard.`);
          throw new AnalyticsError(
            'Storage bucket not configured. Please contact administrator.',
            'STORAGE_BUCKET_MISSING',
            HttpStatus.SERVICE_UNAVAILABLE
          );
        }
        
        console.error(`[Analytics] Error uploading report ${reportId} to storage:`, error);
        throw new AnalyticsError(
          `Failed to upload report to storage: ${error.message}`,
          'STORAGE_UPLOAD_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Get public URL
      const { data: urlData } = this.supabase.storage
        .from('analytics-reports')
        .getPublicUrl(fileName);

      return urlData.publicUrl;
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Unexpected error uploading report ${reportId} to storage:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while uploading report to storage',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  async getReports(userId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data: reports, error } = await supabaseClient
        .from('analytics_reports')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) {
        console.error(`[Analytics] Error fetching reports for user ${userId}:`, error);
        throw new AnalyticsError(
          `Failed to fetch reports: ${error.message}`,
          'REPORTS_FETCH_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      if (!reports || reports.length === 0) {
        return [];
      }

      return reports.map(report => ({
        id: report.id,
        title: this.getReportTitle(report.report_type, report.report_source),
        subtitle: `Generated ${new Date(report.created_at).toLocaleDateString()}`,
        status: report.status,
        createdAt: report.created_at,
        type: report.report_type,
        source: report.report_source,
        format: report.format,
        downloadUrl: report.download_url || `/api/analytics/reports/${report.id}/download`,
      }));
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Unexpected error in getReports for user ${userId}:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while fetching reports',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  private getReportTitle(type: string, source: string): string {
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    const sourceLabel = source === 'all' ? 'Sales'
      : source === 'auctions' ? 'Auction Performance'
      : source === 'live_stream' ? 'Live Stream Performance'
      : 'Sales';

    return `${typeLabel} ${sourceLabel} Report`;
  }

  async downloadReport(userId: string, reportId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ PHASE 4 FIX: Fetch actual report from database
      const { data: report, error } = await supabaseClient
        .from('analytics_reports')
        .select('*')
        .eq('id', reportId)
        .eq('user_id', userId)
        .single();

      if (error || !report) {
        throw new AnalyticsError(
          'Report not found or access denied',
          'REPORT_NOT_FOUND',
          HttpStatus.NOT_FOUND
        );
      }

      if (report.status !== 'completed') {
        throw new AnalyticsError(
          `Report is still ${report.status}. Please wait for it to complete.`,
          'REPORT_NOT_READY',
          HttpStatus.ACCEPTED
        );
      }

      if (!report.download_url) {
        throw new AnalyticsError(
          'Report download URL is not available',
          'DOWNLOAD_URL_MISSING',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      return {
        downloadUrl: report.download_url,
        reportId: report.id,
        format: report.format,
        generatedAt: report.created_at,
        expiresAt: report.expires_at,
      };
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Error downloading report ${reportId} for user ${userId}:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while downloading report',
        'DOWNLOAD_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get comprehensive live streaming analytics
   */
  async getLiveStreamingAnalytics(userId: string, period: string, date?: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period, date);

      // 1. Get live streams performance
      const { data: liveStreams, error: streamsError } = await supabaseClient
        .from('live_streams')
        .select(`
          id,
          title,
          stream_type,
          status,
          viewer_count,
          total_viewers,
          total_sales,
          created_at,
          started_at,
          ended_at,
          live_stream_transactions(count),
          live_stream_gifts(total_amount),
          live_stream_comments(count),
          live_stream_reactions(count)
        `)
        .eq('vendor_id', userId)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end)
        .order('created_at', { ascending: false });

      // 2. Get detailed analytics from live_stream_analytics
      const { data: streamAnalytics, error: analyticsError } = await supabaseClient
        .from('live_stream_analytics')
        .select('*')
        .in('stream_id', liveStreams?.map(s => s.id) || [])
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      // 3. Aggregate metrics
      let totalStreams = 0;
      let totalLiveRevenue = 0;
      let totalViewers = 0;
      let totalEngagements = 0;
      let totalGifts = 0;
      let totalStreamDuration = 0;
      let averageViewerCount = 0;

      if (!streamsError && liveStreams) {
        totalStreams = liveStreams.length;
        totalLiveRevenue = liveStreams.reduce((sum, stream) => sum + (stream.total_sales || 0), 0);
        totalViewers = liveStreams.reduce((sum, stream) => sum + (stream.total_viewers || 0), 0);

        // Calculate engagement metrics
        liveStreams.forEach(stream => {
          const comments = stream.live_stream_comments?.[0]?.count || 0;
          const reactions = stream.live_stream_reactions?.[0]?.count || 0;
          const gifts = stream.live_stream_gifts?.[0]?.total_amount || 0;

          totalEngagements += comments + reactions;
          totalGifts += gifts;

          // Calculate stream duration
          if (stream.started_at && stream.ended_at) {
            const duration = new Date(stream.ended_at).getTime() - new Date(stream.started_at).getTime();
            totalStreamDuration += duration / (1000 * 60); // minutes
          }
        });

        averageViewerCount = totalStreams > 0 ? totalViewers / totalStreams : 0;
      }

      // 4. Get current active streams
      const { data: activeStreams, error: activeError } = await supabaseClient
        .from('live_streams')
        .select('id, title, viewer_count, total_sales')
        .eq('vendor_id', userId)
        .eq('status', 'live');

      // 5. Calculate conversion metrics
      const totalTransactions = await this.getTotalLiveTransactions(userId, dateRange, supabaseClient);
      const conversionRate = totalViewers > 0 ? (totalTransactions / totalViewers) * 100 : 0;

      // 6. Generate performance insights
      const insights = this.generateLiveStreamingInsights({
        totalStreams,
        totalViewers,
        totalLiveRevenue,
        totalEngagements,
        conversionRate,
        averageViewerCount,
      });

      return {
        period,
        date: date || new Date().toISOString().split('T')[0],
        totalStreams,
        totalLiveRevenue,
        totalViewers,
        totalEngagements,
        totalGifts,
        averageViewerCount,
        totalStreamDuration,
        conversionRate,
        activeStreamsCount: activeStreams?.length || 0,
        currentActiveStreams: activeStreams || [],
        insights,
        chartData: this.generateLiveStreamingChartData(liveStreams, streamAnalytics, period),
        trends: {
          viewersChange: 15.2, // Mock - calculate from previous period
          revenueChange: 8.7,
          engagementChange: 12.1,
        },
      };

    } catch (error) {
      console.error('Error fetching live streaming analytics:', error);
      throw error;
    }
  }

  /**
   * Get total live transactions for conversion calculation
   */
  private async getTotalLiveTransactions(userId: string, dateRange: any, supabaseClient: any): Promise<number> {
    const { data, error } = await supabaseClient
      .from('live_stream_transactions')
      .select('id')
      .eq('vendor_id', userId)
      .gte('created_at', dateRange.start)
      .lte('created_at', dateRange.end);

    return data?.length || 0;
  }

  /**
   * Generate insights for live streaming performance
   */
  private generateLiveStreamingInsights(metrics: any): string[] {
    const insights: string[] = [];

    if (metrics.conversionRate > 5) {
      insights.push(`Excellent conversion rate of ${metrics.conversionRate.toFixed(1)}% - above industry average`);
    } else if (metrics.conversionRate > 2) {
      insights.push(`Good conversion rate of ${metrics.conversionRate.toFixed(1)}% - room for improvement`);
    } else {
      insights.push(`Low conversion rate of ${metrics.conversionRate.toFixed(1)}% - consider improving engagement`);
    }

    if (metrics.averageViewerCount > 100) {
      insights.push(`Strong audience engagement with ${Math.round(metrics.averageViewerCount)} average viewers`);
    } else {
      insights.push(`Growing audience - current average of ${Math.round(metrics.averageViewerCount)} viewers per stream`);
    }

    if (metrics.totalEngagements / metrics.totalViewers > 0.3) {
      insights.push(`High engagement rate - viewers are actively participating`);
    } else {
      insights.push(`Increase engagement with interactive content and responses to comments`);
    }

    return insights;
  }

  /**
   * Generate chart data for live streaming analytics
   */
  private generateLiveStreamingChartData(streams: any[], analytics: any[], period: string): any {
    // Prepare data arrays from real streams
    const viewerData: Array<{ date: string; value: number }> = [];
    const revenueData: Array<{ date: string; value: number }> = [];
    const engagementData: Array<{ date: string; value: number }> = [];

    // Extract real data from streams
    (streams || []).forEach(stream => {
      const date = stream.created_at || stream.started_at;
      if (date) {
        viewerData.push({ date, value: stream.viewer_count || stream.max_viewers || 0 });
        revenueData.push({ date, value: stream.total_sales || 0 });
        
        // Calculate engagement from comments and reactions
        const engagement = (stream.comment_count || 0) + (stream.reaction_count || 0);
        engagementData.push({ date, value: engagement });
      }
    });

    // Group by period using the same helper function
    const groupedViewers = this.groupByPeriod(viewerData, period as any);
    const groupedRevenue = this.groupByPeriod(revenueData, period as any);
    const groupedEngagement = this.groupByPeriod(engagementData, period as any);

    return {
      labels: groupedViewers.map(g => g.label),
      viewers: groupedViewers.map(g => g.value),
      revenue: groupedRevenue.map(g => g.value),
      engagement: groupedEngagement.map(g => g.value),
    };
  }

  async getRealTimeAnalytics(userId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const today = new Date().toISOString().split('T')[0];
      let activeOrders = 0;
      let todayRevenue = 0;
      let pendingOrders = 0;
      let completedOrders = 0;
      let totalTodayOrders = 0;

      // 1. Get today's regular orders
      const { data: todayRegularOrders, error: ordersError } = await supabaseClient
        .from('orders')
        .select('*')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      if (!ordersError && todayRegularOrders) {
        activeOrders += todayRegularOrders.filter(order =>
          ['processing', 'ready_for_pickup', 'out_for_delivery'].includes(order.status)
        ).length;
        todayRevenue += todayRegularOrders.reduce((sum, order) => sum + (order.total || 0), 0);
        pendingOrders += todayRegularOrders.filter(order => order.status === 'pending').length;
        completedOrders += todayRegularOrders.filter(order => order.status === 'delivered').length;
        totalTodayOrders += todayRegularOrders.length;
      }

      // 2. Get today's live stream transactions
      const { data: todayLiveTransactions, error: liveError } = await supabaseClient
        .from('live_stream_transactions')
        .select('*')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      if (!liveError && todayLiveTransactions) {
        activeOrders += todayLiveTransactions.filter(tx =>
          ['paid', 'escrow'].includes(tx.status)
        ).length;
        todayRevenue += todayLiveTransactions.reduce((sum, tx) => sum + (tx.total_amount || 0), 0);
        pendingOrders += todayLiveTransactions.filter(tx => tx.status === 'pending').length;
        completedOrders += todayLiveTransactions.filter(tx => tx.status === 'completed').length;
        totalTodayOrders += todayLiveTransactions.length;
      }

      // 3. Get today's auction sales
      const { data: todayAuctionSales, error: auctionError } = await supabaseClient
        .from('auction_sales')
        .select('*')
        .eq('seller_id', userId)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      if (!auctionError && todayAuctionSales) {
        activeOrders += todayAuctionSales.filter(sale => sale.payment_status === 'processing').length;
        todayRevenue += todayAuctionSales.reduce((sum, sale) => sum + (sale.total_amount || 0), 0);
        pendingOrders += todayAuctionSales.filter(sale => sale.payment_status === 'pending').length;
        completedOrders += todayAuctionSales.filter(sale => sale.payment_status === 'completed').length;
        totalTodayOrders += todayAuctionSales.length;
      }

      // 4. Get today's service bookings
      const { data: todayServiceBookings, error: bookingError } = await supabaseClient
        .from('service_bookings')
        .select(`
          *,
          service:services!inner(vendor_id)
        `)
        .eq('service.vendor_id', userId)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lt('created_at', `${today}T23:59:59.999Z`);

      if (!bookingError && todayServiceBookings) {
        activeOrders += todayServiceBookings.filter(booking =>
          ['confirmed', 'in_progress'].includes(booking.status)
        ).length;
        todayRevenue += todayServiceBookings.reduce((sum, booking) => sum + (booking.total_price || 0), 0);
        pendingOrders += todayServiceBookings.filter(booking => booking.status === 'pending').length;
        completedOrders += todayServiceBookings.filter(booking => booking.status === 'completed').length;
        totalTodayOrders += todayServiceBookings.length;
      }

      // ✅ PHASE 5 FIX: Calculate online customers from recent active orders
      const recentOrderCustomers = new Set([
        ...(todayRegularOrders || []).map(o => o.customer_id || o.buyer_id).filter(Boolean),
        ...(todayLiveTransactions || []).map(t => t.buyer_id).filter(Boolean),
        ...(todayAuctionSales || []).map(a => a.buyer_id).filter(Boolean),
        ...(todayServiceBookings || []).map(b => b.customer_id).filter(Boolean),
      ]);
      const onlineCustomers = recentOrderCustomers.size;
      
      const completionRate = totalTodayOrders > 0 ? (completedOrders / totalTodayOrders) * 100 : 0;

      return {
        activeOrders,
        todayRevenue,
        onlineCustomers,
        pendingOrders,
        completionRate,
      };
    } catch (error) {
      console.error('Error fetching real-time analytics:', error);
      throw error;
    }
  }

  async getAnalyticsComparison(userId: string, period: string, currentDate: string, comparisonDate: string, userToken?: string) {
    // Get analytics for both periods
    const current = await this.getAnalytics(userId, period, currentDate, userToken);
    const comparison = await this.getAnalytics(userId, period, comparisonDate, userToken);

    // Calculate changes
    const changes = {
      revenueChange: this.calculatePercentageChange(comparison.revenue, current.revenue),
      ordersChange: this.calculatePercentageChange(comparison.ordersProcessed, current.ordersProcessed),
      customersChange: this.calculatePercentageChange(comparison.activeCustomers, current.activeCustomers),
      completionRateChange: this.calculatePercentageChange(comparison.completionRate, current.completionRate),
    };

    return {
      current,
      comparison,
      changes,
    };
  }

  private getDateRange(period: string, date?: string) {
    const targetDate = date ? new Date(date) : new Date();

    switch (period) {
      case 'daily':
        const dayStart = new Date(targetDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(targetDate);
        dayEnd.setHours(23, 59, 59, 999);
        return {
          start: dayStart.toISOString(),
          end: dayEnd.toISOString(),
        };

      case 'weekly':
        const weekStart = new Date(targetDate);
        weekStart.setDate(targetDate.getDate() - targetDate.getDay());
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);
        return {
          start: weekStart.toISOString(),
          end: weekEnd.toISOString(),
        };

      case 'monthly':
        const monthStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
        const monthEnd = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
        monthEnd.setHours(23, 59, 59, 999);
        return {
          start: monthStart.toISOString(),
          end: monthEnd.toISOString(),
        };

      default:
        return this.getDateRange('daily', date);
    }
  }

  /**
   * Apply 90-day historical limit to date ranges for performance
   * ✅ PERFORMANCE FIX: New helper method
   */
  private applyHistoricalDateLimit(dateRange: { start: string; end: string }): { start: string; end: string } {
    const maxDateRange = new Date();
    maxDateRange.setDate(maxDateRange.getDate() - this.MAX_HISTORICAL_DAYS);
    maxDateRange.setHours(0, 0, 0, 0);

    const requestedStart = new Date(dateRange.start);
    const effectiveStart = requestedStart < maxDateRange ? maxDateRange.toISOString() : dateRange.start;

    return {
      start: effectiveStart,
      end: dateRange.end
    };
  }

  /**
   * Cache helper methods
   * ✅ PERFORMANCE FIX: Caching layer implementation
   */
  private getCacheKey(method: string, params: any): string {
    return `${method}:${JSON.stringify(params)}`;
  }

  private getCachedData(key: string): any | null {
    const cached = this.analyticsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    this.analyticsCache.delete(key);
    return null;
  }

  private setCachedData(key: string, data: any, ttl: number): void {
    this.analyticsCache.set(key, {
      data,
      expiresAt: Date.now() + ttl
    });
  }

  private cleanupExpiredCache(): void {
    const now = Date.now();
    // ✅ FIX: Use Array.from() to iterate Map entries (fixes TypeScript iterator issue)
    for (const [key, entry] of Array.from(this.analyticsCache.entries())) {
      if (entry.expiresAt <= now) {
        this.analyticsCache.delete(key);
      }
    }
  }

  /**
   * Invalidate cache for a specific user or all cache
   * ✅ PERFORMANCE FIX: Cache invalidation method
   */
  public invalidateCache(userId?: string): void {
    if (userId) {
      // Invalidate all cache entries for this user
      // ✅ FIX: Use Array.from() to iterate Map entries (fixes TypeScript iterator issue)
      for (const [key] of Array.from(this.analyticsCache.entries())) {
        if (key.includes(userId)) {
          this.analyticsCache.delete(key);
        }
      }
    } else {
      // Clear all cache
      this.analyticsCache.clear();
    }
  }

  /**
   * Retry operation with exponential backoff for transient failures
   * ✅ ERROR HANDLING FIX: Retry logic for transient errors
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    initialDelay: number = 1000
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        
        // Don't retry on business logic errors or non-transient errors
        const isTransientError = this.isTransientError(error);
        if (!isTransientError) {
          throw error;
        }
        
        // Don't retry on last attempt
        if (attempt === maxRetries) {
          break;
        }
        
        // Exponential backoff: 1s, 2s, 4s
        const delay = initialDelay * Math.pow(2, attempt);
        console.warn(`[Analytics] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms delay`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError;
  }

  /**
   * Check if error is transient and should be retried
   * ✅ ERROR HANDLING FIX: Helper method
   */
  private isTransientError(error: any): boolean {
    // Supabase transient error codes
    const transientErrorCodes = [
      'PGRST116', // Not found (can be transient in race conditions)
      'PGRST301', // Connection error
      'PGRST302', // Timeout
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNREFUSED'
    ];

    // Check error code
    if (error?.code && transientErrorCodes.includes(error.code)) {
      return true;
    }

    // Check error message for network-related errors
    const errorMessage = error?.message?.toLowerCase() || '';
    const transientKeywords = ['timeout', 'network', 'connection', 'temporary', 'unavailable'];
    
    return transientKeywords.some(keyword => errorMessage.includes(keyword));
  }

  private getPreviousDateRange(period: string, date?: string) {
    const targetDate = date ? new Date(date) : new Date();

    switch (period) {
      case 'daily':
        const prevDay = new Date(targetDate);
        prevDay.setDate(targetDate.getDate() - 1);
        prevDay.setHours(0, 0, 0, 0);
        const prevDayEnd = new Date(prevDay);
        prevDayEnd.setHours(23, 59, 59, 999);
        return {
          start: prevDay.toISOString(),
          end: prevDayEnd.toISOString(),
        };

      case 'weekly':
        const prevWeekStart = new Date(targetDate);
        prevWeekStart.setDate(targetDate.getDate() - targetDate.getDay() - 7);
        prevWeekStart.setHours(0, 0, 0, 0);
        const prevWeekEnd = new Date(prevWeekStart);
        prevWeekEnd.setDate(prevWeekStart.getDate() + 6);
        prevWeekEnd.setHours(23, 59, 59, 999);
        return {
          start: prevWeekStart.toISOString(),
          end: prevWeekEnd.toISOString(),
        };

      case 'monthly':
        const prevMonthStart = new Date(targetDate.getFullYear(), targetDate.getMonth() - 1, 1);
        const prevMonthEnd = new Date(targetDate.getFullYear(), targetDate.getMonth(), 0);
        prevMonthEnd.setHours(23, 59, 59, 999);
        return {
          start: prevMonthStart.toISOString(),
          end: prevMonthEnd.toISOString(),
        };

      default:
        return this.getPreviousDateRange('daily', date);
    }
  }

  private generateChartData(allData: any, period: string) {
    const { orders, liveTransactions, auctionSales, serviceBookings } = allData;
    
    // Combine all data sources into unified format
    const allTransactions: Array<{ date: string; value: number }> = [
      ...(orders || []).map(o => ({ date: o.created_at, value: o.total || 0 })),
      ...(liveTransactions || []).map(t => ({ date: t.created_at, value: t.total_amount || 0 })),
      ...(auctionSales || []).map(a => ({ date: a.created_at, value: a.total_amount || 0 })),
      ...(serviceBookings || []).map(b => ({ date: b.created_at, value: b.total_price || 0 })),
    ];
    
    // Group by time period
    const grouped = this.groupByPeriod(allTransactions, period as any);
    
    return {
      labels: grouped.map(g => g.label),
      values: grouped.map(g => g.value),
    };
  }

  private groupByPeriod(
    transactions: Array<{ date: string; value: number }>,
    period: 'daily' | 'weekly' | 'monthly'
  ): Array<{ label: string; value: number }> {
    if (!transactions || transactions.length === 0) {
      return this.getEmptyPeriodData(period);
    }

    const grouped = new Map<string, number>();

    transactions.forEach(tx => {
      const date = new Date(tx.date);
      let key: string;

      if (period === 'daily') {
        // Group by hour (0-23)
        const hour = date.getHours();
        key = `${hour}`;
      } else if (period === 'weekly') {
        // Group by day of week
        const dayIndex = date.getDay();
        key = `${dayIndex}`;
      } else {
        // Group by week of month
        const weekOfMonth = Math.ceil(date.getDate() / 7);
        key = `${weekOfMonth}`;
      }

      grouped.set(key, (grouped.get(key) || 0) + tx.value);
    });

    // Convert to array and sort
    const result: Array<{ label: string; value: number; sortKey: number }> = [];
    
    if (period === 'daily') {
      // Ensure all 24 hours are present
      for (let hour = 0; hour < 24; hour++) {
        result.push({
          label: `${hour}:00`,
          value: grouped.get(`${hour}`) || 0,
          sortKey: hour
        });
      }
    } else if (period === 'weekly') {
      // Ensure all 7 days are present
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        result.push({
          label: days[dayIndex],
          value: grouped.get(`${dayIndex}`) || 0,
          sortKey: dayIndex
        });
      }
    } else {
      // Ensure all 4 weeks are present
      for (let week = 1; week <= 4; week++) {
        result.push({
          label: `Week ${week}`,
          value: grouped.get(`${week}`) || 0,
          sortKey: week
        });
      }
    }

    return result.sort((a, b) => a.sortKey - b.sortKey).map(({ label, value }) => ({ label, value }));
  }

  private getEmptyPeriodData(period: 'daily' | 'weekly' | 'monthly'): Array<{ label: string; value: number }> {
    if (period === 'daily') {
      return Array.from({ length: 24 }, (_, i) => ({ label: `${i}:00`, value: 0 }));
    } else if (period === 'weekly') {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return days.map(day => ({ label: day, value: 0 }));
    } else {
      return Array.from({ length: 4 }, (_, i) => ({ label: `Week ${i + 1}`, value: 0 }));
    }
  }

  private calculatePercentageChange(oldValue: number, newValue: number): number {
    if (oldValue === 0) {
      return newValue > 0 ? 100 : 0;
    }
    return ((newValue - oldValue) / oldValue) * 100;
  }

  private async calculateTrends(
    userId: string,
    period: string,
    date: string | undefined,
    currentMetrics: { ordersProcessed: number; revenue: number; activeCustomers: number },
    supabaseClient: any
  ) {
    try {
      // Get previous period date range
      const previousDateRange = this.getPreviousDateRange(period, date);

      // Fetch previous period data in parallel
      const [prevOrders, prevLiveTransactions, prevAuctionSales, prevServiceBookings, prevGifts] = 
        await Promise.all([
          supabaseClient.from('orders').select('*')
            .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
            .gte('created_at', previousDateRange.start)
            .lte('created_at', previousDateRange.end),
          supabaseClient.from('live_stream_transactions').select('*')
            .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
            .gte('created_at', previousDateRange.start)
            .lte('created_at', previousDateRange.end),
          supabaseClient.from('auction_sales').select('*')
            .eq('seller_id', userId)
            .gte('created_at', previousDateRange.start)
            .lte('created_at', previousDateRange.end),
          supabaseClient.from('service_bookings').select(`*, service:services!inner(vendor_id)`)
            .eq('service.vendor_id', userId)
            .gte('created_at', previousDateRange.start)
            .lte('created_at', previousDateRange.end),
          supabaseClient.from('live_stream_gifts').select(`*, stream:live_streams!inner(vendor_id)`)
            .eq('stream.vendor_id', userId)
            .gte('created_at', previousDateRange.start)
            .lte('created_at', previousDateRange.end),
        ]);

      // Calculate previous period metrics
      const prevOrdersCount = (prevOrders.data || []).length + 
                              (prevLiveTransactions.data || []).length + 
                              (prevAuctionSales.data || []).length + 
                              (prevServiceBookings.data || []).length;

      const prevRevenue = (prevOrders.data || []).reduce((sum, o) => sum + (o.total || 0), 0) +
                          (prevLiveTransactions.data || []).reduce((sum, t) => sum + (t.total_amount || 0), 0) +
                          (prevAuctionSales.data || []).reduce((sum, a) => sum + (a.total_amount || 0), 0) +
                          (prevServiceBookings.data || []).reduce((sum, b) => sum + (b.total_price || 0), 0) +
                          (prevGifts.data || []).reduce((sum, g) => sum + (g.total_amount || 0), 0);

      const prevCustomers = new Set([
        ...(prevOrders.data || []).map(o => o.customer_id),
        ...(prevLiveTransactions.data || []).map(t => t.buyer_id),
        ...(prevAuctionSales.data || []).map(a => a.buyer_id),
        ...(prevServiceBookings.data || []).map(b => b.customer_id),
        ...(prevGifts.data || []).map(g => g.sender_id),
      ].filter(Boolean)).size;

      // Calculate percentage changes
      return {
        ordersChange: this.calculatePercentageChange(prevOrdersCount, currentMetrics.ordersProcessed),
        revenueChange: this.calculatePercentageChange(prevRevenue, currentMetrics.revenue),
        customersChange: this.calculatePercentageChange(prevCustomers, currentMetrics.activeCustomers),
      };
    } catch (error) {
      console.error('Error calculating trends:', error);
      // Return zero changes if calculation fails
      return {
        ordersChange: 0,
        revenueChange: 0,
        customersChange: 0,
      };
    }
  }

  private async calculateCustomerSatisfaction(userId: string, supabaseClient: any): Promise<number> {
    try {
      // Get post-purchase ratings from order_item_ratings for vendor's orders
      const { data: orderRatings } = await supabaseClient
        .from('order_item_ratings')
        .select(`
          rating,
          orders!inner(vendor_id)
        `)
        .eq('orders.vendor_id', userId);

      if (!orderRatings || orderRatings.length === 0) {
        return 0; // No ratings yet
      }

      const totalRating = orderRatings.reduce((sum, rating) => sum + (rating.rating || 0), 0);
      const avgRating = totalRating / orderRatings.length;

      return parseFloat(avgRating.toFixed(1));
    } catch (error) {
      console.error('Error calculating customer satisfaction:', error);
      return 0;
    }
  }

  private async getTopSellingItems(userId: string, supabaseClient: any) {
    try {
      // Get order items from the last 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      
      const { data: orderItems } = await supabaseClient
        .from('order_items')
        .select(`
          *,
          orders!inner(vendor_id, created_at),
          products(id, name)
        `)
        .eq('orders.vendor_id', userId)
        .gte('orders.created_at', thirtyDaysAgo);

      // Aggregate by product
      const productSales = new Map<string, { name: string; quantity: number; revenue: number }>();

      (orderItems || []).forEach(item => {
        const productId = item.product_id;
        if (!productId) return; // Skip service items
        
        const productName = item.products?.name || item.name || 'Unknown Product';
        const quantity = item.quantity || 0;
        const revenue = item.price * quantity;

        if (productSales.has(productId)) {
          const existing = productSales.get(productId)!;
          existing.quantity += quantity;
          existing.revenue += revenue;
        } else {
          productSales.set(productId, { name: productName, quantity, revenue });
        }
      });

      // Sort by revenue and get top 5
      const topItems = Array.from(productSales.entries())
        .map(([id, data]) => ({ id, ...data }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5)
        .map(item => ({
          id: item.id,
          name: item.name,
          quantitySold: item.quantity,
          revenue: item.revenue,
        }));

      return topItems.length > 0 ? topItems : [];
    } catch (error) {
      console.error('Error fetching top selling items:', error);
      return [];
    }
  }

  private groupRevenueByDay(orders: any[]) {
    // Simplified revenue grouping
    const grouped = {};
    orders?.forEach(order => {
      const date = order.created_at.split('T')[0];
      grouped[date] = (grouped[date] || 0) + order.total;
    });

    return Object.entries(grouped).map(([date, revenue]) => ({ date, revenue }));
  }

  /**
   * Real-time analytics data aggregation methods
   */

  /**
   * Update live stream analytics in real-time
   * ✅ PHASE 6 FIX: Use atomic RPC function to prevent race conditions
   */
  async updateLiveStreamAnalytics(streamId: string, analyticsData: {
    viewerJoin?: boolean;
    viewerLeave?: boolean;
    comment?: boolean;
    reaction?: boolean;
    gift?: { amount: number };
    purchase?: { amount: number };
    engagement?: string;
  }) {
    try {
      // ✅ PHASE 6 FIX: Use atomic RPC function instead of separate queries
      const { data, error } = await this.serviceSupabase.rpc('update_live_stream_analytics_atomic', {
        p_stream_id: streamId,
        p_viewer_join: analyticsData.viewerJoin || false,
        p_viewer_join_count: 0, // For single events, use boolean flag
        p_viewer_leave: analyticsData.viewerLeave || false,
        p_viewer_leave_count: 0, // For single events, use boolean flag
        p_comment: analyticsData.comment || false,
        p_comment_count: 0, // For single events, use boolean flag
        p_reaction: analyticsData.reaction || false,
        p_reaction_count: 0, // For single events, use boolean flag
        p_gift_amount: analyticsData.gift?.amount || 0,
        p_purchase_amount: analyticsData.purchase?.amount || 0
      });

      if (error) {
        console.error(`[Analytics] Error updating live stream analytics for stream ${streamId}:`, error);
        throw new AnalyticsError(
          `Failed to update live stream analytics: ${error.message}`,
          'ANALYTICS_UPDATE_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      return data;
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Unexpected error updating live stream analytics for stream ${streamId}:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while updating live stream analytics',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * GET /analytics/auctions
   * Get comprehensive auction analytics for a vendor
   */
  async getAuctionAnalytics(userId: string, period: string, date?: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period, date);

      // 1. Get all auctions for the user in the date range
      const { data: auctions, error: auctionsError } = await supabaseClient
        .from('auctions')
        .select(`
          id,
          title,
          category_id,
          status,
          current_bid,
          winning_bid,
          total_bids,
          winner_id,
          reserve_price,
          commission_rate,
          created_at,
          start_time,
          end_time
        `)
        .eq('seller_id', userId)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end)
        .order('created_at', { ascending: false });

      if (auctionsError) {
        console.error('Error fetching auctions:', auctionsError);
        throw auctionsError;
      }

      // 1a. Fetch categories to map category_id to category name
      const { data: categories, error: categoriesError } = await supabaseClient
        .from('auction_categories')
        .select('id, name');
      
      const categoryMap = new Map<string, string>();
      if (categories) {
        categories.forEach(cat => {
          categoryMap.set(cat.id, cat.name);
        });
      }

      // 1b. Compute time_status for each auction (upcoming, active, ended)
      const now = new Date();
      const auctionsWithTimeStatus = auctions?.map(auction => ({
        ...auction,
        time_status: (() => {
          const startTime = new Date(auction.start_time);
          const endTime = new Date(auction.end_time);
          if (now < startTime) return 'upcoming';
          if (now >= startTime && now <= endTime) return 'active';
          return 'ended';
        })(),
        category: categoryMap.get(auction.category_id) || 'Uncategorized'
      })) || [];

      // 2. Get auction sales data
      const { data: auctionSales, error: salesError } = await supabaseClient
        .from('auction_sales')
        .select('*')
        .eq('seller_id', userId)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      if (salesError) {
        console.error('Error fetching auction sales:', salesError);
      }

      // 3. Get all bids for the auctions
      const auctionIds = auctions?.map(a => a.id) || [];
      const { data: allBids, error: bidsError } = await supabaseClient
        .from('auction_bids')
        .select('auction_id, bidder_id, amount')
        .in('auction_id', auctionIds);

      if (bidsError) {
        console.error('Error fetching bids:', bidsError);
      }

      // 4. Calculate metrics (use auctionsWithTimeStatus instead of auctions)
      const totalAuctions = auctionsWithTimeStatus.length || 0;
      const activeAuctions = auctionsWithTimeStatus.filter(a => a.time_status === 'active').length || 0;
      const completedAuctions = auctionsWithTimeStatus.filter(a => a.time_status === 'ended').length || 0;
      const soldAuctions = auctionsWithTimeStatus.filter(a => a.status === 'sold').length || 0;

      const totalRevenue = auctionSales?.reduce((sum, sale) => sum + (sale.final_bid_amount || 0), 0) || 0;
      const totalCommission = auctionSales?.reduce((sum, sale) => sum + (sale.commission_amount || 0), 0) || 0;
      const totalBids = auctionsWithTimeStatus.reduce((sum, auction) => sum + (auction.total_bids || 0), 0) || 0;
      const averageBidsPerAuction = totalAuctions > 0 ? totalBids / totalAuctions : 0;
      const averageFinalPrice = soldAuctions > 0 ? totalRevenue / soldAuctions : 0;
      const conversionRate = completedAuctions > 0 ? (soldAuctions / completedAuctions) * 100 : 0;

      // Get unique bidders
      const uniqueBidders = new Set(allBids?.map(bid => bid.bidder_id) || []).size;

      // 5. Get top performing auctions
      const topAuctions = auctionsWithTimeStatus
        .filter(a => a.status === 'sold')
        .sort((a, b) => (b.winning_bid || 0) - (a.winning_bid || 0))
        .slice(0, 5)
        .map(a => ({
          id: a.id,
          title: a.title,
          final_bid: a.winning_bid || 0,
          total_bids: a.total_bids || 0,
          winner_id: a.winner_id || '',
        }));

      // 6. Calculate category performance
      const categoryPerformanceMap = new Map<string, { auction_count: number; total_revenue: number; total_bids: number }>();

      auctionsWithTimeStatus.forEach(auction => {
        const categoryName = auction.category || 'Uncategorized';
        const existing = categoryPerformanceMap.get(categoryName) || { auction_count: 0, total_revenue: 0, total_bids: 0 };

        existing.auction_count += 1;
        existing.total_revenue += auction.status === 'sold' ? (auction.winning_bid || 0) : 0;
        existing.total_bids += auction.total_bids || 0;

        categoryPerformanceMap.set(categoryName, existing);
      });

      const categoryPerformance = Array.from(categoryPerformanceMap.entries()).map(([category, stats]) => ({
        category,
        auction_count: stats.auction_count,
        total_revenue: stats.total_revenue,
        average_final_bid: stats.auction_count > 0 ? stats.total_revenue / stats.auction_count : 0,
      }));

      // 7. Generate chart data
      const chartData = this.generateAuctionChartData(auctionsWithTimeStatus, period);

      // 8. Calculate trends (compare with previous period)
      const previousDateRange = this.getPreviousDateRange(period, date);
      const { data: previousAuctions } = await supabaseClient
        .from('auctions')
        .select('id, status, winning_bid, total_bids')
        .eq('seller_id', userId)
        .gte('created_at', previousDateRange.start)
        .lte('created_at', previousDateRange.end);

      const previousTotalAuctions = previousAuctions?.length || 0;
      const previousRevenue = previousAuctions?.filter(a => a.status === 'sold')
        .reduce((sum, a) => sum + (a.winning_bid || 0), 0) || 0;
      const previousBids = previousAuctions?.reduce((sum, a) => sum + (a.total_bids || 0), 0) || 0;

      const auctionsChange = previousTotalAuctions > 0
        ? ((totalAuctions - previousTotalAuctions) / previousTotalAuctions) * 100
        : 0;
      const revenueChange = previousRevenue > 0
        ? ((totalRevenue - previousRevenue) / previousRevenue) * 100
        : 0;
      const bidsChange = previousBids > 0
        ? ((totalBids - previousBids) / previousBids) * 100
        : 0;

      // 9. Generate insights
      const insights = this.generateAuctionInsights({
        totalAuctions,
        conversionRate,
        averageBidsPerAuction,
        uniqueBidders,
        totalRevenue,
        auctionsChange,
        revenueChange,
      });

      return {
        period,
        date: date || new Date().toISOString().split('T')[0],
        totalAuctions,
        activeAuctions,
        completedAuctions,
        totalRevenue,
        totalBids,
        averageBidsPerAuction,
        averageFinalPrice,
        conversionRate,
        totalCommission,
        uniqueBidders,
        topAuctions,
        categoryPerformance,
        chartData,
        trends: {
          auctionsChange,
          revenueChange,
          bidsChange,
        },
        insights,
      };

    } catch (error) {
      console.error('Error fetching auction analytics:', error);
      throw error;
    }
  }

  /**
   * Generate chart data for auction analytics
   */
  private generateAuctionChartData(auctions: any[], period: string): any {
    const chartData = {
      labels: [] as string[],
      auctions: [] as number[],
      revenue: [] as number[],
      bids: [] as number[],
    };

    if (period === 'daily') {
      // Hourly breakdown for daily view
      for (let hour = 0; hour < 24; hour++) {
        chartData.labels.push(`${hour}:00`);
        const hourAuctions = auctions.filter(a => {
          const auctionHour = new Date(a.created_at).getHours();
          return auctionHour === hour;
        });
        chartData.auctions.push(hourAuctions.length);
        chartData.revenue.push(hourAuctions.reduce((sum, a) => sum + (a.winning_bid || 0), 0));
        chartData.bids.push(hourAuctions.reduce((sum, a) => sum + (a.total_bids || 0), 0));
      }
    } else if (period === 'weekly') {
      // Daily breakdown for weekly view
      const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      daysOfWeek.forEach((day, index) => {
        chartData.labels.push(day);
        const dayAuctions = auctions.filter(a => {
          const auctionDay = new Date(a.created_at).getDay();
          return auctionDay === index;
        });
        chartData.auctions.push(dayAuctions.length);
        chartData.revenue.push(dayAuctions.reduce((sum, a) => sum + (a.winning_bid || 0), 0));
        chartData.bids.push(dayAuctions.reduce((sum, a) => sum + (a.total_bids || 0), 0));
      });
    } else {
      // Weekly breakdown for monthly view
      for (let week = 1; week <= 4; week++) {
        chartData.labels.push(`Week ${week}`);
        const weekAuctions = auctions.filter(a => {
          const auctionWeek = Math.ceil(new Date(a.created_at).getDate() / 7);
          return auctionWeek === week;
        });
        chartData.auctions.push(weekAuctions.length);
        chartData.revenue.push(weekAuctions.reduce((sum, a) => sum + (a.winning_bid || 0), 0));
        chartData.bids.push(weekAuctions.reduce((sum, a) => sum + (a.total_bids || 0), 0));
      }
    }

    return chartData;
  }

  /**
   * Generate insights for auction performance
   */
  private generateAuctionInsights(metrics: any): string[] {
    const insights: string[] = [];

    if (metrics.conversionRate >= 70) {
      insights.push(`Excellent conversion rate of ${metrics.conversionRate.toFixed(1)}% - most auctions are selling!`);
    } else if (metrics.conversionRate >= 50) {
      insights.push(`Good conversion rate of ${metrics.conversionRate.toFixed(1)}% - above industry average`);
    } else if (metrics.conversionRate > 0) {
      insights.push(`Conversion rate of ${metrics.conversionRate.toFixed(1)}% - consider reviewing reserve prices`);
    }

    if (metrics.averageBidsPerAuction >= 10) {
      insights.push(`Strong bidding activity with ${metrics.averageBidsPerAuction.toFixed(1)} bids per auction on average`);
    } else if (metrics.averageBidsPerAuction >= 5) {
      insights.push(`Moderate bidding with ${metrics.averageBidsPerAuction.toFixed(1)} bids per auction - room for growth`);
    } else if (metrics.totalAuctions > 0) {
      insights.push(`Low bidding activity - consider improving auction visibility and timing`);
    }

    if (metrics.revenueChange > 20) {
      insights.push(`🚀 Revenue up ${metrics.revenueChange.toFixed(1)}% - excellent growth!`);
    } else if (metrics.revenueChange > 0) {
      insights.push(`📈 Revenue increased by ${metrics.revenueChange.toFixed(1)}%`);
    } else if (metrics.revenueChange < -10) {
      insights.push(`📉 Revenue down ${Math.abs(metrics.revenueChange).toFixed(1)}% - review pricing strategy`);
    }

    if (metrics.uniqueBidders > 50) {
      insights.push(`Strong community engagement with ${metrics.uniqueBidders} unique bidders`);
    } else if (metrics.uniqueBidders > 20) {
      insights.push(`Growing bidder community with ${metrics.uniqueBidders} participants`);
    }

    if (insights.length === 0) {
      insights.push('Start creating auctions to see performance insights');
    }

    return insights;
  }

  async getRealTimeLiveStreamAnalytics(streamId: string) {
    try {
      const { data: stream, error: streamError } = await this.serviceSupabase
        .from('live_streams')
        .select(`
          id,
          title,
          status,
          viewer_count,
          total_viewers,
          total_sales,
          created_at,
          started_at
        `)
        .eq('id', streamId)
        .single();

      if (streamError) {
        throw new Error(`Failed to fetch stream: ${streamError.message}`);
      }

      const { data: analytics } = await this.serviceSupabase
        .from('live_stream_analytics')
        .select('*')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      const { data: recentTransactions } = await this.serviceSupabase
        .from('live_stream_transactions')
        .select('total_amount, created_at')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(10);

      const { data: recentGifts } = await this.serviceSupabase
        .from('live_stream_gifts')
        .select('total_amount, created_at')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(10);

      let streamDuration = 0;
      if ((stream as any)?.started_at) {
        const startTime = new Date((stream as any).started_at).getTime();
        const currentTime = new Date().getTime();
        streamDuration = Math.floor((currentTime - startTime) / 1000);
      }

      const engagementCount = (analytics?.total_comments || 0) +
                             (analytics?.total_reactions || 0) +
                             (analytics?.total_gifts || 0);
      const engagementRate = (stream as any)?.total_viewers > 0 ?
        (engagementCount / (stream as any).total_viewers) * 100 : 0;

      const { data: transactionCount } = await this.serviceSupabase
        .from('live_stream_transactions')
        .select('id', { count: 'exact' })
        .eq('stream_id', streamId);

      const conversionRate = (stream as any)?.total_viewers > 0 ?
        ((transactionCount?.length || 0) / (stream as any).total_viewers) * 100 : 0;

      return {
        streamId: (stream as any).id,
        title: (stream as any).title,
        status: (stream as any).status,
        viewerCount: (stream as any).viewer_count || 0,
        totalViewers: (stream as any).total_viewers || 0,
        totalSales: (stream as any).total_sales || 0,
        engagementCount,
        giftCount: analytics?.total_gifts || 0,
        giftValue: analytics?.total_gift_value || 0,
        conversionRate,
        streamDuration,
        averageWatchTime: streamDuration / Math.max(1, (stream as any).total_viewers || 1),
        peakViewers: analytics?.peak_viewers || 0,
        commentCount: analytics?.total_comments || 0,
        reactionCount: analytics?.total_reactions || 0,
        productsSold: transactionCount?.length || 0,
        engagementRate,
        recentActivity: [
          ...(recentTransactions || []).map(tx => ({
            type: 'purchase' as const,
            amount: (tx as any).total_amount,
            timestamp: (tx as any).created_at,
          })),
          ...(recentGifts || []).map(gift => ({
            type: 'gift' as const,
            amount: (gift as any).total_amount,
            timestamp: (gift as any).created_at,
          })),
        ].sort((a, b) => new Date((b as any).timestamp).getTime() - new Date((a as any).timestamp).getTime()),
      };
    } catch (error) {
      console.error('Error fetching real-time live stream analytics:', error);
      throw error;
    }
  }

  /**
   * Get aggregated real-time metrics for vendor dashboard
   */
  async getVendorRealTimeMetrics(userId: string) {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Get current active streams
      const { data: activeStreams, error: streamsError } = await this.supabase
        .from('live_streams')
        .select(`
          id,
          title,
          viewer_count,
          total_sales,
          created_at
        `)
        .eq('vendor_id', userId)
        .eq('status', 'live');

      // Get today's live stream performance
      const { data: todayStreams, error: todayError } = await this.supabase
        .from('live_streams')
        .select(`
          id,
          total_viewers,
          total_sales
        `)
        .eq('vendor_id', userId)
        .gte('created_at', todayStart.toISOString());

      // Aggregate today's metrics
      let todayTotalViewers = 0;
      let todayTotalRevenue = 0;
      let todayStreamsCount = 0;

      if (todayStreams) {
        todayStreamsCount = todayStreams.length;
        todayTotalViewers = todayStreams.reduce((sum, stream) =>
          sum + (stream.total_viewers || 0), 0);
        todayTotalRevenue = todayStreams.reduce((sum, stream) =>
          sum + (stream.total_sales || 0), 0);
      }

      // Get current total viewers across all active streams
      const currentTotalViewers = activeStreams?.reduce((sum, stream) =>
        sum + (stream.viewer_count || 0), 0) || 0;

      // Get today's gift revenue
      const { data: todayGifts, error: giftsError } = await this.supabase
        .from('live_stream_gifts')
        .select(`
          total_amount,
          stream:live_streams!inner(vendor_id)
        `)
        .eq('stream.vendor_id', userId)
        .gte('created_at', todayStart.toISOString());

      const todayGiftRevenue = todayGifts?.reduce((sum, gift) =>
        sum + (gift.total_amount || 0), 0) || 0;

      // Calculate performance metrics
      const averageViewersPerStream = todayStreamsCount > 0 ?
        todayTotalViewers / todayStreamsCount : 0;

      return {
        currentActiveStreams: activeStreams?.length || 0,
        currentTotalViewers,
        todayStreamsCount,
        todayTotalViewers,
        todayTotalRevenue: todayTotalRevenue + todayGiftRevenue,
        todayGiftRevenue,
        averageViewersPerStream,
        activeStreamsList: activeStreams || [],
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Error fetching vendor real-time metrics:', error);
      throw error;
    }
  }

  /**
   * Record analytics event for real-time tracking
   * ✅ PHASE 6 FIX: Add event batching for high-frequency events
   */
  async recordAnalyticsEvent(eventData: {
    streamId?: string;
    userId: string;
    eventType: 'stream_start' | 'stream_end' | 'viewer_join' | 'viewer_leave' |
               'comment' | 'reaction' | 'gift_sent' | 'product_purchased' | 'service_booked';
    metadata?: Record<string, any>;
  }) {
    try {
      // ✅ PHASE 6 FIX: Batch high-frequency events
      const shouldBatch = eventData.streamId && 
        ['viewer_join', 'viewer_leave', 'comment', 'reaction'].includes(eventData.eventType);

      if (shouldBatch) {
        return this.addToEventBatch(eventData.streamId!, eventData);
      }

      // Critical events (gift_sent, product_purchased) are processed immediately
      // Use service role client to bypass RLS for system events
      const { error } = await this.serviceSupabase
        .from('analytics_events')
        .insert({
          stream_id: eventData.streamId,
          user_id: eventData.userId,
          event_type: eventData.eventType,
          metadata: eventData.metadata || {},
          created_at: new Date().toISOString(),
        });

      if (error) {
        console.error(`[Analytics] Error recording analytics event for user ${eventData.userId}:`, error);
        throw new AnalyticsError(
          `Failed to record analytics event: ${error.message}`,
          'EVENT_RECORDING_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // If it's a live stream event, update real-time analytics immediately
      if (eventData.streamId && ['gift_sent', 'product_purchased'].includes(eventData.eventType)) {
        const analyticsUpdate: any = {};

        switch (eventData.eventType) {
          case 'gift_sent':
            analyticsUpdate.gift = { amount: eventData.metadata?.amount || 0 };
            break;
          case 'product_purchased':
            analyticsUpdate.purchase = { amount: eventData.metadata?.amount || 0 };
            break;
        }

        await this.updateLiveStreamAnalytics(eventData.streamId, analyticsUpdate);
      }

      return { success: true };
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error(`[Analytics] Unexpected error recording analytics event:`, error);
      throw new AnalyticsError(
        'An unexpected error occurred while recording analytics event',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Add event to batch for processing
   * ✅ PHASE 6 FIX: Event batching implementation
   */
  private addToEventBatch(streamId: string, eventData: any): { success: boolean; batched: boolean } {
    if (!this.eventBatch.has(streamId)) {
      this.eventBatch.set(streamId, []);
    }

    const batch = this.eventBatch.get(streamId)!;
    
    // If batch is full, process it immediately
    if (batch.length >= this.BATCH_SIZE) {
      this.processStreamBatch(streamId);
      this.eventBatch.set(streamId, []);
    }

    // Add event to batch
    batch.push({
      type: eventData.eventType,
      data: eventData,
      timestamp: Date.now()
    });

    return { success: true, batched: true };
  }

  /**
   * Process all event batches
   * ✅ PHASE 6 FIX: Batch processing implementation
   */
  private async processEventBatch(): Promise<void> {
    if (this.eventBatch.size === 0) return;

    const streamIds = Array.from(this.eventBatch.keys());
    
    // Process each stream's batch
    for (const streamId of streamIds) {
      await this.processStreamBatch(streamId);
    }

    // Clear all batches
    this.eventBatch.clear();
  }

  /**
   * Process batch for a specific stream
   * ✅ PHASE 6 FIX: Stream-specific batch processing
   */
  private async processStreamBatch(streamId: string): Promise<void> {
    const batch = this.eventBatch.get(streamId);
    if (!batch || batch.length === 0) return;

    try {
      // Aggregate events by type
      const aggregatedUpdate: any = {
        viewerJoin: false,
        viewerLeave: false,
        comment: false,
        reaction: false
      };

      let commentCount = 0;
      let reactionCount = 0;
      let viewerJoinCount = 0;
      let viewerLeaveCount = 0;

      batch.forEach(event => {
        switch (event.type) {
          case 'viewer_join':
            viewerJoinCount++;
            aggregatedUpdate.viewerJoin = true;
            break;
          case 'viewer_leave':
            viewerLeaveCount++;
            aggregatedUpdate.viewerLeave = true;
            break;
          case 'comment':
            commentCount++;
            aggregatedUpdate.comment = true;
            break;
          case 'reaction':
            reactionCount++;
            aggregatedUpdate.reaction = true;
            break;
        }
      });

      // Calculate net viewer change
      const netViewerChange = viewerJoinCount - viewerLeaveCount;
      if (netViewerChange > 0) {
        for (let i = 0; i < netViewerChange; i++) {
          aggregatedUpdate.viewerJoin = true;
        }
      } else if (netViewerChange < 0) {
        for (let i = 0; i < Math.abs(netViewerChange); i++) {
          aggregatedUpdate.viewerLeave = true;
        }
      }

      // ✅ PHASE 6 FIX: Optimized - aggregate all updates into single call
      // Calculate net viewer change and aggregate all metrics
      const finalUpdate: any = {};
      
      if (netViewerChange > 0) {
        finalUpdate.viewerJoin = true;
      } else if (netViewerChange < 0) {
        finalUpdate.viewerLeave = true;
      }

      // Aggregate comments and reactions (RPC will handle increments)
      if (commentCount > 0) {
        finalUpdate.comment = true;
      }

      if (reactionCount > 0) {
        finalUpdate.reaction = true;
      }

      // ✅ PHASE 6 FIX: Make single atomic update call with batch counts
      // Call RPC once with aggregated counts for better performance
      if (netViewerChange !== 0 || commentCount > 0 || reactionCount > 0) {
        const { data, error } = await this.serviceSupabase.rpc('update_live_stream_analytics_atomic', {
          p_stream_id: streamId,
          p_viewer_join: netViewerChange > 0,
          p_viewer_join_count: netViewerChange > 0 ? Math.abs(netViewerChange) : 0,
          p_viewer_leave: netViewerChange < 0,
          p_viewer_leave_count: netViewerChange < 0 ? Math.abs(netViewerChange) : 0,
          p_comment: commentCount > 0,
          p_comment_count: commentCount,
          p_reaction: reactionCount > 0,
          p_reaction_count: reactionCount,
          p_gift_amount: 0,
          p_purchase_amount: 0
        });

        if (error) {
          console.error(`[Analytics] Error batch updating analytics for stream ${streamId}:`, error);
        }
      }

      // Batch insert events to analytics_events table
      const eventsToInsert = batch.map(event => ({
        stream_id: streamId,
        user_id: event.data.userId,
        event_type: event.type,
        metadata: event.data.metadata || {},
        created_at: new Date(event.timestamp).toISOString(),
      }));

      // Use service role client to bypass RLS for batch inserts
      const { error: batchInsertError } = await this.serviceSupabase
        .from('analytics_events')
        .insert(eventsToInsert);

      if (batchInsertError) {
        console.error(`[Analytics] Error batch inserting events for stream ${streamId}:`, batchInsertError);
      }
    } catch (error) {
      console.error(`[Analytics] Error processing batch for stream ${streamId}:`, error);
    }
  }

  /**
   * Admin Analytics Methods
   */

  /**
   * Get user role for admin authorization
   */
  async getUserRole(userId: string, userToken?: string): Promise<string> {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data: user, error } = await supabaseClient
        .from('users')
        .select('role')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('Error fetching user role:', error);
        return 'user';
      }

      return user?.role || 'user';
    } catch (error) {
      console.error('Error fetching user role:', error);
      return 'user';
    }
  }

  /**
   * Get platform-wide live streaming analytics
   */
  async getPlatformLiveStreamAnalytics(
    period: 'today' | 'week' | 'month' | 'quarter',
    category: string,
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period);

      // Base query for filtering by category
      let categoryFilter = '';
      if (category !== 'all') {
        categoryFilter = `and(category.eq.${category})`;
      }

      // Get platform-wide vendor metrics
      const { data: vendors, error: vendorsError } = await supabaseClient
        .from('users')
        .select('id, name, created_at')
        .eq('account_type', 'vendor');

      const totalVendors = vendors?.length || 0;

      // Get active streamers (vendors who have streamed in the period)
      const { data: activeStreamerData, error: activeStreamersError } = await supabaseClient
        .from('live_streams')
        .select('vendor_id')
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      const activeStreamers = new Set(activeStreamerData?.map(s => s.vendor_id)).size;

      // Get all streams in the period
      const { data: allStreams, error: streamsError } = await supabaseClient
        .from('live_streams')
        .select(`
          *,
          live_stream_transactions(total_amount, status),
          live_stream_gifts(total_amount)
        `)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      const totalStreams = allStreams?.length || 0;
      let totalLiveRevenue = 0;
      let totalLiveOrders = 0;
      let totalStreamDuration = 0;

      // Calculate metrics from streams
      if (allStreams) {
        for (const stream of allStreams) {
          // Add transaction revenue
          const transactions = stream.live_stream_transactions || [];
          const completedTransactions = transactions.filter(t => t.status === 'completed');
          totalLiveRevenue += completedTransactions.reduce((sum, t) => sum + (t.total_amount || 0), 0);
          totalLiveOrders += completedTransactions.length;

          // Add gift revenue
          const gifts = stream.live_stream_gifts || [];
          totalLiveRevenue += gifts.reduce((sum, g) => sum + (g.total_amount || 0), 0);

          // Add stream duration
          if (stream.ended_at && stream.started_at) {
            const duration = new Date(stream.ended_at).getTime() - new Date(stream.started_at).getTime();
            totalStreamDuration += duration / 60000; // Convert to minutes
          }
        }
      }

      const averageStreamDuration = totalStreams > 0 ? totalStreamDuration / totalStreams : 0;
      // ✅ PHASE 5 FIX: Use configurable platform commission rate
      const platformCommission = totalLiveRevenue * this.PLATFORM_COMMISSION_RATE;

      // Get top performing vendors
      const vendorPerformance = new Map();
      if (allStreams) {
        for (const stream of allStreams) {
          const vendorId = stream.vendor_id;
          if (!vendorPerformance.has(vendorId)) {
            vendorPerformance.set(vendorId, {
              vendorId,
              vendorName: stream.vendor_name || 'Unknown Vendor',
              totalRevenue: 0,
              totalStreams: 0,
              averageRating: 0, // Will be calculated
              conversionRate: 0, // Will be calculated
            });
          }

          const vendor = vendorPerformance.get(vendorId);
          vendor.totalStreams += 1;

          // Calculate revenue for this vendor
          const transactions = stream.live_stream_transactions || [];
          const gifts = stream.live_stream_gifts || [];
          const streamRevenue = transactions.reduce((sum, t) => sum + (t.total_amount || 0), 0) +
                              gifts.reduce((sum, g) => sum + (g.total_amount || 0), 0);
          vendor.totalRevenue += streamRevenue;
        }
      }

      const topPerformingVendors = Array.from(vendorPerformance.values())
        .sort((a, b) => b.totalRevenue - a.totalRevenue)
        .slice(0, 10)
        .map(vendor => ({
          ...vendor,
          conversionRate: Math.random() * 10, // Mock conversion rate
        }));

      // Generate revenue by day data
      const revenueByDay = this.generateDailyRevenueData(allStreams, period);

      // ✅ PHASE 5 FIX: Calculate category performance from actual stream data
      const categoryPerformanceMap = new Map<string, { revenue: number; streams: number; viewers: number; transactions: number }>();
      
      allStreams?.forEach(stream => {
        const category = stream.category || 'Uncategorized';
        const existing = categoryPerformanceMap.get(category) || {
          revenue: 0,
          streams: 0,
          viewers: 0,
          transactions: 0
        };

        existing.streams += 1;
        existing.viewers += stream.total_viewers || 0;
        
        const transactions = stream.live_stream_transactions || [];
        const gifts = stream.live_stream_gifts || [];
        const streamRevenue = transactions.reduce((sum, t) => sum + (t.total_amount || 0), 0) +
                            gifts.reduce((sum, g) => sum + (g.total_amount || 0), 0);
        
        existing.revenue += streamRevenue;
        existing.transactions += transactions.filter(t => t.status === 'completed').length;

        categoryPerformanceMap.set(category, existing);
      });

      const categoryPerformance = Array.from(categoryPerformanceMap.entries()).map(([category, data]) => ({
        category,
        revenue: data.revenue,
        streams: data.streams,
        conversionRate: data.viewers > 0 ? Math.round((data.transactions / data.viewers) * 100 * 10) / 10 : 0
      })).sort((a, b) => b.revenue - a.revenue);

      // ✅ PHASE 5 FIX: Get geographic data from actual location data
      const geographicData = await this.getGeographicAnalytics(period, userToken);

      // Generate streaming trends
      const streamingTrends = {
        peakHours: this.generatePeakHoursData(allStreams),
        // ✅ PHASE 5 FIX: Device types would require user agent tracking - document limitation
        // For now, return empty array - device tracking can be added later via request headers
        deviceTypes: [], // TODO: Implement device type tracking from request headers
        averageViewerEngagement: this.calculateAverageViewerEngagement(allStreams),
        streamRetentionRate: this.calculateStreamRetentionRate(allStreams),
      };

      return {
        totalVendors,
        activeStreamers,
        totalStreams,
        totalLiveRevenue,
        totalLiveOrders,
        averageStreamDuration,
        platformCommission,
        topPerformingVendors,
        revenueByDay,
        categoryPerformance,
        geographicData,
        streamingTrends,
      };
    } catch (error) {
      console.error('Error fetching platform live stream analytics:', error);
      throw error;
    }
  }

  /**
   * Get vendor analytics for admin dashboard
   */
  async getVendorAnalytics(
    period: 'today' | 'week' | 'month' | 'quarter',
    limit: number = 50,
    offset: number = 0,
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // ✅ PHASE 5 FIX: Input validation
      if (limit < 1 || limit > 1000) {
        throw new AnalyticsError(
          'Limit must be between 1 and 1000',
          'INVALID_LIMIT',
          HttpStatus.BAD_REQUEST
        );
      }
      if (offset < 0) {
        throw new AnalyticsError(
          'Offset must be non-negative',
          'INVALID_OFFSET',
          HttpStatus.BAD_REQUEST
        );
      }

      const dateRange = this.getDateRange(period);

      // Get total count for pagination
      const { count: totalVendors, error: countError } = await supabaseClient
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('account_type', 'vendor');

      if (countError) {
        console.error('[Analytics] Error counting vendors:', countError);
      }

      // Get vendors with their performance metrics
      const { data: vendors, error } = await supabaseClient
        .from('users')
        .select(`
          id,
          name,
          email,
          created_at,
          account_type
        `)
        .eq('account_type', 'vendor')
        .range(offset, offset + limit - 1);

      if (error) {
        throw new AnalyticsError(
          `Failed to fetch vendors: ${error.message}`,
          'VENDORS_FETCH_ERROR',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      const vendorAnalytics: any[] = [];
      for (const vendor of vendors || []) {
        // Get vendor's streams for the period
        const { data: streams } = await supabaseClient
          .from('live_streams')
          .select(`
            *,
            live_stream_transactions(total_amount, status),
            live_stream_gifts(total_amount)
          `)
          .eq('vendor_id', vendor.id)
          .gte('created_at', dateRange.start)
          .lte('created_at', dateRange.end);

        let totalRevenue = 0;
        let totalOrders = 0;
        const totalStreams = streams?.length || 0;

        if (streams) {
          for (const stream of streams) {
            const transactions = stream.live_stream_transactions || [];
            const gifts = stream.live_stream_gifts || [];

            totalRevenue += transactions.reduce((sum, t) => sum + (t.total_amount || 0), 0);
            totalRevenue += gifts.reduce((sum, g) => sum + (g.total_amount || 0), 0);
            totalOrders += transactions.filter(t => t.status === 'completed').length;
          }
        }

        // ✅ PHASE 5 FIX: Calculate real conversion rate instead of mock
        const conversionRate = await this.calculateVendorConversionRate(vendor.id, dateRange, supabaseClient);

        // ✅ PHASE 5 FIX: Calculate real rating instead of mock
        const rating = await this.calculateVendorRating(vendor.id, supabaseClient);

        vendorAnalytics.push({
          vendorId: vendor.id,
          vendorName: vendor.name,
          email: vendor.email,
          joinedDate: vendor.created_at,
          totalStreams,
          totalRevenue,
          totalOrders,
          averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
          conversionRate: Math.round(conversionRate * 10) / 10,
          rating: Math.round(rating * 10) / 10,
          status: totalStreams > 0 ? 'active' : 'inactive',
        });
      }

      // Sort by total revenue
      vendorAnalytics.sort((a, b) => b.totalRevenue - a.totalRevenue);

      // ✅ PHASE 4 FIX: Add pagination metadata
      return {
        vendors: vendorAnalytics,
        total: totalVendors || vendors?.length || 0,
        limit,
        offset,
        hasMore: (offset + limit) < (totalVendors || 0),
        period,
      };
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error('[Analytics] Error fetching vendor analytics:', error);
      throw new AnalyticsError(
        'An unexpected error occurred while fetching vendor analytics',
        'UNEXPECTED_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Calculate vendor conversion rate from actual data
   * ✅ PHASE 5 FIX: Real calculation instead of mock
   */
  private async calculateVendorConversionRate(vendorId: string, dateRange: any, supabaseClient: any): Promise<number> {
    try {
      const { data: streams } = await supabaseClient
        .from('live_streams')
        .select('id, total_viewers')
        .eq('vendor_id', vendorId)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      const { data: transactions } = await supabaseClient
        .from('live_stream_transactions')
        .select('id')
        .eq('vendor_id', vendorId)
        .eq('status', 'completed')
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      const totalViewers = streams?.reduce((sum, s) => sum + (s.total_viewers || 0), 0) || 0;
      const totalPurchases = transactions?.length || 0;

      return totalViewers > 0 ? (totalPurchases / totalViewers) * 100 : 0;
    } catch (error) {
      console.error(`[Analytics] Error calculating conversion rate for vendor ${vendorId}:`, error);
      return 0;
    }
  }

  /**
   * Calculate vendor rating from actual ratings
   * ✅ PHASE 5 FIX: Real calculation instead of mock
   */
  private async calculateVendorRating(vendorId: string, supabaseClient: any): Promise<number> {
    try {
      // Get ratings from orders
      const { data: ratings } = await supabaseClient
        .from('order_item_ratings')
        .select(`
          rating,
          orders!inner(vendor_id)
        `)
        .eq('orders.vendor_id', vendorId);

      if (!ratings || ratings.length === 0) {
        return 0;
      }

      const totalRating = ratings.reduce((sum, r) => sum + (r.rating || 0), 0);
      return totalRating / ratings.length;
    } catch (error) {
      console.error(`[Analytics] Error calculating rating for vendor ${vendorId}:`, error);
      return 0;
    }
  }

  /**
   * Get platform overview analytics
   */
  async getPlatformOverview(
    period: 'today' | 'week' | 'month' | 'quarter',
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period);

      // Get total users by type
      const { data: users } = await supabaseClient
        .from('users')
        .select('account_type, created_at');

      const userStats = {
        totalUsers: users?.length || 0,
        vendors: users?.filter(u => u.account_type === 'vendor').length || 0,
        customers: users?.filter(u => u.account_type === 'customer').length || 0,
        riders: users?.filter(u => u.account_type === 'rider').length || 0,
      };

      // Get platform revenue from all sources
      const [ordersData, liveTransactionsData, auctionSalesData] = await Promise.all([
        supabaseClient
          .from('orders')
          .select('total, created_at, status')
          .gte('created_at', dateRange.start)
          .lte('created_at', dateRange.end),
        supabaseClient
          .from('live_stream_transactions')
          .select('total_amount, created_at, status')
          .gte('created_at', dateRange.start)
          .lte('created_at', dateRange.end),
        supabaseClient
          .from('auction_sales')
          .select('total_amount, created_at, payment_status')
          .gte('created_at', dateRange.start)
          .lte('created_at', dateRange.end),
      ]);

      const orders = ordersData.data || [];
      const liveTransactions = liveTransactionsData.data || [];
      const auctionSales = auctionSalesData.data || [];

      const platformMetrics = {
        totalRevenue:
          orders.reduce((sum, o) => sum + (o.total || 0), 0) +
          liveTransactions.reduce((sum, t) => sum + (t.total_amount || 0), 0) +
          auctionSales.reduce((sum, s) => sum + (s.total_amount || 0), 0),
        totalOrders: orders.length + liveTransactions.length + auctionSales.length,
        completedOrders:
          orders.filter(o => o.status === 'delivered').length +
          liveTransactions.filter(t => t.status === 'completed').length +
          auctionSales.filter(s => s.payment_status === 'completed').length,
      };

      // ✅ PHASE 5 FIX: Calculate actual growth percentages from previous period
      const previousDateRange = this.getPreviousDateRange(period);
      
      const [prevOrdersData, prevLiveTransactionsData, prevAuctionSalesData, prevUsersData] = await Promise.all([
        supabaseClient
          .from('orders')
          .select('total, created_at, status')
          .gte('created_at', previousDateRange.start)
          .lte('created_at', previousDateRange.end),
        supabaseClient
          .from('live_stream_transactions')
          .select('total_amount, created_at, status')
          .gte('created_at', previousDateRange.start)
          .lte('created_at', previousDateRange.end),
        supabaseClient
          .from('auction_sales')
          .select('total_amount, created_at, payment_status')
          .gte('created_at', previousDateRange.start)
          .lte('created_at', previousDateRange.end),
        supabaseClient
          .from('users')
          .select('created_at')
      ]);

      const prevOrders = prevOrdersData.data || [];
      const prevLiveTransactions = prevLiveTransactionsData.data || [];
      const prevAuctionSales = prevAuctionSalesData.data || [];
      const prevUsers = prevUsersData.data || [];

      const prevRevenue = 
        prevOrders.reduce((sum, o) => sum + (o.total || 0), 0) +
        prevLiveTransactions.reduce((sum, t) => sum + (t.total_amount || 0), 0) +
        prevAuctionSales.reduce((sum, s) => sum + (s.total_amount || 0), 0);

      const prevOrderCount = prevOrders.length + prevLiveTransactions.length + prevAuctionSales.length;
      const prevUserCount = prevUsers.length;

      const revenueGrowth = prevRevenue > 0
        ? ((platformMetrics.totalRevenue - prevRevenue) / prevRevenue) * 100
        : platformMetrics.totalRevenue > 0 ? 100 : 0;

      const orderGrowth = prevOrderCount > 0
        ? ((platformMetrics.totalOrders - prevOrderCount) / prevOrderCount) * 100
        : platformMetrics.totalOrders > 0 ? 100 : 0;

      const userGrowth = prevUserCount > 0
        ? ((userStats.totalUsers - prevUserCount) / prevUserCount) * 100
        : userStats.totalUsers > 0 ? 100 : 0;

      return {
        period,
        userStats,
        platformMetrics,
        revenueGrowth: Math.round(revenueGrowth * 10) / 10,
        orderGrowth: Math.round(orderGrowth * 10) / 10,
        userGrowth: Math.round(userGrowth * 10) / 10,
      };
    } catch (error) {
      console.error('Error fetching platform overview:', error);
      throw error;
    }
  }

  /**
   * Get geographic analytics
   * ✅ BUG FIX: Uses actual location data from user_profiles and delivery_address
   */
  async getGeographicAnalytics(
    period: 'today' | 'week' | 'month' | 'quarter',
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period);

      // ✅ BUG FIX: Get orders with delivery addresses
      const { data: orders, error: ordersError } = await supabaseClient
        .from('orders')
        .select('id, total, delivery_address, created_at, status')
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end)
        .eq('status', 'delivered');

      if (ordersError) {
        console.error('Error fetching orders for geographic analytics:', ordersError);
        // Return empty data instead of mock data
        return [];
      }

      // ✅ BUG FIX: Get vendor locations from user_profiles
      const { data: vendors } = await supabaseClient
        .from('user_profiles')
        .select('id, location')
        .eq('is_vendor', true)
        .not('location', 'is', null);

      // ✅ BUG FIX: Aggregate by region from delivery addresses and vendor locations
      const regionData = new Map<string, {
        revenue: number;
        orders: number;
        viewers: number;
        streams: number;
      }>();

      // Extract regions from delivery addresses
      orders?.forEach(order => {
        const deliveryAddress = order.delivery_address;
        let region = 'Unknown';

        if (deliveryAddress) {
          // Try to extract city/region from delivery address
          if (typeof deliveryAddress === 'string') {
            // If it's a string, try to parse or use as-is
            region = this.extractRegionFromAddress(deliveryAddress);
          } else if (deliveryAddress.city) {
            region = deliveryAddress.city;
          } else if (deliveryAddress.region) {
            region = deliveryAddress.region;
          } else if (deliveryAddress.state) {
            region = deliveryAddress.state;
          }
        }

        const existing = regionData.get(region) || { revenue: 0, orders: 0, viewers: 0, streams: 0 };
        existing.revenue += order.total || 0;
        existing.orders += 1;
        regionData.set(region, existing);
      });

      // ✅ BUG FIX: Get live stream data by vendor location
      const { data: liveStreams } = await supabaseClient
        .from('live_streams')
        .select(`
          id,
          vendor_id,
          total_viewers,
          total_sales,
          created_at
        `)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      // Map vendors to regions
      const vendorRegionMap = new Map<string, string>();
      vendors?.forEach(vendor => {
        if (vendor.location) {
          vendorRegionMap.set(vendor.id, this.extractRegionFromLocation(vendor.location));
        }
      });

      // Aggregate stream data by region
      liveStreams?.forEach(stream => {
        const region = vendorRegionMap.get(stream.vendor_id) || 'Unknown';
        const existing = regionData.get(region) || { revenue: 0, orders: 0, viewers: 0, streams: 0 };
        existing.viewers += stream.total_viewers || 0;
        existing.streams += 1;
        existing.revenue += stream.total_sales || 0;
        regionData.set(region, existing);
      });

      // ✅ BUG FIX: Convert to array and sort by revenue
      const geographicData = Array.from(regionData.entries())
        .map(([region, data]) => ({
          region,
          revenue: data.revenue,
          viewers: data.viewers,
          streams: data.streams,
          orders: data.orders
        }))
        .sort((a, b) => b.revenue - a.revenue);

      // If no data found, return empty array instead of mock data
      return geographicData.length > 0 ? geographicData : [];
    } catch (error) {
      console.error('Error fetching geographic analytics:', error);
      // Return empty array instead of mock data
      return [];
    }
  }

  /**
   * Helper method to extract region from address string
   * ✅ BUG FIX: New helper method
   */
  private extractRegionFromAddress(address: string): string {
    if (!address) return 'Unknown';

    // Common Nigerian cities/regions to match
    const regions = [
      'Lagos', 'Abuja', 'Kano', 'Port Harcourt', 'Ibadan', 'Benin City',
      'Kaduna', 'Aba', 'Maiduguri', 'Zaria', 'Jos', 'Ilorin', 'Warri',
      'Onitsha', 'Abeokuta', 'Enugu', 'Calabar', 'Uyo', 'Asaba', 'Owerri'
    ];

    const addressLower = address.toLowerCase();
    for (const region of regions) {
      if (addressLower.includes(region.toLowerCase())) {
        return region;
      }
    }

    // If no match, try to extract first meaningful word
    const parts = address.split(',').map(p => p.trim());
    return parts[parts.length - 1] || 'Unknown';
  }

  /**
   * Helper method to extract region from location string
   * ✅ BUG FIX: New helper method
   */
  private extractRegionFromLocation(location: string): string {
    if (!location) return 'Unknown';
    return this.extractRegionFromAddress(location);
  }

  /**
   * Calculate average viewer engagement
   * ✅ PHASE 5 FIX: Helper method for engagement calculation
   */
  private calculateAverageViewerEngagement(streams: any[]): number {
    if (!streams || streams.length === 0) return 0;

    let totalEngagement = 0;
    let totalViewers = 0;

    streams.forEach(stream => {
      const viewers = stream.total_viewers || 0;
      const comments = stream.comment_count || 0;
      const reactions = stream.reaction_count || 0;
      const gifts = stream.gift_count || 0;
      const engagement = comments + reactions + gifts;
      
      totalEngagement += engagement;
      totalViewers += viewers;
    });

    return totalViewers > 0 ? (totalEngagement / totalViewers) * 100 : 0;
  }

  /**
   * Calculate stream retention rate
   * ✅ PHASE 5 FIX: Helper method for retention calculation
   */
  private calculateStreamRetentionRate(streams: any[]): number {
    if (!streams || streams.length === 0) return 0;

    let totalDuration = 0;
    let totalViewers = 0;
    let completedStreams = 0;

    streams.forEach(stream => {
      if (stream.started_at && stream.ended_at) {
        const duration = new Date(stream.ended_at).getTime() - new Date(stream.started_at).getTime();
        const viewers = stream.total_viewers || 0;
        
        if (duration > 0 && viewers > 0) {
          totalDuration += duration;
          totalViewers += viewers;
          completedStreams++;
        }
      }
    });

    // Calculate average watch time as percentage of stream duration
    // This is a simplified calculation - actual retention would require per-viewer tracking
    return completedStreams > 0 && totalViewers > 0
      ? (totalDuration / (totalViewers * 1000 * 60)) * 100 // Convert to minutes and calculate
      : 0;
  }

  /**
   * Get real-time platform metrics
   */
  async getRealTimePlatformMetrics(userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Get current active streams
      const { data: activeStreams } = await supabaseClient
        .from('live_streams')
        .select('*')
        .eq('status', 'active');

      // Get today's metrics
      const [todayOrdersData, todayRevenueData] = await Promise.all([
        supabaseClient
          .from('orders')
          .select('total')
          .gte('created_at', todayStart.toISOString()),
        supabaseClient
          .from('live_stream_transactions')
          .select('total_amount')
          .gte('created_at', todayStart.toISOString()),
      ]);

      const todayOrders = (todayOrdersData.data?.length || 0) + (todayRevenueData.data?.length || 0);
      const todayRevenue =
        (todayOrdersData.data?.reduce((sum, o) => sum + (o.total || 0), 0) || 0) +
        (todayRevenueData.data?.reduce((sum, t) => sum + (t.total_amount || 0), 0) || 0);

      return {
        activeStreams: activeStreams?.length || 0,
        currentViewers: activeStreams?.reduce((sum, s) => sum + (s.viewer_count || 0), 0) || 0,
        todayOrders,
        todayRevenue,
        activeSessions: Math.floor(Math.random() * 500) + 200, // Mock active user sessions
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Error fetching real-time platform metrics:', error);
      throw error;
    }
  }

  /**
   * Export analytics data
   */
  async exportAnalyticsData(
    exportRequest: {
      type: 'platform' | 'vendors' | 'live-streaming' | 'geographic';
      period: 'today' | 'week' | 'month' | 'quarter';
      format: 'csv' | 'excel' | 'json';
      filters?: Record<string, any>;
    },
    userToken?: string,
  ) {
    try {
      let data;

      switch (exportRequest.type) {
        case 'platform':
          data = await this.getPlatformOverview(exportRequest.period, userToken);
          break;
        case 'vendors':
          data = await this.getVendorAnalytics(exportRequest.period, 1000, 0, userToken);
          break;
        case 'live-streaming':
          data = await this.getPlatformLiveStreamAnalytics(exportRequest.period, 'all', userToken);
          break;
        case 'geographic':
          data = await this.getGeographicAnalytics(exportRequest.period, userToken);
          break;
        default:
          throw new AnalyticsError(
            `Invalid export type: ${exportRequest.type}`,
            'INVALID_EXPORT_TYPE',
            HttpStatus.BAD_REQUEST
          );
      }

      // ✅ PHASE 4 FIX: Generate actual export file
      const exportId = `export_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const filePath = await this.generateReportFile(data, exportRequest.format, exportId);
      const downloadUrl = await this.uploadReportToStorage(filePath, exportId, 'admin', exportRequest.format);

      // Cleanup temporary file
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      return {
        exportId,
        downloadUrl,
        format: exportRequest.format,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      };
    } catch (error) {
      if (error instanceof AnalyticsError || error instanceof HttpException) {
        throw error;
      }
      console.error('[Analytics] Error exporting analytics data:', error);
      throw new AnalyticsError(
        'An unexpected error occurred while exporting analytics data',
        'EXPORT_ERROR',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Helper methods for admin analytics
   */

  private generateDailyRevenueData(streams: any[], period: string) {
    const days = period === 'today' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 90;
    const revenueByDay: any[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      const dayStreams = streams?.filter(s =>
        s.created_at && s.created_at.startsWith(dateStr)
      ) || [];

      const revenue = dayStreams.reduce((sum, stream) => {
        const transactions = stream.live_stream_transactions || [];
        const gifts = stream.live_stream_gifts || [];
        return sum +
          transactions.reduce((txSum, tx) => txSum + (tx.total_amount || 0), 0) +
          gifts.reduce((gSum, g) => gSum + (g.total_amount || 0), 0);
      }, 0);

      revenueByDay.push({
        date: dateStr,
        revenue,
        streams: dayStreams.length,
        orders: dayStreams.reduce((sum, s) => sum + (s.live_stream_transactions?.length || 0), 0),
      });
    }

    return revenueByDay;
  }

  private generatePeakHoursData(streams: any[]) {
    const hourlyData = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      streams: 0,
      revenue: 0,
    }));

    streams?.forEach(stream => {
      if (stream.created_at) {
        const hour = new Date(stream.created_at).getHours();
        hourlyData[hour].streams += 1;

        const transactions = stream.live_stream_transactions || [];
        const gifts = stream.live_stream_gifts || [];
        const streamRevenue =
          transactions.reduce((sum, tx) => sum + (tx.total_amount || 0), 0) +
          gifts.reduce((sum, g) => sum + (g.total_amount || 0), 0);

        hourlyData[hour].revenue += streamRevenue;
      }
    });

    return hourlyData;
  }
}