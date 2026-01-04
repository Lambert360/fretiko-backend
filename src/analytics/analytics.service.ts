import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class AnalyticsService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async getAnalytics(userId: string, period: string, date?: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period, date);
      let totalOrdersProcessed = 0;
      let totalTransactionValue = 0;
      let totalCompletedTransactions = 0;
      const allCustomers = new Set();

      // 1. Get regular orders data for the period
      const { data: orders, error: ordersError } = await supabaseClient
        .from('orders')
        .select('*')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      if (!ordersError && orders) {
        totalOrdersProcessed += orders.length;
        totalTransactionValue += orders.reduce((sum, order) => sum + (order.total || 0), 0);
        totalCompletedTransactions += orders.filter(order => order.status === 'delivered').length;
        orders.forEach(order => order.customer_id && allCustomers.add(order.customer_id));
      }

      // 2. Get live stream transactions
      const { data: liveTransactions, error: liveError } = await supabaseClient
        .from('live_stream_transactions')
        .select('*')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      if (!liveError && liveTransactions) {
        totalOrdersProcessed += liveTransactions.length;
        totalTransactionValue += liveTransactions.reduce((sum, tx) => sum + (tx.total_amount || 0), 0);
        totalCompletedTransactions += liveTransactions.filter(tx => tx.status === 'completed').length;
        liveTransactions.forEach(tx => tx.buyer_id && allCustomers.add(tx.buyer_id));
      }

      // 2b. Get live stream gifts (additional revenue stream)
      const { data: liveGifts, error: giftsError } = await supabaseClient
        .from('live_stream_gifts')
        .select(`
          *,
          stream:live_streams!inner(vendor_id)
        `)
        .eq('stream.vendor_id', userId)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      let totalGiftValue = 0;
      if (!giftsError && liveGifts) {
        totalGiftValue = liveGifts.reduce((sum, gift) => sum + (gift.total_amount || 0), 0);
        totalTransactionValue += totalGiftValue;
        // Gifts count as completed transactions immediately
        totalCompletedTransactions += liveGifts.length;
        liveGifts.forEach(gift => gift.sender_id && allCustomers.add(gift.sender_id));
      }

      // 3. Get auction sales
      const { data: auctionSales, error: auctionError } = await supabaseClient
        .from('auction_sales')
        .select('*')
        .eq('seller_id', userId)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      if (!auctionError && auctionSales) {
        totalOrdersProcessed += auctionSales.length;
        totalTransactionValue += auctionSales.reduce((sum, sale) => sum + (sale.total_amount || 0), 0);
        totalCompletedTransactions += auctionSales.filter(sale => sale.payment_status === 'completed').length;
        auctionSales.forEach(sale => sale.buyer_id && allCustomers.add(sale.buyer_id));
      }

      // 4. Get service bookings
      const { data: serviceBookings, error: bookingError } = await supabaseClient
        .from('service_bookings')
        .select(`
          *,
          service:services!inner(vendor_id)
        `)
        .eq('service.vendor_id', userId)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      if (!bookingError && serviceBookings) {
        totalOrdersProcessed += serviceBookings.length;
        totalTransactionValue += serviceBookings.reduce((sum, booking) => sum + (booking.total_price || 0), 0);
        totalCompletedTransactions += serviceBookings.filter(booking => booking.status === 'completed').length;
        serviceBookings.forEach(booking => booking.customer_id && allCustomers.add(booking.customer_id));
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

      return {
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
    } catch (error) {
      console.error('Error fetching analytics:', error);
      throw error;
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

      // Recent activity (mock data)
      const recentActivity = [
        {
          type: 'order',
          description: 'New order #12345 received',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'payment',
          description: 'Payment received for order #12344',
          timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        },
      ];

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

      // Revenue by category (mock data)
      const revenueByCategory = [
        { category: 'Electronics', revenue: totalRevenue * 0.4, percentage: 40 },
        { category: 'Fashion', revenue: totalRevenue * 0.3, percentage: 30 },
        { category: 'Home & Garden', revenue: totalRevenue * 0.3, percentage: 30 },
      ];

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

      const { data: orders, error } = await supabaseClient
        .from('orders')
        .select('*')
        .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
        .gte('created_at', dateRange.start)
        .lte('created_at', dateRange.end);

      if (error) {
        throw new Error(`Failed to fetch customer analytics: ${error.message}`);
      }

      const totalCustomers = new Set(orders?.map(order => order.customer_id)).size || 0;
      const newCustomers = Math.floor(totalCustomers * 0.3); // Mock calculation
      const returningCustomers = totalCustomers - newCustomers;
      const customerRetentionRate = totalCustomers > 0 ? (returningCustomers / totalCustomers) * 100 : 0;
      const averageOrdersPerCustomer = totalCustomers > 0 ? (orders?.length || 0) / totalCustomers : 0;

      // Top customers (mock data)
      const topCustomers = [
        {
          customerId: '1',
          customerName: 'John Doe',
          totalOrders: 12,
          totalSpent: 15600,
        },
        {
          customerId: '2',
          customerName: 'Jane Smith',
          totalOrders: 8,
          totalSpent: 9800,
        },
      ];

      return {
        totalCustomers,
        newCustomers,
        returningCustomers,
        customerRetentionRate,
        averageOrdersPerCustomer,
        topCustomers,
      };
    } catch (error) {
      console.error('Error fetching customer analytics:', error);
      throw error;
    }
  }

  async getProductAnalytics(userId: string, period: string, userToken?: string) {
    // Mock implementation for product analytics
    return {
      totalProducts: 25,
      totalSales: 156,
      topSellingProducts: [
        {
          productId: '1',
          productName: 'Premium Product A',
          category: 'Electronics',
          quantitySold: 45,
          revenue: 67500,
          averageRating: 4.8,
        },
      ],
      categoryPerformance: [
        {
          category: 'Electronics',
          productsCount: 8,
          totalSales: 89,
          revenue: 134500,
        },
      ],
      lowStockProducts: [],
    };
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

      // In a real implementation, you would:
      // 1. Generate the actual PDF/Excel file using the reportContent
      // 2. Upload it to cloud storage (e.g., S3, Supabase Storage)
      // 3. Update the report status to 'completed'
      // 4. Store the download URL

      const downloadUrl = `/api/analytics/reports/${reportId}/download`;

      return {
        reportId,
        downloadUrl,
        status: 'processing',
        message: 'Report generation started. You will be notified when it is ready.',
      };
    } catch (error) {
      console.error('Error generating report:', error);
      throw error;
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
        console.error('Error fetching reports:', error);
        // Return mock data if database query fails
        return this.getMockReports();
      }

      if (!reports || reports.length === 0) {
        return this.getMockReports();
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
      console.error('Error in getReports:', error);
      return this.getMockReports();
    }
  }

  private getMockReports() {
    return [
      {
        id: '1',
        title: 'Daily Sales Report',
        subtitle: 'Generated today',
        status: 'completed',
        createdAt: new Date().toISOString(),
        type: 'daily',
        source: 'all',
        downloadUrl: '/api/analytics/reports/1/download',
      },
      {
        id: '2',
        title: 'Weekly Auction Performance',
        subtitle: 'Generated this week',
        status: 'completed',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        type: 'weekly',
        source: 'auctions',
        downloadUrl: '/api/analytics/reports/2/download',
      },
    ];
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
    // Mock implementation
    return {
      downloadUrl: `https://api.fretiko.com/reports/${reportId}/download`,
    };
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

      const onlineCustomers = 5; // Mock data
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
      const { data: currentAnalytics, error: fetchError } = await this.supabase
        .from('live_stream_analytics')
        .select('*')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      let updatedData = currentAnalytics || {
        stream_id: streamId,
        viewer_count: 0,
        peak_viewers: 0,
        total_comments: 0,
        total_reactions: 0,
        total_gifts: 0,
        total_gift_value: 0,
        total_sales: 0,
        engagement_score: 0,
        created_at: new Date().toISOString(),
      };

      // Update metrics based on event type
      if (analyticsData.viewerJoin) {
        updatedData.viewer_count += 1;
        updatedData.peak_viewers = Math.max(updatedData.peak_viewers, updatedData.viewer_count);
      }

      if (analyticsData.viewerLeave) {
        updatedData.viewer_count = Math.max(0, updatedData.viewer_count - 1);
      }

      if (analyticsData.comment) {
        updatedData.total_comments += 1;
        updatedData.engagement_score += 1;
      }

      if (analyticsData.reaction) {
        updatedData.total_reactions += 1;
        updatedData.engagement_score += 0.5;
      }

      if (analyticsData.gift) {
        updatedData.total_gifts += 1;
        updatedData.total_gift_value += analyticsData.gift.amount;
        updatedData.engagement_score += 5;
      }

      if (analyticsData.purchase) {
        updatedData.total_sales += analyticsData.purchase.amount;
        updatedData.engagement_score += 10;
      }

      // Upsert analytics record
      const { error: upsertError } = await this.supabase
        .from('live_stream_analytics')
        .upsert(updatedData, {
          onConflict: 'stream_id,created_at',
        });

      if (upsertError) {
        console.error('Error updating live stream analytics:', upsertError);
        throw upsertError;
      }

      // Update the main live_streams table with current metrics
      const { error: streamUpdateError } = await this.supabase
        .from('live_streams')
        .update({
          viewer_count: updatedData.viewer_count,
          total_sales: updatedData.total_sales,
          updated_at: new Date().toISOString(),
        })
        .eq('id', streamId);

      if (streamUpdateError) {
        console.error('Error updating live stream:', streamUpdateError);
      }

      return updatedData;
    } catch (error) {
      console.error('Error updating live stream analytics:', error);
      throw error;
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

  /**
   * Get real-time analytics for a specific live stream
   */
  async getRealTimeLiveStreamAnalytics(streamId: string) {
    try {
      const { data: stream, error: streamError } = await this.supabase
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

      const { data: analytics, error: analyticsError } = await this.supabase
        .from('live_stream_analytics')
        .select('*')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      const { data: recentTransactions, error: transError } = await this.supabase
        .from('live_stream_transactions')
        .select('total_amount, created_at')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(10);

      const { data: recentGifts, error: giftsError } = await this.supabase
        .from('live_stream_gifts')
        .select('total_amount, created_at')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(10);

      // Calculate stream duration
      let streamDuration = 0;
      if (stream.started_at) {
        const startTime = new Date(stream.started_at).getTime();
        const currentTime = new Date().getTime();
        streamDuration = Math.floor((currentTime - startTime) / 1000); // seconds
      }

      // Calculate engagement rate
      const engagementCount = (analytics?.total_comments || 0) +
                             (analytics?.total_reactions || 0) +
                             (analytics?.total_gifts || 0);
      const engagementRate = stream.total_viewers > 0 ?
        (engagementCount / stream.total_viewers) * 100 : 0;

      // Calculate conversion rate
      const { data: transactionCount } = await this.supabase
        .from('live_stream_transactions')
        .select('id', { count: 'exact' })
        .eq('stream_id', streamId);

      const conversionRate = stream.total_viewers > 0 ?
        ((transactionCount?.length || 0) / stream.total_viewers) * 100 : 0;

      return {
        streamId: stream.id,
        title: stream.title,
        status: stream.status,
        viewerCount: stream.viewer_count || 0,
        totalViewers: stream.total_viewers || 0,
        totalSales: stream.total_sales || 0,
        engagementCount,
        giftCount: analytics?.total_gifts || 0,
        giftValue: analytics?.total_gift_value || 0,
        conversionRate,
        streamDuration,
        averageWatchTime: streamDuration / Math.max(1, stream.total_viewers || 1),
        peakViewers: analytics?.peak_viewers || 0,
        commentCount: analytics?.total_comments || 0,
        reactionCount: analytics?.total_reactions || 0,
        productsSold: transactionCount?.length || 0,
        engagementRate,
        recentActivity: [
          ...(recentTransactions || []).map(tx => ({
            type: 'purchase' as const,
            amount: tx.total_amount,
            timestamp: tx.created_at,
          })),
          ...(recentGifts || []).map(gift => ({
            type: 'gift' as const,
            amount: gift.total_amount,
            timestamp: gift.created_at,
          })),
        ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
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
   */
  async recordAnalyticsEvent(eventData: {
    streamId?: string;
    userId: string;
    eventType: 'stream_start' | 'stream_end' | 'viewer_join' | 'viewer_leave' |
               'comment' | 'reaction' | 'gift_sent' | 'product_purchased' | 'service_booked';
    metadata?: Record<string, any>;
  }) {
    try {
      const { error } = await this.supabase
        .from('analytics_events')
        .insert({
          stream_id: eventData.streamId,
          user_id: eventData.userId,
          event_type: eventData.eventType,
          metadata: eventData.metadata || {},
          created_at: new Date().toISOString(),
        });

      if (error) {
        console.error('Error recording analytics event:', error);
        throw error;
      }

      // If it's a live stream event, update real-time analytics
      if (eventData.streamId && ['viewer_join', 'viewer_leave', 'comment', 'reaction', 'gift_sent', 'product_purchased'].includes(eventData.eventType)) {
        const analyticsUpdate: any = {};

        switch (eventData.eventType) {
          case 'viewer_join':
            analyticsUpdate.viewerJoin = true;
            break;
          case 'viewer_leave':
            analyticsUpdate.viewerLeave = true;
            break;
          case 'comment':
            analyticsUpdate.comment = true;
            break;
          case 'reaction':
            analyticsUpdate.reaction = true;
            break;
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
      console.error('Error recording analytics event:', error);
      throw error;
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
      const platformCommission = totalLiveRevenue * 0.1; // Assuming 10% platform fee

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
              averageRating: 4.5, // Mock data
              conversionRate: 0,
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

      // Get category performance
      const categoryPerformance = [
        { category: 'Fashion', revenue: totalLiveRevenue * 0.35, streams: Math.floor(totalStreams * 0.3), conversionRate: 8.2 },
        { category: 'Electronics', revenue: totalLiveRevenue * 0.25, streams: Math.floor(totalStreams * 0.2), conversionRate: 6.5 },
        { category: 'Beauty', revenue: totalLiveRevenue * 0.2, streams: Math.floor(totalStreams * 0.25), conversionRate: 9.1 },
        { category: 'Home & Garden', revenue: totalLiveRevenue * 0.2, streams: Math.floor(totalStreams * 0.25), conversionRate: 5.8 },
      ];

      // Mock geographic data
      const geographicData = [
        { region: 'Lagos', revenue: totalLiveRevenue * 0.4, viewers: 12500, streams: Math.floor(totalStreams * 0.35) },
        { region: 'Abuja', revenue: totalLiveRevenue * 0.25, viewers: 9800, streams: Math.floor(totalStreams * 0.25) },
        { region: 'Kano', revenue: totalLiveRevenue * 0.2, viewers: 8200, streams: Math.floor(totalStreams * 0.2) },
        { region: 'Port Harcourt', revenue: totalLiveRevenue * 0.15, viewers: 6900, streams: Math.floor(totalStreams * 0.2) },
      ];

      // Generate streaming trends
      const streamingTrends = {
        peakHours: this.generatePeakHoursData(allStreams),
        deviceTypes: [
          { device: 'Mobile', count: Math.floor(totalLiveOrders * 0.75), percentage: 75 },
          { device: 'Desktop', count: Math.floor(totalLiveOrders * 0.2), percentage: 20 },
          { device: 'Tablet', count: Math.floor(totalLiveOrders * 0.05), percentage: 5 },
        ],
        averageViewerEngagement: 72.5, // Mock data
        streamRetentionRate: 68.3, // Mock data
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
    limit: number,
    offset: number,
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const dateRange = this.getDateRange(period);

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

      if (error) throw error;

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

        vendorAnalytics.push({
          vendorId: vendor.id,
          vendorName: vendor.name,
          email: vendor.email,
          joinedDate: vendor.created_at,
          totalStreams,
          totalRevenue,
          totalOrders,
          averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
          conversionRate: Math.random() * 10, // Mock data
          rating: 4.0 + Math.random() * 1, // Mock rating between 4-5
          status: totalStreams > 0 ? 'active' : 'inactive',
        });
      }

      // Sort by total revenue
      vendorAnalytics.sort((a, b) => b.totalRevenue - a.totalRevenue);

      return {
        vendors: vendorAnalytics,
        total: vendors?.length || 0,
        period,
      };
    } catch (error) {
      console.error('Error fetching vendor analytics:', error);
      throw error;
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

      return {
        period,
        userStats,
        platformMetrics,
        revenueGrowth: 15.2, // Mock growth percentage
        orderGrowth: 12.8, // Mock growth percentage
        userGrowth: 8.5, // Mock growth percentage
      };
    } catch (error) {
      console.error('Error fetching platform overview:', error);
      throw error;
    }
  }

  /**
   * Get geographic analytics
   */
  async getGeographicAnalytics(
    period: 'today' | 'week' | 'month' | 'quarter',
    userToken?: string,
  ) {
    // This would typically involve IP-based location tracking or user-provided location data
    // For now, returning mock data based on major Nigerian cities
    return [
      { region: 'Lagos', revenue: 450000, viewers: 18500, streams: 1200, orders: 2800 },
      { region: 'Abuja', revenue: 280000, viewers: 12800, streams: 850, orders: 1650 },
      { region: 'Kano', revenue: 220000, viewers: 11200, streams: 720, orders: 1320 },
      { region: 'Port Harcourt', revenue: 180000, viewers: 8900, streams: 580, orders: 980 },
      { region: 'Ibadan', revenue: 150000, viewers: 7500, streams: 480, orders: 850 },
      { region: 'Benin City', revenue: 120000, viewers: 6200, streams: 380, orders: 720 },
    ];
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
          throw new Error('Invalid export type');
      }

      // In a real implementation, you would generate the actual file here
      // For now, return a download URL or file identifier
      const exportId = `export_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      return {
        exportId,
        downloadUrl: `/api/admin/analytics/exports/${exportId}`,
        format: exportRequest.format,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      };
    } catch (error) {
      console.error('Error exporting analytics data:', error);
      throw error;
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