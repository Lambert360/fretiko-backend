import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { PartnerProfileUpdateDto } from './dto/partner-auth.dto';
import { EmailService } from '../auth/email.service';

@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private emailService: EmailService
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Validate partner login credentials
   */
  async validateLogin(username: string, password: string): Promise<{
    success: boolean;
    message: string;
    partner?: any;
    requiresPasswordChange?: boolean;
  }> {
    try {
      const { data, error } = await this.supabase
        .rpc('validate_partner_login', { 
          p_username: username, 
          p_password: password 
        });

      if (error) {
        this.logger.error('Login validation error:', error);
        return {
          success: false,
          message: 'Invalid username or password'
        };
      }

      if (!data || data.length === 0) {
        return {
          success: false,
          message: 'Invalid username or password'
        };
      }

      const result = data[0];

      if (!result.success) {
        return {
          success: false,
          message: result.message
        };
      }

      // RPC only returns partner_id + company_name — fetch full record for JWT payload
      const { data: partnerData, error: partnerError } = await this.supabase
        .from('verified_logistics_partners')
        .select('id, company_name, partner_username, contact_email, contact_phone')
        .eq('id', result.partner_id)
        .single();

      if (partnerError || !partnerData) {
        this.logger.error('Failed to fetch partner record after login validation:', partnerError);
        return {
          success: false,
          message: 'Login failed. Please try again.'
        };
      }

      return {
        success: true,
        message: result.message,
        requiresPasswordChange: result.requires_password_change,
        partner: partnerData
      };
    } catch (error) {
      this.logger.error('Login validation error:', error);
      return {
        success: false,
        message: 'Login failed. Please try again.'
      };
    }
  }

  /**
   * Get partner dashboard data
   */
  async getDashboardData(partnerId: string): Promise<any> {
    try {
      // Get partner basic info
      const { data: partner, error: partnerError } = await this.supabase
        .from('verified_logistics_partners')
        .select('*')
        .eq('id', partnerId)
        .single();

      if (partnerError || !partner) {
        throw new NotFoundException('Partner not found');
      }

      // Get rider counts from verified_riders
      const { count: totalRidersCount } = await this.supabase
        .from('verified_riders')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', partnerId);

      const { count: activeRidersCount } = await this.supabase
        .from('verified_riders')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', partnerId)
        .eq('verification_status', 'active');

      // Get recent rider activity (real data)
      const recentActivity = await this.getRecentRiderActivity(partnerId);

      // Get performance metrics (real data)
      const performanceMetrics = await this.getPerformanceMetrics(partnerId);

      return {
        partner: {
          id: partner.id,
          company_name: partner.company_name,
          partner_username: partner.partner_username,
          contact_email: partner.contact_email,
          contact_phone: partner.contact_phone,
          company_website: partner.company_website,
          headquarters_address: partner.headquarters_address,
          company_logo_url: partner.company_logo_url,
          service_areas: partner.service_areas || [],
          service_categories: partner.service_categories || [],
          vehicle_fleet: partner.vehicle_fleet || {},
          registration_document_urls: partner.registration_document_urls || [],
          insurance_document_urls: partner.insurance_document_urls || [],
          fleet_document_urls: partner.fleet_document_urls || [],
          partner_status: partner.partner_status,
          verified_at: partner.verified_at,
          preferred_currency: partner.preferred_currency || 'NGN',
          pricing_config: partner.pricing_config || {}
        },
        statistics: {
          totalRiders: totalRidersCount || 0,
          activeRiders: activeRidersCount || 0,
          totalDeliveries: partner.total_deliveries || 0,
          completedDeliveries: partner.completed_deliveries || 0,
          averageDeliveryTime: partner.average_delivery_time || 0,
          onTimeDeliveryRate: partner.on_time_delivery_rate || 0,
          totalRevenue: partner.total_revenue || 0,
          platformCommission: partner.platform_commission || 0
        },
        recentActivity,
        performanceMetrics
      };
    } catch (error) {
      this.logger.error('Failed to get dashboard data:', error);
      throw new BadRequestException('Failed to fetch dashboard data');
    }
  }

  /**
   * Get partner's riders
   */
  async getPartnerRiders(partnerId: string): Promise<any> {
    try {
      const { data, error } = await this.supabase
        .from('verified_riders')
        .select(`
          id,
          unique_rider_id,
          full_name,
          country,
          state,
          vehicle_type,
          verification_status,
          driver_license_url,
          total_deliveries,
          completed_deliveries,
          average_delivery_time,
          customer_rating,
          on_time_rate,
          claimed_at,
          verified_at,
          created_at
        `)
        .eq('company_id', partnerId)
        .order('created_at', { ascending: false });

      if (error) {
        throw new BadRequestException('Failed to fetch riders');
      }

      return {
        riders: data || [],
        total: data?.length || 0
      };
    } catch (error) {
      this.logger.error('Failed to get partner riders:', error);
      throw new BadRequestException('Failed to fetch riders');
    }
  }

  /**
   * Update partner profile
   */
  async updatePartnerProfile(partnerId: string, updateData: PartnerProfileUpdateDto): Promise<any> {
    try {
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (updateData.contactPersonName !== undefined)      patch.contact_person_name = updateData.contactPersonName;
      if (updateData.contactEmail !== undefined)            patch.contact_email = updateData.contactEmail;
      if (updateData.contactPhone !== undefined)            patch.contact_phone = updateData.contactPhone;
      if (updateData.companyWebsite !== undefined)          patch.company_website = updateData.companyWebsite;
      if (updateData.headquartersAddress !== undefined)     patch.headquarters_address = updateData.headquartersAddress;
      if (updateData.preferredCurrency)                     patch.preferred_currency = updateData.preferredCurrency;
      if (updateData.serviceAreas !== undefined)            patch.service_areas = updateData.serviceAreas;
      if (updateData.serviceCategories !== undefined)       patch.service_categories = updateData.serviceCategories;
      if (updateData.vehicleFleet !== undefined)            patch.vehicle_fleet = updateData.vehicleFleet;
      if (updateData.companyLogoUrl !== undefined)          patch.company_logo_url = updateData.companyLogoUrl;
      if (updateData.registrationDocumentUrls !== undefined) patch.registration_document_urls = updateData.registrationDocumentUrls;
      if (updateData.insuranceDocumentUrls !== undefined)   patch.insurance_document_urls = updateData.insuranceDocumentUrls;
      if (updateData.fleetDocumentUrls !== undefined)       patch.fleet_document_urls = updateData.fleetDocumentUrls;

      const { data, error } = await this.supabase
        .from('verified_logistics_partners')
        .update(patch)
        .eq('id', partnerId)
        .select('id, company_name, partner_username, contact_email, contact_phone, company_website, headquarters_address, preferred_currency, company_logo_url, service_areas, service_categories, vehicle_fleet, registration_document_urls, insurance_document_urls, fleet_document_urls')
        .single();

      if (error) {
        this.logger.error('Supabase update error:', error);
        throw new BadRequestException('Failed to update profile');
      }

      return data;
    } catch (error) {
      this.logger.error('Failed to update partner profile:', error);
      throw new BadRequestException('Failed to update profile');
    }
  }

  /**
   * Request password reset
   */
  async requestPasswordReset(username: string): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      // Allow password reset using either username or email
      const { data: partner, error: lookupError } = await this.supabase
        .from('verified_logistics_partners')
        .select('partner_username, contact_email, company_name')
        .or(`partner_username.eq.${username},contact_email.eq.${username}`)
        .single();

      if (lookupError || !partner) {
        this.logger.warn(`Partner not found for password reset: ${username}`);
        // Return success for security - don't reveal if user exists
        return {
          success: true,
          message: 'If an account exists, you will receive a password reset code'
        };
      }

      // Use the partner_username for the reset token
      const { data, error } = await this.supabase
        .rpc('generate_partner_password_reset_token', { p_username: partner.partner_username });

      if (error) {
        this.logger.error('Password reset request error:', error);
        return {
          success: false,
          message: 'Failed to process password reset request'
        };
      }

      const result = data[0];
      
      if (result.success) {
        // Send partner-specific password reset email
        const emailSent = await this.emailService.sendPartnerPasswordResetEmail(
          partner.contact_email, 
          result.token,
          partner.company_name
        );

        if (!emailSent) {
          this.logger.error(`Failed to send partner password reset email to ${partner.contact_email}`);
        } else {
          this.logger.log(`✅ Partner password reset email sent to ${partner.contact_email} for ${partner.company_name}`);
        }

        return {
          success: true,
          message: 'Password reset instructions have been sent to your email'
        };
      } else {
        return {
          success: false,
          message: result.message
        };
      }
    } catch (error) {
      this.logger.error('Password reset request error:', error);
      return {
        success: false,
        message: 'Failed to process password reset request'
      };
    }
  }

  /**
   * Confirm password reset
   */
  async confirmPasswordReset(token: string, newPassword: string): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      const { data, error } = await this.supabase
        .rpc('reset_partner_password_with_token', { 
          p_token: token, 
          p_new_password: newPassword 
        });

      if (error) {
        this.logger.error('Password reset confirmation error:', error);
        return {
          success: false,
          message: 'Failed to reset password'
        };
      }

      const result = data[0];
      return {
        success: result.success,
        message: result.message
      };
    } catch (error) {
      this.logger.error('Password reset confirmation error:', error);
      return {
        success: false,
        message: 'Failed to reset password'
      };
    }
  }

  /**
   * Change password (authenticated partner)
   */
  async changePassword(partnerId: string, currentPassword: string, newPassword: string): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      if (!partnerId) {
        return {
          success: false,
          message: 'Authentication required. Please login again.'
        };
      }

      // First validate current password
      const partner = await this.getPartnerById(partnerId);

      if (!partner.partner_username) {
        return {
          success: false,
          message: 'Partner account not properly configured'
        };
      }

      const validation = await this.validateLogin(partner.partner_username, currentPassword);

      if (!validation.success) {
        return {
          success: false,
          message: 'Current password is incorrect'
        };
      }

      // Use DB function so bcrypt hashing is handled at the database level
      const { data, error } = await this.supabase
        .rpc('change_partner_password_by_id', {
          p_partner_id: partnerId,
          p_new_password: newPassword
        });

      if (error) {
        this.logger.error('change_partner_password_by_id error:', error);
        return {
          success: false,
          message: 'Failed to change password'
        };
      }

      const result = data[0];
      return {
        success: result.success,
        message: result.message
      };
    } catch (error) {
      this.logger.error('Failed to change password:', error);
      return {
        success: false,
        message: 'Failed to change password'
      };
    }
  }

  /**
   * Update partner pricing config (rates per vehicle type)
   */
  async updatePricingConfig(
    partnerId: string,
    pricingConfig: Record<string, { base_price: number; per_km_rate: number }>
  ): Promise<{ success: boolean; message: string }> {
    try {
      const { error } = await this.supabase
        .from('verified_logistics_partners')
        .update({
          pricing_config: pricingConfig,
          updated_at: new Date().toISOString()
        })
        .eq('id', partnerId);

      if (error) {
        this.logger.error('Failed to update pricing config:', error);
        return { success: false, message: 'Failed to save pricing. Please try again.' };
      }

      // Apply updated rates to all active riders in this company
      const { data: activeRiders } = await this.supabase
        .from('verified_riders')
        .select('user_id, vehicle_type')
        .eq('company_id', partnerId)
        .eq('verification_status', 'active')
        .not('user_id', 'is', null);

      if (activeRiders && activeRiders.length > 0) {
        const normalizeVehicleType = (type: string): string => {
          const map: Record<string, string> = {
            bicycle: 'bike', motorcycle: 'bike', tricycle: 'wheelbarrow',
            wheelbarrow: 'wheelbarrow', car: 'car', van: 'van', truck: 'truck', bike: 'bike',
          };
          return map[type.toLowerCase().trim()] ?? type.toLowerCase().trim();
        };
        await Promise.all(
          activeRiders.map(async (rider) => {
            const rates = pricingConfig[normalizeVehicleType(rider.vehicle_type)];
            if (!rates) return;
            const servicePricing = this.buildServicePricingFromRates(rates);
            await this.supabase
              .from('rider_profiles')
              .update({
                service_pricing: servicePricing,
                updated_at: new Date().toISOString()
              })
              .eq('user_id', rider.user_id);
          })
        );
      }

      return { success: true, message: 'Pricing updated successfully.' };
    } catch (error) {
      this.logger.error('Failed to update pricing config:', error);
      return { success: false, message: 'Failed to update pricing.' };
    }
  }

  /**
   * Get the partner's interstate/international delivery configuration
   * (pricing + estimated delivery days), stored in the `interstate_config` JSONB column.
   */
  async getInterstateConfig(partnerId: string): Promise<any> {
    const { data, error } = await this.supabase
      .from('verified_logistics_partners')
      .select('interstate_config, service_areas')
      .eq('id', partnerId)
      .single();

    if (error) {
      this.logger.error('Failed to fetch interstate config:', error);
      throw new NotFoundException('Partner not found');
    }

    return {
      enabled: data.interstate_config?.enabled ?? false,
      basePrice: data.interstate_config?.base_price ?? 0,
      perKmRate: data.interstate_config?.per_km_rate ?? 0,
      internationalBasePrice: data.interstate_config?.international_base_price ?? 0,
      internationalPerKmRate: data.interstate_config?.international_per_km_rate ?? 0,
      estimatedDeliveryDaysMin: data.interstate_config?.estimated_delivery_days_min ?? 2,
      estimatedDeliveryDaysMax: data.interstate_config?.estimated_delivery_days_max ?? 5,
      internationalEnabled: data.interstate_config?.international_enabled ?? false,
      serviceAreas: data.service_areas || [],
    };
  }

  /**
   * Update the partner's interstate/international delivery configuration
   */
  async updateInterstateConfig(
    partnerId: string,
    config: {
      enabled?: boolean;
      basePrice?: number;
      perKmRate?: number;
      internationalBasePrice?: number;
      internationalPerKmRate?: number;
      estimatedDeliveryDaysMin?: number;
      estimatedDeliveryDaysMax?: number;
      internationalEnabled?: boolean;
    },
  ): Promise<{ success: boolean; message: string }> {
    try {
      const { data: existing } = await this.supabase
        .from('verified_logistics_partners')
        .select('interstate_config')
        .eq('id', partnerId)
        .single();

      const merged = {
        ...(existing?.interstate_config || {}),
        ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
        ...(config.basePrice !== undefined ? { base_price: config.basePrice } : {}),
        ...(config.perKmRate !== undefined ? { per_km_rate: config.perKmRate } : {}),
        ...(config.internationalBasePrice !== undefined ? { international_base_price: config.internationalBasePrice } : {}),
        ...(config.internationalPerKmRate !== undefined ? { international_per_km_rate: config.internationalPerKmRate } : {}),
        ...(config.estimatedDeliveryDaysMin !== undefined ? { estimated_delivery_days_min: config.estimatedDeliveryDaysMin } : {}),
        ...(config.estimatedDeliveryDaysMax !== undefined ? { estimated_delivery_days_max: config.estimatedDeliveryDaysMax } : {}),
        ...(config.internationalEnabled !== undefined ? { international_enabled: config.internationalEnabled } : {}),
      };

      const { error } = await this.supabase
        .from('verified_logistics_partners')
        .update({ interstate_config: merged, updated_at: new Date().toISOString() })
        .eq('id', partnerId);

      if (error) {
        this.logger.error('Failed to update interstate config:', error);
        return { success: false, message: 'Failed to save interstate configuration.' };
      }

      return { success: true, message: 'Interstate configuration updated successfully.' };
    } catch (error) {
      this.logger.error('Failed to update interstate config:', error);
      return { success: false, message: 'Failed to update interstate configuration.' };
    }
  }

  /**
   * Get interstate/international orders assigned to this partner company.
   * Orders are matched via metadata.interstate_delivery.companyId.
   * Enriched with buyer/vendor profiles and order items for the partner dashboard.
   */
  async getInterstateOrders(partnerId: string): Promise<any[]> {
    const { data: orders, error } = await this.supabase
      .from('orders')
      .select(`
        *,
        order_items (
          id,
          product_id,
          product_name,
          quantity,
          unit_price,
          total_price
        )
      `)
      .eq('delivery_type', 'interstate_delivery')
      .contains('metadata', { interstate_delivery: { companyId: partnerId } })
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error('Failed to fetch interstate orders:', error);
      return [];
    }

    const buyerIds = [...new Set((orders || []).map((o: any) => o.buyer_id).filter(Boolean))];
    const vendorIds = [...new Set((orders || []).map((o: any) => o.vendor_id).filter(Boolean))];

    // Collect all product_ids from order_items to fetch product images
    const productIds = [...new Set(
      (orders || []).flatMap((o: any) =>
        (o.order_items || []).map((item: any) => item.product_id).filter(Boolean)
      )
    )];

    const [{ data: buyerProfiles }, { data: vendorProfiles }, { data: products }] = await Promise.all([
      buyerIds.length > 0
        ? this.supabase.from('user_profiles').select('id, username, display_name, avatar_url, phone, location').in('id', buyerIds)
        : Promise.resolve({ data: [] }),
      vendorIds.length > 0
        ? this.supabase.from('user_profiles').select('id, username, display_name, avatar_url, phone, location').in('id', vendorIds)
        : Promise.resolve({ data: [] }),
      productIds.length > 0
        ? this.supabase.from('products').select('id, primary_image_url, images').in('id', productIds)
        : Promise.resolve({ data: [] }),
    ]);

    const buyerMap = Object.fromEntries((buyerProfiles || []).map((p: any) => [p.id, p]));
    const vendorMap = Object.fromEntries((vendorProfiles || []).map((p: any) => [p.id, p]));
    const productMap = Object.fromEntries((products || []).map((p: any) => [p.id, p]));

    return (orders || []).map((order: any) => ({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      interstateStatus: order.metadata?.interstate_delivery?.status || 'pending_partner_acceptance',
      isInternational: order.metadata?.interstate_delivery?.isInternational || false,
      totalAmount: order.total_amount,
      deliveryFee: order.delivery_fee,
      deliveryAddress: order.delivery_address,
      deliveryInstructions: order.delivery_instructions,
      estimatedDeliveryDays: order.metadata?.interstate_delivery?.estimatedDeliveryDays,
      createdAt: order.created_at,
      // The logistics company needs the pickup PIN to claim the product from the vendor.
      // The delivery PIN is provided by the buyer at the destination (not exposed to the company).
      pickupPin: order.pickup_pin,
      items: (order.order_items || []).map((item: any) => {
        const product = item.product_id ? productMap[item.product_id] : null;
        return {
          ...item,
          product_image_url: product?.primary_image_url || product?.images?.[0] || null,
        };
      }),
      buyer: buyerMap[order.buyer_id]
        ? {
            id: order.buyer_id,
            name: buyerMap[order.buyer_id].display_name || buyerMap[order.buyer_id].username || 'Buyer',
            phone: buyerMap[order.buyer_id].phone || null,
            email: buyerMap[order.buyer_id].email || null,
            avatarUrl: buyerMap[order.buyer_id].avatar_url || null,
            location: buyerMap[order.buyer_id].location || null,
          }
        : { id: order.buyer_id, name: 'Buyer', phone: null, email: null, avatarUrl: null, location: null },
      vendor: vendorMap[order.vendor_id]
        ? {
            id: order.vendor_id,
            name: vendorMap[order.vendor_id].display_name || vendorMap[order.vendor_id].username || 'Vendor',
            phone: vendorMap[order.vendor_id].phone || null,
            email: vendorMap[order.vendor_id].email || null,
            avatarUrl: vendorMap[order.vendor_id].avatar_url || null,
            location: vendorMap[order.vendor_id].location || null,
          }
        : { id: order.vendor_id, name: 'Vendor', phone: null, email: null, avatarUrl: null, location: null },
    }));
  }

  /**
   * Accept an interstate order assigned to this partner
   */
  async acceptInterstateOrder(partnerId: string, orderId: string): Promise<{ success: boolean; message: string }> {
    const { data: order, error: fetchError } = await this.supabase
      .from('orders')
      .select('metadata')
      .eq('id', orderId)
      .single();

    if (fetchError || !order || order.metadata?.interstate_delivery?.companyId !== partnerId) {
      return { success: false, message: 'Order not found or not assigned to this company.' };
    }

    const { error } = await this.supabase
      .from('orders')
      .update({
        metadata: {
          ...order.metadata,
          interstate_delivery: { ...order.metadata.interstate_delivery, status: 'accepted' },
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (error) {
      this.logger.error('Failed to accept interstate order:', error);
      return { success: false, message: 'Failed to accept order.' };
    }

    return { success: true, message: 'Order accepted.' };
  }

  /**
   * Reject an interstate order assigned to this partner
   */
  async rejectInterstateOrder(
    partnerId: string,
    orderId: string,
    reason?: string,
  ): Promise<{ success: boolean; message: string }> {
    const { data: order, error: fetchError } = await this.supabase
      .from('orders')
      .select('metadata')
      .eq('id', orderId)
      .single();

    if (fetchError || !order || order.metadata?.interstate_delivery?.companyId !== partnerId) {
      return { success: false, message: 'Order not found or not assigned to this company.' };
    }

    const { error } = await this.supabase
      .from('orders')
      .update({
        metadata: {
          ...order.metadata,
          interstate_delivery: {
            ...order.metadata.interstate_delivery,
            status: 'rejected',
            rejectionReason: reason || null,
          },
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (error) {
      this.logger.error('Failed to reject interstate order:', error);
      return { success: false, message: 'Failed to reject order.' };
    }

    return { success: true, message: 'Order rejected.' };
  }

  /**
   * Update the delivery status of an accepted interstate order
   * (e.g. 'in_transit', 'delivered')
   */
  async updateInterstateOrderStatus(
    partnerId: string,
    orderId: string,
    status: 'in_transit' | 'delivered',
  ): Promise<{ success: boolean; message: string }> {
    const { data: order, error: fetchError } = await this.supabase
      .from('orders')
      .select('metadata')
      .eq('id', orderId)
      .single();

    if (fetchError || !order || order.metadata?.interstate_delivery?.companyId !== partnerId) {
      return { success: false, message: 'Order not found or not assigned to this company.' };
    }

    const orderUpdate: any = {
      metadata: {
        ...order.metadata,
        interstate_delivery: { ...order.metadata.interstate_delivery, status },
      },
      updated_at: new Date().toISOString(),
    };
    if (status === 'delivered') {
      orderUpdate.status = 'delivered';
    }

    const { error } = await this.supabase
      .from('orders')
      .update(orderUpdate)
      .eq('id', orderId);

    if (error) {
      this.logger.error('Failed to update interstate order status:', error);
      return { success: false, message: 'Failed to update order status.' };
    }

    return { success: true, message: 'Order status updated.' };
  }

  /**
   * Build rider_profiles.service_pricing from a simple base_price + per_km_rate
   * Enables all standard service categories with the same rates.
   */
  private buildServicePricingFromRates(
    rates: { base_price: number; per_km_rate: number }
  ): Record<string, { enabled: boolean; base_price: number; per_km_rate: number }> {
    const categories = ['intracity', 'intercity', 'interstate', 'express', 'cargo'];
    return Object.fromEntries(
      categories.map((cat) => [cat, { enabled: true, base_price: rates.base_price, per_km_rate: rates.per_km_rate }])
    );
  }

  /**
   * Auto-generate the next unique rider ID for a partner
   * Format: {partner_username}{zero_padded_number} e.g. uncutltd0001
   */
  private async generateUniqueRiderId(partnerId: string, partnerUsername: string): Promise<string> {
    const prefix = partnerUsername.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 10);

    const { data } = await this.supabase
      .from('verified_riders')
      .select('unique_rider_id')
      .eq('company_id', partnerId)
      .not('unique_rider_id', 'is', null);

    let maxNum = 0;
    if (data && data.length > 0) {
      for (const rider of data) {
        const numPart = rider.unique_rider_id?.replace(prefix, '');
        if (numPart && /^\d+$/.test(numPart)) {
          const n = parseInt(numPart, 10);
          if (n > maxNum) maxNum = n;
        }
      }
    }

    const next = maxNum + 1;
    const padded = next.toString().padStart(4, '0');
    return `${prefix}${padded}`;
  }

  /**
   * Add a rider on behalf of the partner — creates a dormant verified_riders record
   */
  async addRider(partnerId: string, riderData: {
    full_name: string;
    country: string;
    state: string;
    city?: string;
    vehicle_type: string;
    vehicle_make?: string;
    vehicle_model?: string;
    vehicle_year?: number;
    license_plate?: string;
    years_experience?: number;
    driver_license_url?: string;
  }): Promise<{ success: boolean; message: string; unique_rider_id?: string }> {
    try {
      const partner = await this.getPartnerById(partnerId);
      const uniqueRiderId = await this.generateUniqueRiderId(partnerId, partner.partner_username);

      const { error } = await this.supabase
        .from('verified_riders')
        .insert({
          user_id: null,
          company_id: partnerId,
          unique_rider_id: uniqueRiderId,
          full_name: riderData.full_name,
          country: riderData.country,
          state: riderData.state,
          city: riderData.city || null,
          vehicle_type: riderData.vehicle_type,
          vehicle_make: riderData.vehicle_make || null,
          vehicle_model: riderData.vehicle_model || null,
          vehicle_year: riderData.vehicle_year || null,
          license_plate: riderData.license_plate || null,
          years_experience: riderData.years_experience || null,
          driver_license_url: riderData.driver_license_url || null,
          verification_status: 'dormant',
        });

      if (error) {
        this.logger.error('Failed to add rider:', error);
        return { success: false, message: 'Failed to add rider. Please try again.' };
      }

      return {
        success: true,
        message: 'Rider account created successfully.',
        unique_rider_id: uniqueRiderId
      };
    } catch (error) {
      this.logger.error('Failed to add rider:', error);
      return { success: false, message: 'Failed to add rider.' };
    }
  }

  /**
   * Suspend, terminate, or reactivate a partner's rider
   */
  async updateRiderStatus(
    partnerId: string,
    riderId: string,
    action: 'suspend' | 'terminate' | 'reactivate'
  ): Promise<{ success: boolean; message: string }> {
    try {
      const { data: rider, error: fetchError } = await this.supabase
        .from('verified_riders')
        .select('id, company_id, verification_status, user_id')
        .eq('id', riderId)
        .single();

      if (fetchError || !rider) {
        return { success: false, message: 'Rider not found.' };
      }

      if (rider.company_id !== partnerId) {
        return { success: false, message: 'Unauthorized: this rider does not belong to your company.' };
      }

      if (rider.verification_status === 'terminated' && action !== 'reactivate') {
        return { success: false, message: 'Terminated riders cannot be modified.' };
      }

      if (action === 'reactivate' && rider.verification_status === 'terminated') {
        return { success: false, message: 'Terminated riders cannot be reactivated.' };
      }

      if (action === 'reactivate' && rider.user_id === null) {
        return { success: false, message: 'This rider has not claimed their account yet.' };
      }

      const newStatus = action === 'suspend' ? 'suspended'
        : action === 'terminate' ? 'terminated'
        : 'active';

      const { error } = await this.supabase
        .from('verified_riders')
        .update({ verification_status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', riderId);

      if (error) {
        return { success: false, message: 'Failed to update rider status.' };
      }

      // Phase 5: keep checkout rider list in sync.
      // findNearbyRiders filters first by user_profiles.is_rider = true,
      // then by rider_profiles.profile_status = 'active'.
      // Both need to be updated so suspended/terminated riders are excluded regardless
      // of whether the rider has set up their rider_profiles record yet.
      if (rider.user_id) {
        const isActiveRider = action === 'reactivate';
        await this.supabase
          .from('user_profiles')
          .update({ is_rider: isActiveRider, updated_at: new Date().toISOString() })
          .eq('id', rider.user_id);

        const profileStatus = isActiveRider ? 'active' : 'inactive';
        await this.supabase
          .from('rider_profiles')
          .update({ profile_status: profileStatus, updated_at: new Date().toISOString() })
          .eq('user_id', rider.user_id);
      }

      const messages: Record<string, string> = {
        suspend: 'Rider suspended successfully.',
        terminate: 'Rider terminated.',
        reactivate: 'Rider reactivated successfully.',
      };

      return { success: true, message: messages[action] };
    } catch (error) {
      this.logger.error('Failed to update rider status:', error);
      return { success: false, message: 'Failed to update rider status.' };
    }
  }

  /**
   * Get partner analytics
   */
  async getPartnerAnalytics(partnerId: string): Promise<any> {
    try {
      // Get delivery trends for the last 30 days
      const deliveryTrends = await this.getDeliveryTrends(partnerId);
      
      // Get rider performance
      const riderPerformance = await this.getRiderPerformance(partnerId);
      
      // Get revenue breakdown
      const revenueBreakdown = await this.getRevenueBreakdown(partnerId);

      return {
        deliveryTrends,
        riderPerformance,
        revenueBreakdown
      };
    } catch (error) {
      this.logger.error('Failed to get partner analytics:', error);
      throw new BadRequestException('Failed to fetch analytics');
    }
  }

  /**
   * Helper method to get partner by ID
   */
  private async getPartnerById(partnerId: string): Promise<any> {
    const { data, error } = await this.supabase
      .from('verified_logistics_partners')
      .select('*')
      .eq('id', partnerId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Partner not found');
    }

    return data;
  }

  /**
   * Get recent rider activity (real data from rider_verification_requests)
   */
  private async getRecentRiderActivity(partnerId: string): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('rider_verification_requests')
      .select('id, full_name, vehicle_type, status, city, country, created_at, updated_at')
      .eq('company_id', partnerId)
      .order('updated_at', { ascending: false })
      .limit(8);

    if (error) {
      this.logger.error('Failed to get recent rider activity:', error);
      return [];
    }

    return data || [];
  }

  /**
   * Get performance metrics (real data aggregated from verified_riders)
   */
  private async getPerformanceMetrics(partnerId: string): Promise<any> {
    const { data: riders, error } = await this.supabase
      .from('verified_riders')
      .select('total_deliveries, completed_deliveries, customer_rating, on_time_rate')
      .eq('company_id', partnerId)
      .eq('verification_status', 'active');

    if (error || !riders || riders.length === 0) {
      return {
        totalDeliveries: 0,
        completedDeliveries: 0,
        averageRating: 0,
        onTimeRate: 0
      };
    }

    const totalDeliveries = riders.reduce((sum, r) => sum + (r.total_deliveries || 0), 0);
    const completedDeliveries = riders.reduce((sum, r) => sum + (r.completed_deliveries || 0), 0);
    const ratingsWithData = riders.filter(r => r.customer_rating > 0);
    const averageRating = ratingsWithData.length
      ? ratingsWithData.reduce((sum, r) => sum + r.customer_rating, 0) / ratingsWithData.length
      : 0;
    const onTimeRatesWithData = riders.filter(r => r.on_time_rate > 0);
    const onTimeRate = onTimeRatesWithData.length
      ? onTimeRatesWithData.reduce((sum, r) => sum + r.on_time_rate, 0) / onTimeRatesWithData.length
      : 0;

    return {
      totalDeliveries,
      completedDeliveries,
      averageRating: parseFloat(averageRating.toFixed(1)),
      onTimeRate: parseFloat(onTimeRate.toFixed(1))
    };
  }

  /**
   * Get delivery trends — no per-delivery time-series table exists yet.
   * Returns empty array; frontend will show an appropriate empty state.
   */
  private async getDeliveryTrends(_partnerId: string): Promise<any[]> {
    return [];
  }

  /**
   * Get rider performance (real data from verified_riders)
   */
  private async getRiderPerformance(partnerId: string): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('verified_riders')
      .select('full_name, vehicle_type, total_deliveries, customer_rating, on_time_rate, verification_status')
      .eq('company_id', partnerId)
      .order('total_deliveries', { ascending: false })
      .limit(10);

    if (error) {
      this.logger.error('Failed to get rider performance:', error);
      return [];
    }

    return (data || []).map(r => ({
      riderName: r.full_name,
      vehicleType: r.vehicle_type,
      deliveries: r.total_deliveries || 0,
      rating: r.customer_rating || 0,
      onTimeRate: r.on_time_rate || 0,
      status: r.verification_status
    }));
  }

  /**
   * Get revenue breakdown (real data from verified_logistics_partners)
   */
  private async getRevenueBreakdown(partnerId: string): Promise<any> {
    const { data: partner, error } = await this.supabase
      .from('verified_logistics_partners')
      .select('total_revenue, platform_commission')
      .eq('id', partnerId)
      .single();

    if (error || !partner) {
      return { totalRevenue: 0, platformCommission: 0, netRevenue: 0 };
    }

    const totalRevenue = partner.total_revenue || 0;
    const platformCommission = partner.platform_commission || 0;
    return {
      totalRevenue,
      platformCommission,
      netRevenue: totalRevenue - platformCommission
    };
  }
}
