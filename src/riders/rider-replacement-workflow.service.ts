import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NotificationHelperService } from '../notifications/notification-helper.service';

@Injectable()
export class RiderReplacementWorkflowService {
  private readonly logger = new Logger(RiderReplacementWorkflowService.name);
  private supabase: SupabaseClient;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
  ) {
    this.supabase = createClient(
      this.configService.get<string>('SUPABASE_URL')!,
      this.configService.get<string>('SUPABASE_SERVICE_KEY')!,
    );
  }

  // Main replacement workflow - two-stage process
  async initiateReplacementWorkflow(orderId: string): Promise<{
    success: boolean;
    stage: 'vendor_selection' | 'fastest_finger' | 'completed' | 'failed';
    message: string;
    data?: any;
  }> {
    try {
      console.log(`🔄 Initiating replacement workflow for order ${orderId}`);

      // Get order details
      const { data: order, error } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          delivery_fee,
          delivery_address,
          vendor_id,
          buyer_id,
          replacement_attempts,
          user_profiles!inner(location)
        `)
        .eq('id', orderId)
        .single();

      if (error || !order) {
        console.error('❌ Order not found for replacement workflow:', error);
        return { success: false, stage: 'failed', message: 'Order not found' };
      }

      // Check if we've exceeded maximum replacement attempts
      const maxAttempts = 3;
      if (order.replacement_attempts >= maxAttempts) {
        console.log(`❌ Maximum replacement attempts (${maxAttempts}) exceeded for order ${order.order_number}`);
        
        // Notify vendor and buyer
        await this.notifyReplacementLimitReached(order);
        
        return { 
          success: false, 
          stage: 'failed', 
          message: `Maximum replacement attempts (${maxAttempts}) exceeded` 
        };
      }

      // Stage 1: Vendor Selection (5 minutes)
      console.log(`🔄 Stage 1: Starting vendor selection for order ${order.order_number}`);
      
      const vendorSelectionResult = await this.initiateVendorSelection(order);
      
      if (vendorSelectionResult.success) {
        return vendorSelectionResult;
      }

      // Stage 2: Fastest Finger
      console.log(`🚀 Stage 2: Starting fastest-finger workflow for order ${order.order_number}`);
      return await this.initiateFastestFingerWorkflow(order);

    } catch (error) {
      console.error('❌ Error initiating replacement workflow:', error);
      return { success: false, stage: 'failed', message: 'Internal server error' };
    }
  }

  private async initiateVendorSelection(order: any): Promise<{
    success: boolean;
    stage: 'vendor_selection' | 'failed';
    message: string;
    data?: any;
  }> {
    try {
      const vendorLocation = order.user_profiles?.location;
      if (!vendorLocation) {
        console.error('❌ Vendor location not found for replacement workflow');
        return { success: false, stage: 'failed', message: 'Vendor location not found' };
      }

      // Find nearby riders within 15km
      const { data: nearbyRiders } = await this.supabase.rpc('find_nearby_riders', {
        pickup_lat: vendorLocation.latitude,
        pickup_lon: vendorLocation.longitude,
        max_distance: 15.0,
      });

      if (!nearbyRiders || nearbyRiders.length === 0) {
        console.log(`❌ No riders found within 15km for order ${order.order_number}`);
        return { success: false, stage: 'vendor_selection', message: 'No riders found' };
      }

      // Get rider profiles for scoring
      const riderIds = nearbyRiders.map(r => r.rider_id);
      const { data: riderProfiles } = await this.supabase
        .from('rider_profiles')
        .select('*')
        .in('user_id', riderIds);

      const { data: trustScores } = await this.supabase
        .from('trust_scores')
        .select('user_id, rider_trust_score, completed_orders')
        .in('user_id', riderIds);

      // Score and rank riders
      const scoredRiders = await this.scoreRidersForReplacement(
        nearbyRiders, 
        riderProfiles || [], 
        trustScores || [], 
        order,
        vendorLocation
      );

      // Set vendor selection deadline (5 minutes)
      const vendorDeadline = new Date(Date.now() + 5 * 60 * 1000);
      
      await this.supabase
        .from('orders')
        .update({
          metadata: {
            replacement_stage: 'vendor_selection',
            replacement_deadline: vendorDeadline.toISOString(),
            available_riders: scoredRiders.slice(0, 10),
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', order.id);

      // Notify vendor about replacement options
      try {
        await this.notificationHelper.notifySystemUpdate(order.vendor_id, 'Replacement Needed', `Replacement riders needed for order ${order.order_number}. Available riders: ${scoredRiders.slice(0, 5).length}`, {
          orderId: order.id,
          orderNumber: order.order_number,
          availableRiders: scoredRiders.slice(0, 5),
          deadline: vendorDeadline.toISOString(),
        });

        console.log(`✅ Vendor notified of replacement options for order ${order.order_number}`);
      } catch (notifyError) {
        console.error('Failed to notify vendor:', notifyError);
      }

      return {
        success: true,
        stage: 'vendor_selection',
        message: 'Vendor selection stage initiated - 5 minutes to choose rider',
        data: {
          availableRiders: scoredRiders.slice(0, 5),
          deadline: vendorDeadline.toISOString(),
        }
      };

    } catch (error) {
      console.error('❌ Error in vendor selection:', error);
      return { success: false, stage: 'failed', message: 'Vendor selection failed' };
    }
  }

  private async initiateFastestFingerWorkflow(order: any): Promise<{
    success: boolean;
    stage: 'fastest_finger' | 'completed' | 'failed';
    message: string;
  }> {
    try {
      console.log(`🚀 Stage 2: Starting fastest-finger workflow for order ${order.order_number}`);

      // Progressive radius search: 2km → 5km → 10km → 15km
      const radii = [2, 5, 10, 15];
      const vendorLocation = order.user_profiles?.location;

      for (const radius of radii) {
        console.log(`🚀 Sending broadcast to all riders within ${radius}km`);

        // Find riders within this radius
        const { data: ridersInRadius } = await this.supabase.rpc('find_nearby_riders', {
          pickup_lat: vendorLocation.latitude,
          pickup_lon: vendorLocation.longitude,
          max_distance: radius,
        });

        if (!ridersInRadius || ridersInRadius.length === 0) {
          console.log(`❌ No riders found within ${radius}km, expanding...`);
          continue;
        }

        // Create broadcast assignment
        const broadcastId = await this.createBroadcastAssignment(
          order.id,
          ridersInRadius.map(r => r.rider_id),
          radius
        );

        // Send broadcast to all riders simultaneously
        await this.sendBroadcastToRiders(ridersInRadius, {
          orderId: order.id,
          orderNumber: order.order_number,
          deliveryFee: order.delivery_fee,
          pickupAddress: vendorLocation?.address || 'Vendor Location',
          deliveryAddress: order.delivery_address?.address || 'Delivery Location',
          broadcastId,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        // Wait for first acceptance or timeout
        const result = await this.waitForBroadcastAcceptance(broadcastId, 5 * 60 * 1000);

        if (result.accepted) {
          console.log(`✅ Rider ${result.riderId} accepted broadcast assignment for order ${order.order_number}`);
          
          // Assign rider to order (this would call the riders service)
          // For now, just return success
          return {
            success: true,
            stage: 'completed',
            message: `Rider assigned successfully via fastest-finger at ${radius}km radius`
          };
        } else {
          console.log(`⏰ No riders accepted within ${radius}km radius, expanding...`);
          
          // Mark broadcast as expired
          await this.supabase
            .from('broadcast_assignments')
            .update({ status: 'expired' })
            .eq('id', broadcastId);
        }
      }

      // No riders accepted at any radius
      console.log(`❌ No riders accepted fastest-finger for order ${order.order_number}`);
      
      // Notify vendor and buyer
      await this.notifyNoRidersAvailable(order);

      return {
        success: false,
        stage: 'failed',
        message: 'No riders available in any radius'
      };

    } catch (error) {
      console.error('❌ Error in fastest-finger workflow:', error);
      return { success: false, stage: 'failed', message: 'Fastest-finger workflow failed' };
    }
  }

  private async createBroadcastAssignment(orderId: string, riderIds: string[], radius: number): Promise<string> {
    const { data, error } = await this.supabase
      .from('broadcast_assignments')
      .insert({
        order_id: orderId,
        radius_km: radius,
        rider_ids: riderIds,
        status: 'active',
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    if (error || !data) {
      throw new Error('Failed to create broadcast assignment');
    }

    return data.id;
  }

  private async sendBroadcastToRiders(riders: any[], broadcastData: any): Promise<void> {
    for (const rider of riders) {
      try {
        await this.notificationHelper.notifyRiderNewAssignment(rider.rider_id, {
          ...broadcastData,
          riderName: rider.rider_name,
        });
      } catch (error) {
        console.error(`Failed to send broadcast to rider ${rider.rider_id}:`, error);
      }
    }
  }

  private async waitForBroadcastAcceptance(broadcastId: string, timeoutMs: number): Promise<{
    accepted: boolean;
    riderId?: string;
  }> {
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds

    while (Date.now() - startTime < timeoutMs) {
      // Check if broadcast has been accepted
      const { data: broadcast } = await this.supabase
        .from('broadcast_assignments')
        .select('status, accepted_by')
        .eq('id', broadcastId)
        .single();

      if (broadcast?.status === 'accepted' && broadcast.accepted_by) {
        return { accepted: true, riderId: broadcast.accepted_by };
      }

      if (broadcast?.status === 'expired') {
        return { accepted: false };
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    return { accepted: false };
  }

  private async scoreRidersForReplacement(
    nearbyRiders: any[],
    riderProfiles: any[],
    trustScores: any[],
    order: any,
    vendorLocation: any
  ): Promise<any[]> {
    return nearbyRiders.map(rider => {
      const profile = riderProfiles.find(rp => rp.user_id === rider.rider_id);
      const trustData = trustScores.find(ts => ts.user_id === rider.rider_id);
      
      // Calculate distance score (40%)
      const distance = rider.distance || 1;
      const distanceScore = Math.max(0, 40 - (distance * 4)); // 40 points max, 4 points per km
      
      // Calculate rating score (30%)
      const rating = trustData?.rider_trust_score || 750;
      const ratingScore = (rating / 1000) * 30; // 30 points max
      
      // Calculate experience score (20%)
      const completedOrders = trustData?.completed_orders || 0;
      const experienceScore = Math.min(20, completedOrders * 0.1); // 20 points max
      
      // Calculate availability score (10%)
      const availabilityScore = rider.is_available ? 10 : 0;
      
      const totalScore = distanceScore + ratingScore + experienceScore + availabilityScore;

      return {
        riderId: rider.rider_id,
        riderName: rider.rider_name,
        distance: distance,
        rating: rating,
        completedOrders: completedOrders,
        isAvailable: rider.is_available,
        score: Math.round(totalScore),
        vehicleType: profile?.vehicle_type || 'bike',
        specialties: this.getSpecialtiesByVehicle(profile?.vehicle_type || 'bike'),
      };
    }).sort((a, b) => b.score - a.score);
  }

  private getSpecialtiesByVehicle(vehicleType: string): string[] {
    switch (vehicleType) {
      case 'wheelbarrow': return ['Eco-friendly', 'Local delivery', 'Fresh produce'];
      case 'bike': return ['Fast delivery', 'Electronics', 'Same-day delivery'];
      case 'car': return ['Bulk delivery', 'Long distance', 'Heavy items'];
      default: return [];
    }
  }

  private async notifyReplacementLimitReached(order: any): Promise<void> {
    try {
      await this.notificationHelper.notifySystemUpdate(order.vendor_id, 'Replacement Limit Reached', `Maximum replacement attempts (3) reached for order ${order.order_number}`, {
        orderId: order.id,
        orderNumber: order.order_number,
        maxAttempts: 3,
      });

      await this.notificationHelper.notifySystemUpdate(order.buyer_id, 'Replacement Limit Reached', `Maximum replacement attempts (3) reached for order ${order.order_number}`, {
        orderId: order.id,
        orderNumber: order.order_number,
        maxAttempts: 3,
      });
    } catch (error) {
      console.error('Failed to send limit reached notifications:', error);
    }
  }

  private async notifyNoRidersAvailable(order: any): Promise<void> {
    try {
      await this.notificationHelper.notifySystemUpdate(order.vendor_id, 'No Riders Available', `No riders available for replacement of order ${order.order_number}`, {
        orderId: order.id,
        orderNumber: order.order_number,
      });

      await this.notificationHelper.notifySystemUpdate(order.buyer_id, 'No Riders Available', `No riders available for replacement of order ${order.order_number}`, {
        orderId: order.id,
        orderNumber: order.order_number,
      });
    } catch (error) {
      console.error('Failed to send no riders notifications:', error);
    }
  }

  // Method to handle vendor rider selection
  async handleVendorRiderSelection(orderId: string, riderId: string, vendorId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      console.log(`🎯 Vendor ${vendorId} selected rider ${riderId} for order ${orderId}`);

      // Verify this is a valid replacement workflow
      const { data: order } = await this.supabase
        .from('orders')
        .select('metadata, vendor_id, order_number')
        .eq('id', orderId)
        .single();

      if (!order || order.vendor_id !== vendorId) {
        return { success: false, message: 'Unauthorized or invalid order' };
      }

      const metadata = order.metadata || {};
      if (metadata.replacement_stage !== 'vendor_selection') {
        return { success: false, message: 'Not in vendor selection stage' };
      }

      // Check if deadline has passed
      const deadline = new Date(metadata.replacement_deadline);
      if (deadline < new Date()) {
        return { success: false, message: 'Vendor selection deadline expired' };
      }

      // Assign the rider (this would call riders service)
      // For now, just update the order status
      await this.supabase
        .from('orders')
        .update({
          rider_id: riderId,
          rider_acceptance_status: 'pending',
          rider_assignment_deadline: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          metadata: {
            ...metadata,
            replacement_stage: 'completed',
            vendor_selected_rider: riderId,
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      console.log(`✅ Vendor selected rider ${riderId} for order ${order.order_number}`);
      
      return { success: true, message: 'Rider selected successfully' };

    } catch (error) {
      console.error('❌ Error handling vendor rider selection:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  // Method to check replacement status
  async getReplacementStatus(orderId: string): Promise<{
    stage: string;
    deadline?: string;
    availableRiders?: any[];
    message: string;
  }> {
    try {
      const { data: order } = await this.supabase
        .from('orders')
        .select('metadata, replacement_attempts, order_number')
        .eq('id', orderId)
        .single();

      if (!order) {
        return { stage: 'not_found', message: 'Order not found' };
      }

      const metadata = order.metadata || {};
      const stage = metadata.replacement_stage || 'none';

      if (stage === 'vendor_selection') {
        return {
          stage,
          deadline: metadata.replacement_deadline,
          availableRiders: metadata.available_riders || [],
          message: 'Vendor selection in progress'
        };
      }

      if (stage === 'fastest_finger') {
        return {
          stage,
          message: 'Fastest-finger broadcast in progress'
        };
      }

      return {
        stage,
        message: 'No replacement in progress'
      };

    } catch (error) {
      console.error('❌ Error getting replacement status:', error);
      return { stage: 'error', message: 'Error checking status' };
    }
  }
}
