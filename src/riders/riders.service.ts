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

  // Normalise vehicle_type from the add-rider form (Title Case, varied names)
  // to the lowercase keys used in pricing_config.
  private normalizeVehicleType(type: string): string {
    const map: Record<string, string> = {
      bicycle: 'bike',
      motorcycle: 'bike',
      tricycle: 'wheelbarrow',
      wheelbarrow: 'wheelbarrow',
      car: 'car',
      van: 'van',
      truck: 'truck',
      bike: 'bike',
    };
    return map[type.toLowerCase().trim()] ?? type.toLowerCase().trim();
  }

  async findNearbyRiders(
    request: RiderAvailabilityRequest,
    userId?: string | null,
  ): Promise<RiderProfile[]> {
    try {
      // --- Location resolution ---
      // Mobile sends ISO codes for state/country; fall back to buyer profile otherwise.
      const pickupState = request.pickupLocation?.state?.trim() || null;
      const pickupCountry = request.pickupLocation?.country?.trim() || null;

      // Priority 2: buyer's saved profile state/country (fallback when vendor location not sent)
      let buyerState: string | null = null;
      let buyerCountry: string | null = null;
      if (userId && (!pickupState || !pickupCountry)) {
        const { data: buyerProfile } = await this.supabase
          .from('user_profiles')
          .select('location')
          .eq('id', userId)
          .single();
        buyerState = buyerProfile?.location?.state?.trim() || null;
        buyerCountry = buyerProfile?.location?.country?.trim() || null;
      }

      const primaryState = pickupState ?? buyerState;
      const primaryCountry = pickupCountry ?? buyerCountry;

      const normalizeToken = (value: string | null | undefined): string =>
        (value || '').trim().toLowerCase();

      const primaryCountryIso = normalizeToken(primaryCountry);
      const primaryStateIso = normalizeToken(primaryState);

      if (!primaryCountryIso || !primaryStateIso) {
        console.log('⚠️ No pickup country/state provided, returning empty rider list.');
        return [];
      }

      // --- Company eligibility ---
      // A rider's operating location is derived from its verified company's service_areas.
      const { data: partners, error: partnerError } = await this.supabase
        .from('verified_logistics_partners')
        .select('id, service_areas')
        .eq('partner_status', 'active');

      if (partnerError) {
        console.error('❌ Error fetching logistics partners:', partnerError);
        return [];
      }

      const areaCovers = (area: string, countryIso: string, stateIso: string): boolean => {
        const normalized = normalizeToken(area);
        if (normalized === countryIso) return true;                  // e.g. "NG"
        if (normalized === `${countryIso}-${stateIso}`) return true; // e.g. "NG-RI"
        return false;
      };

      const eligibleCompanyIds = (partners || [])
        .filter((p: any) =>
          (p.service_areas || []).some((a: any) =>
            areaCovers(String(a), primaryCountryIso, primaryStateIso),
          ),
        )
        .map(p => p.id);

      if (eligibleCompanyIds.length === 0) {
        console.log(`📍 No active logistics partner covers '${primaryStateIso}' in '${primaryCountryIso}'. Returning empty list.`);
        return [];
      }

      // --- Build verified_riders query ---
      const { data: allVerifiedRiders, error } = await this.supabase
        .from('verified_riders')
        .select('user_id, full_name, vehicle_type, company_id, verification_status, state, country')
        .eq('verification_status', 'active')
        .not('company_id', 'is', null)
        .in('company_id', eligibleCompanyIds)
        .ilike('country', primaryCountryIso)
        .ilike('state', primaryStateIso)
        .limit(20);

      if (error) {
        console.error('❌ Database error fetching verified riders:', error);
        return [];
      }

      // Service orders (bookings) require motorized vehicles only — never bikes/wheelbarrows,
      // regardless of distance, since services often require larger equipment or trusted handling.
      const requiresMotorizedOnly = request.itemTypes?.includes('service') ?? false;
      const motorizedTypes = ['car', 'van', 'truck'];
      const verifiedRiders = requiresMotorizedOnly
        ? (allVerifiedRiders || []).filter(r => motorizedTypes.includes(this.normalizeVehicleType(r.vehicle_type || '')))
        : allVerifiedRiders;

      if (!verifiedRiders || verifiedRiders.length === 0) {
        console.log('📍 No verified partner-affiliated riders found for this location.');
        return [];
      }

      const riderIds = verifiedRiders.map(r => r.user_id);

      // Get user profile data (avatar, username)
      const { data: userProfiles } = await this.supabase
        .from('user_profiles')
        .select('id, username, avatar_url, location, preferences')
        .in('id', riderIds);

      // Get rider_profiles for online status and fallback pricing
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

      // Live-fetch current pricing_config from partner companies (authoritative source)
      const companyIds = [...new Set(verifiedRiders.map(r => r.company_id).filter(Boolean))];
      const { data: partnerPricingData } = await this.supabase
        .from('verified_logistics_partners')
        .select('id, pricing_config')
        .in('id', companyIds);
      const companyPricing: Record<string, Record<string, { base_price: number; per_km_rate: number }>> = {};
      partnerPricingData?.forEach(p => {
        if (p.pricing_config) companyPricing[p.id] = p.pricing_config;
      });

      // Transform database riders to RiderProfile format
      const riders: RiderProfile[] = await Promise.all(
        verifiedRiders.map(async (vr) => {
          const profile = userProfiles?.find(p => p.id === vr.user_id);
          const trustData = trustScores?.find(ts => ts.user_id === vr.user_id);
          const riderProfileData = riderProfilesData?.find(rp => rp.user_id === vr.user_id);

          // Mock distance calculation (in real app, use geolocation)
          const distance = Math.random() * 5; // 0-5km

          // verified_riders.vehicle_type is authoritative (set during official verification)
          const vehicleType = vr.vehicle_type || riderProfileData?.vehicle_type || profile?.preferences?.vehicleType || 'bike';
          const isOnline = riderProfileData?.is_online ?? (Math.random() > 0.3);

          // Price = company's live pricing_config if set, otherwise flat 2 Freti
          let price: number;
          let deliveryPromise: string | undefined;

          const companyRates = companyPricing[vr.company_id]?.[this.normalizeVehicleType(vehicleType)];

          if (companyRates?.base_price && companyRates?.per_km_rate) {
            // Use company's live pricing: base + distance × per_km_rate
            price = companyRates.base_price + (distance * companyRates.per_km_rate);
          } else {
            // No company pricing set — fixed 2 Freti regardless of distance
            price = 2;
          }

          if (riderProfileData?.delivery_promise_message) {
            deliveryPromise = riderProfileData.delivery_promise_message;
          }

          return {
            id: vr.user_id,
            name: profile?.username || vr.full_name || 'Unknown Rider',
            avatar: profile?.avatar_url || `https://picsum.photos/100/100?random=${vr.user_id}`,
            rating: this.calculateRating(trustData?.completed_orders || 0),
            totalDeliveries: trustData?.completed_orders || 0,
            vehicleType: ['wheelbarrow', 'bike', 'car', 'van', 'truck'].includes(vehicleType) ? vehicleType as any : 'bike',
            price: Math.round(price * 100) / 100,
            distanceFromPickup: Math.round(distance * 10) / 10,
            estimatedArrival: Math.max(3, Math.round(distance * 3)),
            isAvailable: this.checkAvailability(vehicleType, request.orderDetails),
            unavailableReason: this.getUnavailableReason(vehicleType, request.orderDetails),
            specialties: this.getSpecialtiesByVehicle(vehicleType),
            isOnline,
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
      return [];
    }
  }

  /**
   * Find logistics companies eligible to handle an interstate (or international)
   * delivery between the pickup and delivery locations. Only companies with
   * interstate_config.enabled = true and whose service_areas cover BOTH the
   * pickup and delivery locations are returned. service_areas may be stored as
   * country codes ("NG") or country-state codes ("NG-RI").
   */
  async findInterstateCompanies(
    pickupState?: string,
    pickupCountry?: string,
    deliveryState?: string,
    deliveryCountry?: string,
  ): Promise<Array<{
    companyId: string;
    companyName: string;
    logoUrl?: string;
    basePrice: number;
    perKmRate: number;
    estimatedDeliveryDaysMin: number;
    estimatedDeliveryDaysMax: number;
    isInternational: boolean;
  }>> {
    const normalizeToken = (value?: string | null): string =>
      (value || '').trim().toLowerCase();

    const pickupCountryIso = normalizeToken(pickupCountry);
    const deliveryCountryIso = normalizeToken(deliveryCountry);
    const pickupStateIso = normalizeToken(pickupState);
    const deliveryStateIso = normalizeToken(deliveryState);

    if (!pickupCountryIso || !deliveryCountryIso) {
      console.log('⚠️ Missing pickup or delivery country, returning no interstate companies.');
      return [];
    }

    const isInternational = pickupCountryIso !== deliveryCountryIso;

    const { data: partners, error } = await this.supabase
      .from('verified_logistics_partners')
      .select('id, company_name, company_logo_url, service_areas, interstate_config')
      .eq('partner_status', 'active')
      .not('interstate_config', 'is', null);

    if (error || !partners) {
      console.error('❌ Error fetching interstate-eligible partners:', error);
      return [];
    }

    return partners
      .filter((p: any) => {
        const cfg = p.interstate_config || {};
        if (!cfg.enabled) return false;
        if (isInternational && !cfg.international_enabled) return false;

        const areas: string[] = (Array.isArray(p.service_areas) ? p.service_areas : [])
          .map((a: any) => normalizeToken(String(a)));
        if (areas.length === 0) return false;

        const covers = (countryIso: string, stateIso?: string): boolean => {
          // Country-wide coverage (e.g. "NG")
          if (areas.includes(countryIso)) return true;
          // State-specific coverage (e.g. "NG-RI")
          if (stateIso && areas.includes(`${countryIso}-${stateIso}`)) return true;
          return false;
        };

        return (
          covers(pickupCountryIso, pickupStateIso || undefined) &&
          covers(deliveryCountryIso, deliveryStateIso || undefined)
        );
      })
      .map((p: any) => ({
        companyId: p.id,
        companyName: p.company_name,
        logoUrl: p.company_logo_url,
        basePrice: isInternational
          ? p.interstate_config?.international_base_price || p.interstate_config?.base_price || 0
          : p.interstate_config?.base_price || 0,
        perKmRate: isInternational
          ? p.interstate_config?.international_per_km_rate || p.interstate_config?.per_km_rate || 0
          : p.interstate_config?.per_km_rate || 0,
        estimatedDeliveryDaysMin: p.interstate_config?.estimated_delivery_days_min ?? 2,
        estimatedDeliveryDaysMax: p.interstate_config?.estimated_delivery_days_max ?? 5,
        isInternational,
      }));
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
      // Only allow verified, active, partner-affiliated riders
      const { data: verifiedRider, error } = await this.supabase
        .from('verified_riders')
        .select('vehicle_type, verification_status, company_id')
        .eq('user_id', riderId)
        .eq('verification_status', 'active')
        .not('company_id', 'is', null)
        .single();

      if (error || !verifiedRider) {
        return { available: false, reason: 'Rider is not a verified partner rider' };
      }

      const vehicleType = verifiedRider.vehicle_type || 'bike';
      
      // Simple availability check based on vehicle type and order details
      let isAvailable = true;
      switch (vehicleType) {
        case 'wheelbarrow':
          isAvailable = orderDetails.distance <= 1.0 && orderDetails.weight <= 15;
          break;
        case 'bike':
          isAvailable = orderDetails.weight <= 20 && orderDetails.itemCount <= 5;
          break;
        case 'car':
          isAvailable = true; // Cars can handle everything
          break;
        default:
          isAvailable = true;
      }
      
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
      // Only return profile for verified, active, partner-affiliated riders
      const { data: verifiedRider, error: vrError } = await this.supabase
        .from('verified_riders')
        .select('user_id, full_name, vehicle_type, verification_status, company_id')
        .eq('user_id', riderId)
        .eq('verification_status', 'active')
        .not('company_id', 'is', null)
        .single();

      if (vrError || !verifiedRider) {
        return null;
      }

      const { data: profile } = await this.supabase
        .from('user_profiles')
        .select('id, username, avatar_url')
        .eq('id', riderId)
        .single();

      const { data: trustData } = await this.supabase
        .from('trust_scores')
        .select('rider_trust_score, completed_orders')
        .eq('user_id', riderId)
        .single();

      const vehicleType = verifiedRider.vehicle_type || 'bike';

      return {
        id: riderId,
        name: profile?.username || verifiedRider.full_name || 'Unknown Rider',
        avatar: profile?.avatar_url || `https://picsum.photos/100/100?random=${riderId}`,
        rating: this.calculateRating(trustData?.completed_orders || 0),
        totalDeliveries: trustData?.completed_orders || 0,
        vehicleType: ['wheelbarrow', 'bike', 'car', 'van', 'truck'].includes(vehicleType) ? vehicleType as any : 'bike',
        price: this.getBasePriceByVehicle(vehicleType),
        distanceFromPickup: 0,
        estimatedArrival: 0,
        isAvailable: true,
        unavailableReason: undefined,
        specialties: this.getSpecialtiesByVehicle(vehicleType),
        isOnline: true,
        trustScore: trustData?.rider_trust_score || 750,
        completionRate: Math.min(99, 85 + (trustData?.completed_orders || 0) / 10),
        deliveryPromise: 'Standard delivery',
      };

    } catch (error) {
      console.error('❌ Error getting rider profile:', error);
      return null;
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

  async acceptRiderAssignment(
    orderId: string,
    riderId: string,
  ): Promise<{ success: boolean; message: string; order?: any }> {
    try {
      // Check if assignment exists and is pending
      const { data: order, error } = await this.supabase
        .from('orders')
        .select('*')
        .eq('id', orderId)
        .eq('rider_id', riderId)
        .eq('rider_acceptance_status', 'pending')
        .single();

      if (error || !order) {
        return { success: false, message: 'Assignment not found or no longer pending' };
      }

      // Check if deadline has passed
      const deadline = new Date(order.rider_assignment_deadline);
      if (deadline < new Date()) {
        return { success: false, message: 'Assignment deadline has passed' };
      }

      // Update order status to accepted
      const { error: updateError } = await this.supabase
        .from('orders')
        .update({
          rider_acceptance_status: 'accepted',
          status: 'rider_assigned',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      if (updateError) {
        console.error('❌ Error accepting assignment:', updateError);
        return { success: false, message: 'Failed to accept assignment' };
      }

      return { 
        success: true, 
        message: 'Assignment accepted successfully',
        order: {
          ...order,
          rider_acceptance_status: 'accepted',
          status: 'rider_assigned'
        }
      };
    } catch (error) {
      console.error('❌ Error accepting rider assignment:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async rejectRiderAssignment(
    orderId: string,
    riderId: string,
    reason?: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Check if assignment exists and is pending
      const { data: order, error } = await this.supabase
        .from('orders')
        .select('*')
        .eq('id', orderId)
        .eq('rider_id', riderId)
        .eq('rider_acceptance_status', 'pending')
        .single();

      if (error || !order) {
        return { success: false, message: 'Assignment not found or no longer pending' };
      }

      // Update order status to rejected and trigger replacement
      const { error: updateError } = await this.supabase
        .from('orders')
        .update({
          rider_acceptance_status: 'rejected',
          rider_id: null,
          rider_assignment_deadline: null,
          replacement_attempts: (order.replacement_attempts || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      if (updateError) {
        console.error('❌ Error rejecting assignment:', updateError);
        return { success: false, message: 'Failed to reject assignment' };
      }

      return { success: true, message: 'Assignment rejected successfully' };
    } catch (error) {
      console.error('❌ Error rejecting rider assignment:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async getPendingAssignments(riderId: string): Promise<any[]> {
    try {
      const { data: assignments, error } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          delivery_fee,
          delivery_address,
          rider_assignment_deadline,
          created_at,
          vendor_id,
          buyer_id,
          total_amount
        `)
        .eq('rider_id', riderId)
        .eq('rider_acceptance_status', 'pending')
        .gt('rider_assignment_deadline', new Date().toISOString())
        .order('created_at', { ascending: false });

      if (error) {
        console.error('❌ Error fetching pending assignments:', error);
        return [];
      }

      return assignments || [];
    } catch (error) {
      console.error('❌ Error fetching pending assignments:', error);
      return [];
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

}