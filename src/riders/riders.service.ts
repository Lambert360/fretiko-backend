import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RiderAvailabilityRequest, OrderDetails, RiderProfile } from './riders.controller';

@Injectable()
export class RidersService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async findNearbyRiders(
    request: RiderAvailabilityRequest,
    userId?: string | null,
  ): Promise<RiderProfile[]> {
    try {
      // Query riders from user_profiles where is_rider = true
      // Join with rider_profiles to get actual pricing and vehicle info
      const { data: riderProfiles, error } = await this.supabase
        .from('user_profiles')
        .select(`
          id,
          username,
          avatar_url,
          location,
          preferences
        `)
        .eq('is_rider', true)
        .limit(20);

      if (error) {
        console.error('❌ Database error fetching riders:', error);
        return this.getMockRiders(request);
      }

      if (!riderProfiles || riderProfiles.length === 0) {
        console.log('📍 No riders found in database, returning mock data');
        return this.getMockRiders(request);
      }

      // Get rider_profiles for pricing and vehicle info
      const riderIds = riderProfiles.map(r => r.id);
      const { data: riderProfilesData } = await this.supabase
        .from('rider_profiles')
        .select('*')
        .in('user_id', riderIds)
        .eq('profile_status', 'active');

      // Get trust scores for riders
      const { data: trustScores } = await this.supabase
        .from('trust_scores')
        .select('user_id, rider_trust_score, completed_orders')
        .in('user_id', riderIds);

      // Transform database riders to RiderProfile format
      const riders: RiderProfile[] = await Promise.all(
        riderProfiles.map(async (profile) => {
          const trustData = trustScores?.find(ts => ts.user_id === profile.id);
          const riderProfileData = riderProfilesData?.find(rp => rp.user_id === profile.id);
          const preferences = profile.preferences || {};
          
          // Mock distance calculation (in real app, use geolocation)
          const distance = Math.random() * 5; // 0-5km
          
          // Use rider_profiles data if available, otherwise fallback to preferences
          const vehicleType = riderProfileData?.vehicle_type || preferences.vehicleType || 'bike';
          const isOnline = riderProfileData?.is_online ?? (Math.random() > 0.3);
          
          // Calculate price based on rider's service_pricing if available
          let price: number;
          let deliveryPromise: string | undefined;
          
          if (riderProfileData?.service_pricing) {
            // Determine service category (default to intracity for now)
            const serviceCategory = distance <= 10 ? 'intracity' : distance <= 50 ? 'intercity' : 'interstate';
            const servicePricing = riderProfileData.service_pricing[serviceCategory];
            
            if (servicePricing?.enabled) {
              if (servicePricing.custom_price) {
                price = servicePricing.custom_price;
              } else {
                price = (servicePricing.base_price || 2) + (distance * (servicePricing.per_km_rate || 0.5));
              }
            } else {
              // Fallback to default pricing
              const basePrice = this.getBasePriceByVehicle(vehicleType);
              price = basePrice + (distance * 1.5);
            }
            
            // Get delivery promise message
            if (riderProfileData.delivery_promise_message) {
              deliveryPromise = riderProfileData.delivery_promise_message;
            }
          } else {
            // Fallback to mock pricing
            const basePrice = this.getBasePriceByVehicle(vehicleType);
            price = basePrice + (distance * 1.5);
          }
          
          return {
            id: profile.id,
            name: profile.username || 'Unknown Rider',
            avatar: profile.avatar_url || `https://picsum.photos/100/100?random=${profile.id}`,
            rating: this.calculateRating(trustData?.completed_orders || 0),
            totalDeliveries: trustData?.completed_orders || 0,
            vehicleType: ['wheelbarrow', 'bike', 'car', 'van', 'truck'].includes(vehicleType) ? vehicleType as any : 'bike',
            price: Math.round(price * 100) / 100,
            distanceFromPickup: Math.round(distance * 10) / 10,
            estimatedArrival: Math.max(3, Math.round(distance * 3)), // 3 min per km minimum
            isAvailable: this.checkAvailability(vehicleType, request.orderDetails),
            unavailableReason: this.getUnavailableReason(vehicleType, request.orderDetails),
            specialties: this.getSpecialtiesByVehicle(vehicleType),
            isOnline: isOnline,
            trustScore: trustData?.rider_trust_score || 750,
            completionRate: Math.min(99, 85 + (trustData?.completed_orders || 0) / 10),
            deliveryPromise: deliveryPromise, // Add delivery promise
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

      const { data: profile } = await this.supabase.client
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
      // Fetch order details for notification
      const { data: order } = await this.supabase
        .from('orders')
        .select('order_number, delivery_fee, delivery_address, vendor_id, total_amount')
        .eq('id', orderId)
        .eq('buyer_id', userId)
        .single();

      if (!order) {
        console.error('❌ Order not found or unauthorized');
        return { success: false };
      }

      // Update order with rider assignment
      const { error } = await this.supabase
        .from('orders')
        .update({
          rider_id: riderId,
          status: 'assigned',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .eq('buyer_id', userId); // Ensure user owns the order

      if (error) {
        console.error('❌ Error assigning rider:', error);
        return { success: false };
      }

      // Calculate estimated times
      const now = new Date();
      const estimatedPickup = new Date(now.getTime() + 15 * 60000).toISOString(); // 15 min
      const estimatedDelivery = new Date(now.getTime() + 45 * 60000).toISOString(); // 45 min

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

  // Helper methods
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