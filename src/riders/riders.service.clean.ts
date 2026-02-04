import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NotificationHelperService } from '../notifications/notification-helper.service';

export interface RiderLocation {
  latitude: number;
  longitude: number;
  address: string;
}

export interface OrderDetails {
  weight: number;
  itemCount: number;
  distance: number;
  category?: string;
}

export interface RiderAvailabilityRequest {
  pickupLocation: RiderLocation;
  deliveryLocation: RiderLocation;
  orderDetails: OrderDetails;
  maxDistance?: number;
}

export interface RiderProfile {
  id: string;
  name: string;
  avatar: string;
  rating: number;
  totalDeliveries: number;
  vehicleType: 'wheelbarrow' | 'bike' | 'car';
  price: number;
  distanceFromPickup: number;
  estimatedArrival: number;
  isAvailable: boolean;
  unavailableReason?: string;
  specialties: string[];
  isOnline: boolean;
  trustScore?: number;
  completionRate?: number;
  deliveryPromise?: string;
}

@Injectable()
export class RidersService {
  private readonly logger = new Logger(RidersService.name);
  private supabase: SupabaseClient;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
  ) {
    this.supabase = createClient(
      this.configService.get<string>('SUPABASE_URL')!,
      this.configService.get<string>('SUPABASE_ANON_KEY')!,
    );
  }

  async findNearbyRiders(
    request: RiderAvailabilityRequest,
    userId: string,
  ): Promise<RiderProfile[]> {
    try {
      console.log('🔍 Finding nearby riders for request:', {
        pickup: request.pickupLocation.address,
        orderDetails: request.orderDetails,
        userId,
      });

      // Use the database function to find nearby riders
      const { data: nearbyRiders, error } = await this.supabase.rpc('find_nearby_riders', {
        pickup_lat: request.pickupLocation.latitude,
        pickup_lon: request.pickupLocation.longitude,
        max_distance: request.maxDistance || 5.0,
      });

      if (error) {
        console.error('❌ Error finding nearby riders:', error);
        return this.getMockRiders(request);
      }

      if (!nearbyRiders || nearbyRiders.length === 0) {
        console.log('📍 No nearby riders found, returning mock data');
        return this.getMockRiders(request);
      }

      // Get rider profiles and trust scores
      const riderIds = nearbyRiders.map(r => r.rider_id);
      const { data: riderProfiles } = await this.supabase
        .from('rider_profiles')
        .select('*')
        .in('user_id', riderIds);

      const { data: trustScores } = await this.supabase
        .from('trust_scores')
        .select('user_id, rider_trust_score, completed_orders')
        .in('user_id', riderIds);

      // Transform database riders to RiderProfile format
      const riders: RiderProfile[] = await Promise.all(
        nearbyRiders.map(async (rider) => {
          const trustData = trustScores?.find(ts => ts.user_id === rider.rider_id);
          const riderProfileData = riderProfiles?.find(rp => rp.user_id === rider.rider_id);
          
          // Use rider_profiles data if available, otherwise fallback to defaults
          const vehicleType = riderProfileData?.vehicle_type || 'bike';
          const isOnline = rider.is_available;
          
          // Calculate price based on rider's service_pricing if available
          let price: number;
          let deliveryPromise: string | undefined;
          
          if (riderProfileData?.service_pricing) {
            const servicePricing = riderProfileData.service_pricing['intracity'];
            
            if (servicePricing?.enabled) {
              if (servicePricing.custom_price) {
                price = servicePricing.custom_price;
              } else {
                const distance = rider.distance || 1; // Default to 1km if not provided
                price = (servicePricing.base_price || 2) + (distance * (servicePricing.per_km_rate || 0.5));
              }
            } else {
              // Fallback to default pricing
              price = this.getBasePriceByVehicle(vehicleType);
            }
            
            // Get delivery promise message
            if (riderProfileData.delivery_promise_message) {
              deliveryPromise = riderProfileData.delivery_promise_message;
            }
          } else {
            // Fallback to mock pricing
            price = this.getBasePriceByVehicle(vehicleType);
          }
          
          return {
            id: rider.rider_id,
            name: rider.rider_name || 'Unknown Rider',
            avatar: `https://picsum.photos/100/100?random=${rider.rider_id}`,
            rating: this.calculateRating(trustData?.completed_orders || 0),
            totalDeliveries: trustData?.completed_orders || 0,
            vehicleType: ['wheelbarrow', 'bike', 'car', 'van', 'truck'].includes(vehicleType) ? vehicleType as any : 'bike',
            price: Math.round(price * 100) / 100,
            distanceFromPickup: Math.round((rider.distance || 1) * 10) / 10,
            estimatedArrival: Math.max(3, Math.round((rider.distance || 1) * 3)), // 3 min per km minimum
            isAvailable: rider.is_available,
            specialties: this.getSpecialtiesByVehicle(vehicleType),
            isOnline: isOnline,
            trustScore: trustData?.rider_trust_score || 750,
            completionRate: Math.min(99, 85 + (trustData?.completed_orders || 0) / 10),
            deliveryPromise: deliveryPromise,
          };
        })
      );

      // Filter and sort riders
      return riders
        .filter(rider => rider.isOnline)
        .sort((a, b) => {
          // Prioritize available riders
          if (a.isAvailable !== b.isAvailable) return a.isAvailable ? -1 : 1;
          // Then by distance
          return a.distanceFromPickup - b.distanceFromPickup;
        });

    } catch (error) {
      console.error('❌ Error in findNearbyRiders:', error);
      return this.getMockRiders(request);
    }
  }

  async getRiderRecommendations(
    request: RiderAvailabilityRequest,
    userId: string,
  ): Promise<Array<{ riderId: string; score: number; reasons: string[] }>> {
    const riders = await this.findNearbyRiders(request, userId);
    
    return riders
      .filter(rider => rider.isAvailable)
      .slice(0, 3) // Top 3 recommendations
      .map(rider => ({
        riderId: rider.id,
        score: this.calculateRecommendationScore(rider, request),
        reasons: this.getRecommendationReasons(rider, request),
      }))
      .sort((a, b) => b.score - a.score);
  }

  async checkRiderAvailability(
    riderId: string,
    orderDetails: OrderDetails,
  ): Promise<{ available: boolean; reason?: string; estimatedArrival?: number }> {
    try {
      // Get rider profile
      const { data: profile, error } = await this.supabase
        .from('user_profiles')
        .select('preferences')
        .eq('id', riderId)
        .eq('is_rider', true)
        .single();

      if (error || !profile) {
        return { available: false, reason: 'Rider not found' };
      }

      const vehicleType = profile.preferences?.vehicleType || 'bike';
      const isAvailable = this.checkAvailability(vehicleType, orderDetails);
      
      return {
        available: isAvailable,
        reason: isAvailable ? undefined : this.getUnavailableReason(vehicleType, orderDetails),
        estimatedArrival: isAvailable ? Math.max(5, Math.random() * 15) : undefined,
      };
    } catch (error) {
      console.error('❌ Error checking rider availability:', error);
      return { available: false, reason: 'System error' };
    }
  }

  async getRiderProfile(riderId: string): Promise<RiderProfile | null> {
    try {
      const { data: profile, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id,
          username,
          avatar_url,
          location,
          preferences
        `)
        .eq('id', riderId)
        .eq('is_rider', true)
        .single();

      if (error || !profile) {
        return null;
      }

      const { data: trustData } = await this.supabase
        .from('trust_scores')
        .select('rider_trust_score, completed_orders')
        .eq('user_id', riderId)
        .single();

      const vehicleType = profile.preferences?.vehicleType || 'bike';
      
      return {
        id: profile.id,
        name: profile.username || 'Unknown Rider',
        avatar: profile.avatar_url || `https://picsum.photos/100/100?random=${profile.id}`,
        rating: this.calculateRating(trustData?.completed_orders || 0),
        totalDeliveries: trustData?.completed_orders || 0,
        vehicleType: ['wheelbarrow', 'bike', 'car'].includes(vehicleType) ? vehicleType as 'wheelbarrow' | 'bike' | 'car' : 'bike',
        price: this.getBasePriceByVehicle(vehicleType),
        distanceFromPickup: 0,
        estimatedArrival: 5,
        isAvailable: true,
        specialties: this.getSpecialtiesByVehicle(vehicleType),
        isOnline: true,
        trustScore: trustData?.rider_trust_score || 750,
        completionRate: Math.min(99, 85 + (trustData?.completed_orders || 0) / 10),
      };
    } catch (error) {
      console.error('❌ Error getting rider profile:', error);
      return null;
    }
  }

  async getRiderStats(riderId: string): Promise<{
    totalDeliveries: number;
    avgRating: number;
    completionRate: number;
    avgDeliveryTime: number;
    specialties: string[];
  }> {
    try {
      const { data: trustData } = await this.supabase
        .from('trust_scores')
        .select('*')
        .eq('user_id', riderId)
        .single();

      const { data: profile } = await this.supabase
        .from('user_profiles')
        .select('preferences')
        .eq('id', riderId)
        .single();

      const completedOrders = trustData?.completed_orders || 0;
      const vehicleType = profile?.preferences?.vehicleType || 'bike';
      
      return {
        totalDeliveries: completedOrders,
        avgRating: this.calculateRating(completedOrders),
        completionRate: Math.min(99, 85 + completedOrders / 10),
        avgDeliveryTime: this.getAvgDeliveryTime(vehicleType),
        specialties: this.getSpecialtiesByVehicle(vehicleType),
      };
    } catch (error) {
      console.error('❌ Error getting rider stats:', error);
      return {
        totalDeliveries: 0,
        avgRating: 0,
        completionRate: 0,
        avgDeliveryTime: 30,
        specialties: [],
      };
    }
  }

  async assignRiderToOrder(
    riderId: string,
    orderId: string,
    userId: string,
  ): Promise<{ success: boolean; estimatedPickup?: string; estimatedDelivery?: string }> {
    try {
      // Fetch order details for notification - allow both buyer and vendor
      const { data: order } = await this.supabase
        .from('orders')
        .select('order_number, delivery_fee, delivery_address, vendor_id, total_amount, buyer_id')
        .eq('id', orderId)
        .or(`buyer_id.eq.${userId},vendor_id.eq.${userId}`) // Allow both buyer and vendor
        .single();

      if (!order) {
        console.error('❌ Order not found or unauthorized');
        return { success: false };
      }

      // Update order with rider assignment and set acceptance deadline
      const deadline = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
      const now = new Date();
      const estimatedPickup = new Date(now.getTime() + 15 * 60000).toISOString(); // 15 min
      const estimatedDelivery = new Date(now.getTime() + 45 * 60000).toISOString(); // 45 min
      
      const { error } = await this.supabase
        .from('orders')
        .update({
          rider_id: riderId,
          status: 'assigned',
          rider_acceptance_status: 'pending',
          rider_assignment_deadline: deadline.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .or(`buyer_id.eq.${userId},vendor_id.eq.${userId}`);

      if (error) {
        console.error('❌ Error assigning rider:', error);
        return { success: false };
      }

      // ✅ NOTIFY RIDER OF NEW ASSIGNMENT
      try {
        // Get vendor location/address for pickup
        const { data: vendor } = await this.supabase
          .from('user_profiles')
          .select('location')
          .eq('id', order.vendor_id)
          .single();

        const pickupAddress = vendor?.location?.address || 'Vendor Location';
        const deliveryAddress = order.delivery_address?.address || 'Delivery Location';
        
        // Calculate estimated earnings (10% of total for rider)
        const estimatedEarnings = order.total_amount * 0.10;

        await this.notificationHelper.notifyRiderNewAssignment(riderId, {
          id: orderId,
          orderNumber: order.order_number,
          deliveryFee: order.delivery_fee || estimatedEarnings,
          pickupAddress,
          deliveryAddress,
          estimatedEarnings,
        });
        console.log(`✅ Rider ${riderId} notified of new assignment ${order.order_number}`);
      } catch (notifyError) {
        console.error('Failed to notify rider (non-critical):', notifyError);
      }

      return {
        success: true,
        estimatedPickup,
        estimatedDelivery,
      };
    } catch (error) {
      console.error('❌ Error in assignRiderToOrder:', error);
      return { success: false };
    }
  }

  // ===== RIDER ASSIGNMENT METHODS =====

  async acceptRiderAssignment(orderId: string, riderId: string): Promise<{
    success: boolean;
    message: string;
    order?: {
      id: string;
      orderNumber: string;
      deliveryFee: number;
      pickupAddress: string;
      deliveryAddress: string;
      estimatedPickup: string;
      estimatedDelivery: string;
    };
  }> {
    try {
      console.log(`✅ Rider ${riderId} accepting assignment for order ${orderId}`);

      // Get order details and verify assignment
      const { data: order, error: orderError } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          delivery_fee,
          delivery_address,
          rider_id,
          rider_acceptance_status,
          rider_assignment_deadline,
          vendor_id,
          buyer_id,
          user_profiles!inner(username, location)
        `)
        .eq('id', orderId)
        .eq('rider_id', riderId)
        .single();

      if (orderError || !order) {
        console.error('❌ Order not found or rider not assigned:', orderError);
        return { success: false, message: 'Order not found or rider not assigned' };
      }

      // Check if assignment is still pending
      if (order.rider_acceptance_status !== 'pending') {
        const statusMessage = {
          'accepted': 'Assignment already accepted',
          'rejected': 'Assignment already rejected',
          'timeout': 'Assignment deadline expired',
          'reassigned': 'Order has been reassigned'
        }[order.rider_acceptance_status] || 'Assignment no longer pending';

        return { success: false, message: statusMessage };
      }

      // Check if deadline has passed
      if (order.rider_assignment_deadline && new Date() > new Date(order.rider_assignment_deadline)) {
        // Update status to timeout
        await this.supabase
          .from('orders')
          .update({
            rider_acceptance_status: 'timeout',
            updated_at: new Date().toISOString()
          })
          .eq('id', orderId);

        return { success: false, message: 'Assignment deadline has expired' };
      }

      // Accept the assignment
      const { error: updateError } = await this.supabase
        .from('orders')
        .update({
          rider_acceptance_status: 'accepted',
          status: 'assigned',
          updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (updateError) {
        console.error('❌ Error accepting assignment:', updateError);
        return { success: false, message: 'Failed to accept assignment' };
      }

      // Calculate estimated times
      const now = new Date();
      const estimatedPickup = new Date(now.getTime() + 15 * 60000).toISOString();
      const estimatedDelivery = new Date(now.getTime() + 45 * 60000).toISOString();

      // Get vendor location for pickup address
      const pickupAddress = order.user_profiles?.[0]?.location?.address || 'Vendor Location';
      const deliveryAddress = order.delivery_address?.address || 'Delivery Location';

      // Notify vendor and buyer
      try {
        await this.notificationHelper.notifyOrderAccepted(order.buyer_id, {
          orderId,
          orderNumber: order.order_number,
          vendorId: order.vendor_id,
        });

        console.log(`✅ Notifications sent for accepted assignment ${order.order_number}`);
      } catch (notifyError) {
        console.error('Failed to send notifications (non-critical):', notifyError);
      }

      console.log(`✅ Rider ${riderId} accepted assignment for order ${order.order_number}`);

      return {
        success: true,
        message: 'Assignment accepted successfully',
        order: {
          id: order.id,
          orderNumber: order.order_number,
          deliveryFee: order.delivery_fee,
          pickupAddress,
          deliveryAddress,
          estimatedPickup,
          estimatedDelivery,
        }
      };

    } catch (error) {
      console.error('❌ Error accepting rider assignment:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async rejectRiderAssignment(orderId: string, riderId: string, reason?: string): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      console.log(`❌ Rider ${riderId} rejecting assignment for order ${orderId}`, { reason });

      // Get order details and verify assignment
      const { data: order, error: orderError } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          rider_id,
          rider_acceptance_status,
          vendor_id,
          buyer_id,
          replacement_attempts
        `)
        .eq('id', orderId)
        .eq('rider_id', riderId)
        .single();

      if (orderError || !order) {
        console.error('❌ Order not found or rider not assigned:', orderError);
        return { success: false, message: 'Order not found or rider not assigned' };
      }

      // Check if assignment is still pending
      if (order.rider_acceptance_status !== 'pending') {
        const statusMessage = {
          'accepted': 'Assignment already accepted',
          'rejected': 'Assignment already rejected',
          'timeout': 'Assignment deadline expired',
          'reassigned': 'Order has been reassigned'
        }[order.rider_acceptance_status] || 'Assignment no longer pending';

        return { success: false, message: statusMessage };
      }

      // Reject the assignment
      const { error: updateError } = await this.supabase
        .from('orders')
        .update({
          rider_acceptance_status: 'rejected',
          rider_id: null, // Remove rider from order
          replacement_attempts: (order.replacement_attempts || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (updateError) {
        console.error('❌ Error rejecting assignment:', updateError);
        return { success: false, message: 'Failed to reject assignment' };
      }

      // Notify vendor and buyer
      try {
        await this.notificationHelper.notifySystemUpdate(order.vendor_id, 'Rider Assignment Rejected', `Rider ${riderId} rejected assignment for order ${order.order_number}`, {
          orderId,
          orderNumber: order.order_number,
          riderId,
          reason,
        });

        console.log(`✅ Notifications sent for rejected assignment ${order.order_number}`);
      } catch (notifyError) {
        console.error('Failed to send notifications (non-critical):', notifyError);
      }

      console.log(`❌ Rider ${riderId} rejected assignment for order ${order.order_number}`);

      return { success: true, message: 'Assignment rejected successfully' };

    } catch (error) {
      console.error('❌ Error rejecting rider assignment:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async getPendingAssignments(riderId: string): Promise<{
    assignments: Array<{
      id: string;
      orderNumber: string;
      deliveryFee: number;
      pickupAddress: string;
      deliveryAddress: string;
      assignedAt: string;
      deadline: string;
      timeRemaining: number;
    }>;
  }> {
    try {
      console.log(`📋 Getting pending assignments for rider ${riderId}`);

      const { data: assignments, error } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          delivery_fee,
          delivery_address,
          rider_assignment_deadline,
          updated_at,
          user_profiles!inner(location)
        `)
        .eq('rider_id', riderId)
        .eq('rider_acceptance_status', 'pending')
        .order('updated_at', { ascending: false });

      if (error) {
        console.error('❌ Error fetching pending assignments:', error);
        return { assignments: [] };
      }

      const processedAssignments = assignments.map(assignment => {
        const now = new Date();
        const deadline = new Date(assignment.rider_assignment_deadline);
        const timeRemaining = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));

        return {
          id: assignment.id,
          orderNumber: assignment.order_number,
          deliveryFee: assignment.delivery_fee,
          pickupAddress: assignment.user_profiles?.[0]?.location?.address || 'Vendor Location',
          deliveryAddress: assignment.delivery_address?.address || 'Delivery Location',
          assignedAt: assignment.updated_at,
          deadline: assignment.rider_assignment_deadline,
          timeRemaining,
        };
      });

      return { assignments: processedAssignments };

    } catch (error) {
      console.error('❌ Error getting pending assignments:', error);
      return { assignments: [] };
    }
  }

  // ===== LOCATION TRACKING METHODS =====

  async updateRiderLocation(
    riderId: string,
    latitude: number,
    longitude: number,
    accuracy?: number,
    isOnline: boolean = true,
    isAvailable: boolean = true,
    batteryLevel?: number,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      // Use the database function to update/insert rider location
      const { data, error } = await this.supabase.rpc('update_rider_location', {
        rider_id: riderId,
        new_lat: latitude,
        new_lon: longitude,
        new_accuracy: accuracy,
        online_status: isOnline,
        available_status: isAvailable,
      });

      if (error) {
        console.error('❌ Error updating rider location:', error);
        return { success: false, message: error.message };
      }

      // Optionally update battery level separately if provided
      if (batteryLevel !== undefined) {
        await this.supabase
          .from('rider_locations')
          .update({ battery_level: batteryLevel })
          .eq('user_id', riderId);
      }

      return { success: true, message: 'Location updated successfully' };
    } catch (error) {
      console.error('❌ Error in updateRiderLocation:', error);
      return { success: false, message: 'System error' };
    }
  }

  async getRiderLocation(riderId: string): Promise<{
    latitude: number;
    longitude: number;
    accuracy?: number;
    isOnline: boolean;
    isAvailable: boolean;
    lastPing: string;
    batteryLevel?: number;
    currentOrderId?: string;
  } | null> {
    try {
      const { data, error } = await this.supabase
        .from('rider_locations')
        .select('*')
        .eq('user_id', riderId)
        .single();

      if (error || !data) {
        console.log(`📍 No location data found for rider ${riderId}`);
        return null;
      }

      return {
        latitude: parseFloat(data.latitude),
        longitude: parseFloat(data.longitude),
        accuracy: data.accuracy ? parseFloat(data.accuracy) : undefined,
        isOnline: data.is_online,
        isAvailable: data.is_available,
        lastPing: data.last_ping,
        batteryLevel: data.battery_level,
        currentOrderId: data.current_order_id,
      };
    } catch (error) {
      console.error('❌ Error getting rider location:', error);
      return null;
    }
  }

  async toggleRiderStatus(
    riderId: string,
    isOnline?: boolean,
    isAvailable?: boolean,
  ): Promise<{ success: boolean }> {
    try {
      const updates: any = {};
      if (isOnline !== undefined) updates.is_online = isOnline;
      if (isAvailable !== undefined) updates.is_available = isAvailable;

      const { error } = await this.supabase
        .from('rider_locations')
        .update(updates)
        .eq('user_id', riderId);

      if (error) {
        console.error('❌ Error toggling rider status:', error);
        return { success: false };
      }

      return { success: true };
    } catch (error) {
      console.error('❌ Error in toggleRiderStatus:', error);
      return { success: false };
    }
  }

  async setRiderActiveOrder(riderId: string, orderId: string | null): Promise<{ success: boolean }> {
    try {
      const { error } = await this.supabase
        .from('rider_locations')
        .update({ current_order_id: orderId })
        .eq('user_id', riderId);

      if (error) {
        console.error('❌ Error setting rider active order:', error);
        return { success: false };
      }

      return { success: true };
    } catch (error) {
      console.error('❌ Error in setRiderActiveOrder:', error);
      return { success: false };
    }
  }

  // ===== HELPER METHODS =====

  private checkAvailability(vehicleType: string, orderDetails: OrderDetails): boolean {
    switch (vehicleType) {
      case 'wheelbarrow':
        return orderDetails.distance <= 1.0 && orderDetails.weight <= 15;
      case 'bike':
        return orderDetails.weight <= 20 && orderDetails.itemCount <= 5;
      case 'car':
        return true; // Cars can handle everything
      default:
        return true;
    }
  }

  private getUnavailableReason(vehicleType: string, orderDetails: OrderDetails): string | undefined {
    if (this.checkAvailability(vehicleType, orderDetails)) return undefined;

    switch (vehicleType) {
      case 'wheelbarrow':
        if (orderDetails.distance > 1.0) return 'Distance too far for wheelbarrow delivery';
        if (orderDetails.weight > 15) return 'Order too heavy for wheelbarrow';
        break;
      case 'bike':
        if (orderDetails.weight > 20) return 'Order too heavy for bike delivery';
        if (orderDetails.itemCount > 5) return 'Too many items for bike delivery';
        break;
    }
    return 'Not available for this order';
  }

  private getBasePriceByVehicle(vehicleType: string): number {
    switch (vehicleType) {
      case 'wheelbarrow': return 2.5;
      case 'bike': return 7.5;
      case 'car': return 12.0;
      default: return 7.5;
    }
  }

  private getSpecialtiesByVehicle(vehicleType: string): string[] {
    switch (vehicleType) {
      case 'wheelbarrow': return ['Eco-friendly', 'Local delivery', 'Fresh produce'];
      case 'bike': return ['Fast delivery', 'Electronics', 'Same-day delivery'];
      case 'car': return ['Bulk delivery', 'Long distance', 'Heavy items'];
      default: return [];
    }
  }

  private calculateRating(completedOrders: number): number {
    // Base rating starts at 4.0, improves with experience
    const baseRating = 4.0;
    const experienceBonus = Math.min(0.9, completedOrders * 0.01); // Max 0.9 bonus
    return Math.round((baseRating + experienceBonus) * 10) / 10;
  }

  private getAvgDeliveryTime(vehicleType: string): number {
    switch (vehicleType) {
      case 'wheelbarrow': return 20; // minutes
      case 'bike': return 25;
      case 'car': return 30;
      default: return 25;
    }
  }

  private calculateRecommendationScore(rider: RiderProfile, request: RiderAvailabilityRequest): number {
    let score = 0;
    
    // Rating factor (0-50 points)
    score += rider.rating * 10;
    
    // Distance factor (0-30 points)
    score += Math.max(0, 30 - rider.distanceFromPickup * 6);
    
    // Experience factor (0-20 points)
    score += Math.min(20, rider.totalDeliveries * 0.1);
    
    return Math.round(score);
  }

  private getRecommendationReasons(rider: RiderProfile, request: RiderAvailabilityRequest): string[] {
    const reasons: string[] = [];
    
    if (rider.rating >= 4.8) reasons.push('Highly rated');
    if (rider.distanceFromPickup <= 0.5) reasons.push('Very close');
    if (rider.totalDeliveries >= 100) reasons.push('Experienced');
    if (rider.estimatedArrival <= 5) reasons.push('Quick pickup');
    
    return reasons;
  }

  // Mock data fallback when no riders in database
  private getMockRiders(request: RiderAvailabilityRequest): RiderProfile[] {
    return [
      {
        id: 'mock-1',
        name: 'John Adebayo',
        avatar: 'https://picsum.photos/100/100?random=1',
        rating: 4.8,
        totalDeliveries: 150,
        vehicleType: 'bike' as 'bike' | 'wheelbarrow' | 'car',
        price: 8.50,
        distanceFromPickup: 0.3,
        estimatedArrival: 5,
        isAvailable: true,
        specialties: ['Fragile items', 'Fast delivery'],
        isOnline: true,
        trustScore: 850,
        completionRate: 98,
      },
      {
        id: 'mock-2',
        name: 'Sarah Okafor',
        avatar: 'https://picsum.photos/100/100?random=2',
        rating: 4.9,
        totalDeliveries: 200,
        vehicleType: 'car' as 'bike' | 'wheelbarrow' | 'car',
        price: 15.00,
        distanceFromPickup: 0.8,
        estimatedArrival: 8,
        isAvailable: true,
        specialties: ['Bulk delivery', 'Long distance'],
        isOnline: true,
        trustScore: 920,
        completionRate: 99,
      },
      {
        id: 'mock-3',
        name: 'Ahmed Hassan',
        avatar: 'https://picsum.photos/100/100?random=3',
        rating: 4.7,
        totalDeliveries: 80,
        vehicleType: 'wheelbarrow' as 'bike' | 'wheelbarrow' | 'car',
        price: 3.00,
        distanceFromPickup: 0.2,
        estimatedArrival: 3,
        isAvailable: request.orderDetails.distance <= 1.0,
        unavailableReason: request.orderDetails.distance > 1.0 ? 'Distance too far for wheelbarrow delivery' : undefined,
        specialties: ['Eco-friendly', 'Local delivery'],
        isOnline: true,
        trustScore: 780,
        completionRate: 95,
      },
    ].filter(rider => rider.isOnline);
  }
}
