import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { 
  CreateRiderVerificationDto, 
  VerifyRiderDto, 
  RejectRiderDto,
  VerificationFiltersDto,
  RiderFiltersDto 
} from './dto/create-rider-verification.dto';
import { LogisticsNotificationService } from '../logistics-partners/logistics-notification.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditEntityType, AuditStatus } from '../audit/dto/audit.dto';

export interface RiderVerification {
  id: string;
  user_id: string;
  full_name: string;
  country: string;
  state: string;
  city?: string;
  vehicle_type: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_year?: number;
  license_plate?: string;
  company_id?: string;
  company_name?: string;
  driver_license_url?: string;
  vehicle_registration_url?: string;
  insurance_document_url?: string;
  profile_photo_url?: string;
  years_experience?: number;
  previous_delivery_companies?: string[];
  status: 'in_progress' | 'under_review' | 'verified' | 'rejected';
  rejection_reason?: string;
  admin_notes?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  verification_details?: Record<string, any>;
  application_email_sent: boolean;
  review_email_sent: boolean;
  decision_email_sent: boolean;
  created_at: string;
  updated_at: string;
}

export interface VerifiedRider {
  id: string;
  user_id: string;
  verification_request_id: string;
  full_name: string;
  vehicle_type: string;
  company_id?: string;
  verification_status: 'active' | 'suspended' | 'terminated';
  total_deliveries: number;
  completed_deliveries: number;
  average_delivery_time?: number;
  customer_rating?: number;
  on_time_rate?: number;
  verified_by?: string;
  verified_at: string;
  verification_notes?: string;
  created_at: string;
  updated_at: string;
}

export interface RiderVerificationList {
  requests: RiderVerification[];
  total: number;
  page: number;
  limit: number;
}

export interface VerifiedRiderList {
  riders: VerifiedRider[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class RiderVerificationService {
  private readonly logger = new Logger(RiderVerificationService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationService: LogisticsNotificationService,
    private auditService: AuditService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Create a new rider verification request
   */
  async createVerificationRequest(data: CreateRiderVerificationDto, userId: string): Promise<void> {
    this.logger.log(`Creating rider verification request for user ${userId}`);

    try {
      // Check if verification already exists
      const { data: existing } = await this.supabase
        .from('rider_verification_requests')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (existing) {
        throw new BadRequestException('Verification request already exists');
      }

      const { error } = await this.supabase
        .from('rider_verification_requests')
        .insert({
          user_id: userId,
          full_name: data.full_name,
          country: data.country,
          state: data.state,
          city: data.city,
          vehicle_type: data.vehicle_type,
          vehicle_make: data.vehicle_make,
          vehicle_model: data.vehicle_model,
          vehicle_year: data.vehicle_year,
          license_plate: data.license_plate,
          company_id: data.company_id,
          company_name: data.company_name,
          driver_license_url: data.driver_license_url,
          vehicle_registration_url: data.vehicle_registration_url,
          insurance_document_url: data.insurance_document_url,
          profile_photo_url: data.profile_photo_url,
          years_experience: data.years_experience,
          previous_delivery_companies: data.previous_delivery_companies || [],
        });

      if (error) {
        this.logger.error('Failed to create verification request:', error);
        throw new BadRequestException('Failed to create verification request');
      }

      // Get user email for notification
      const { data: user } = await this.supabase
        .from('user_profiles')
        .select('email')
        .eq('id', userId)
        .single();

      if (user?.email) {
        await this.notificationService.sendRiderApplicationReceived(
          user.email,
          data.full_name
        );
      }

      // Log audit (using system ID for user submissions)
      await this.auditService.log({
        staffId: '00000000-0000-0000-0000-000000000000', // System user ID
        action: AuditAction.CREATE,
        entityType: AuditEntityType.RIDER_VERIFICATION,
        entityId: userId,
        details: `Rider verification request created for ${data.full_name}`,
        status: AuditStatus.SUCCESS,
      });

      this.logger.log(`Rider verification request created for user ${userId}`);
    } catch (error) {
      this.logger.error('Error creating verification request:', error);
      throw error;
    }
  }

  /**
   * Get verification status by user ID
   */
  async getVerificationByUserId(userId: string): Promise<RiderVerification> {
    const { data: verification, error } = await this.supabase
      .from('rider_verification_requests')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !verification) {
      throw new NotFoundException('Verification request not found');
    }

    return verification;
  }

  /**
   * Get all verification requests with filters (admin endpoint)
   */
  async getAllVerifications(filters: VerificationFiltersDto): Promise<RiderVerificationList> {
    let query = this.supabase
      .from('rider_verification_requests')
      .select('*', { count: 'exact' });

    // Apply filters
    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    if (filters.search) {
      query = query.or(`full_name.ilike.%${filters.search}%,country.ilike.%${filters.search}%,state.ilike.%${filters.search}%`);
    }

    // Apply pagination
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    // Order by created_at desc
    query = query.order('created_at', { ascending: false });

    const { data: requests, error, count } = await query;

    if (error) {
      this.logger.error('Failed to fetch verification requests:', error);
      throw new BadRequestException('Failed to fetch verification requests');
    }

    return {
      requests: requests || [],
      total: count || 0,
      page: page,
      limit: limit,
    };
  }

  /**
   * Update verification status to under_review
   */
  async updateVerificationToUnderReview(id: string, adminId: string): Promise<void> {
    const { error } = await this.supabase
      .from('rider_verification_requests')
      .update({
        status: 'under_review',
        reviewed_by: adminId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      this.logger.error('Failed to update verification status:', error);
      throw new BadRequestException('Failed to update verification status');
    }

    // Get verification details for email
    const { data: verification } = await this.supabase
      .from('rider_verification_requests')
      .select('full_name, user_id')
      .eq('id', id)
      .single();

    if (verification) {
      // Get user email
      const { data: user } = await this.supabase
        .from('user_profiles')
        .select('email')
        .eq('id', verification.user_id)
        .single();

      if (user?.email) {
        await this.notificationService.sendRiderUnderReview(
          user.email,
          verification.full_name
        );
      }
    }
  }

  /**
   * Verify rider
   */
  async verifyRider(verificationId: string, adminId: string, data: VerifyRiderDto): Promise<void> {
    this.logger.log(`Verifying rider: ${verificationId}`);

    // Get verification details
    const { data: verification, error: fetchError } = await this.supabase
      .from('rider_verification_requests')
      .select('*')
      .eq('id', verificationId)
      .single();

    if (fetchError || !verification) {
      throw new NotFoundException('Verification request not found');
    }

    try {
      // Start transaction
      const { error: updateError } = await this.supabase
        .from('rider_verification_requests')
        .update({
          status: 'verified',
          reviewed_by: adminId,
          reviewed_at: new Date().toISOString(),
          verification_details: data.verification_details || {},
          admin_notes: data.notes,
        })
        .eq('id', verificationId);

      if (updateError) {
        throw new BadRequestException('Failed to verify rider');
      }

      // Create verified rider record
      const { error: riderError } = await this.supabase
        .from('verified_riders')
        .insert({
          user_id: verification.user_id,
          verification_request_id: verificationId,
          full_name: verification.full_name,
          vehicle_type: verification.vehicle_type,
          company_id: verification.company_id,
          verified_by: adminId,
          verification_notes: data.notes,
        });

      if (riderError) {
        throw new BadRequestException('Failed to create verified rider');
      }

      // Update user_profiles to mark as verified rider
      await this.supabase
        .from('user_profiles')
        .update({
          is_rider: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', verification.user_id);

      // Send verification email
      const { data: user } = await this.supabase
        .from('user_profiles')
        .select('email')
        .eq('id', verification.user_id)
        .single();

      if (user?.email) {
        await this.notificationService.sendRiderVerified(
          user.email,
          verification.full_name
        );
      }

      // Log audit
      await this.auditService.log({
        staffId: adminId,
        action: AuditAction.UPDATE,
        entityType: AuditEntityType.RIDER_VERIFICATION,
        entityId: verificationId,
        details: `Rider verified for ${verification.full_name}`,
        status: AuditStatus.SUCCESS,
      });

      this.logger.log(`Rider verified successfully: ${verification.full_name}`);
    } catch (error) {
      this.logger.error('Error verifying rider:', error);
      throw error;
    }
  }

  /**
   * Reject rider verification
   */
  async rejectRider(verificationId: string, adminId: string, data: RejectRiderDto): Promise<void> {
    this.logger.log(`Rejecting rider verification: ${verificationId}`);

    // Get verification details
    const { data: verification, error: fetchError } = await this.supabase
      .from('rider_verification_requests')
      .select('*')
      .eq('id', verificationId)
      .single();

    if (fetchError || !verification) {
      throw new NotFoundException('Verification request not found');
    }

    try {
      // Update verification status
      const { error: updateError } = await this.supabase
        .from('rider_verification_requests')
        .update({
          status: 'rejected',
          reviewed_by: adminId,
          reviewed_at: new Date().toISOString(),
          rejection_reason: data.reason,
          admin_notes: data.admin_notes,
        })
        .eq('id', verificationId);

      if (updateError) {
        throw new BadRequestException('Failed to reject verification');
      }

      // Send rejection email
      const { data: user } = await this.supabase
        .from('user_profiles')
        .select('email')
        .eq('id', verification.user_id)
        .single();

      if (user?.email) {
        await this.notificationService.sendRiderRejected(
          user.email,
          verification.full_name,
          data.reason
        );
      }

      // Log audit
      await this.auditService.log({
        staffId: adminId,
        action: AuditAction.UPDATE,
        entityType: AuditEntityType.RIDER_VERIFICATION,
        entityId: verificationId,
        details: `Rider verification rejected for ${verification.full_name}. Reason: ${data.reason}`,
        status: AuditStatus.SUCCESS,
      });

      this.logger.log(`Rider verification rejected: ${verification.full_name}`);
    } catch (error) {
      this.logger.error('Error rejecting rider:', error);
      throw error;
    }
  }

  /**
   * Get verified riders
   */
  async getVerifiedRiders(filters: RiderFiltersDto): Promise<VerifiedRiderList> {
    let query = this.supabase
      .from('verified_riders')
      .select(`
        *,
        verified_riders!inner(
          company_name
        )
      `, { count: 'exact' });

    // Apply filters
    if (filters.status) {
      query = query.eq('verification_status', filters.status);
    }

    if (filters.company_id) {
      query = query.eq('company_id', filters.company_id);
    }

    if (filters.search) {
      query = query.or(`full_name.ilike.%${filters.search}%,verified_riders.company_name.ilike.%${filters.search}%`);
    }

    // Apply pagination
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    // Order by created_at desc
    query = query.order('created_at', { ascending: false });

    const { data: riders, error, count } = await query;

    if (error) {
      this.logger.error('Failed to fetch verified riders:', error);
      throw new BadRequestException('Failed to fetch verified riders');
    }

    return {
      riders: riders || [],
      total: count || 0,
      page: page,
      limit: limit,
    };
  }

  /**
   * Get verified rider by ID
   */
  async getVerifiedRiderById(riderId: string): Promise<VerifiedRider> {
    const { data: rider, error } = await this.supabase
      .from('verified_riders')
      .select(`
        *,
        verified_riders!inner(
          company_name
        )
      `)
      .eq('id', riderId)
      .single();

    if (error || !rider) {
      throw new NotFoundException('Verified rider not found');
    }

    return rider;
  }

  /**
   * Get verified companies for rider selection
   */
  async getVerifiedCompanies(state?: string): Promise<Array<{ id: string; company_name: string }>> {
    let query = this.supabase
      .from('verified_logistics_partners')
      .select('id, company_name')
      .eq('partner_status', 'active')
      .order('company_name', { ascending: true });

    if (state) {
      query = query.contains('service_areas', [state]);
    }

    const { data: companies, error } = await query;

    if (error) {
      this.logger.error('Failed to fetch verified companies:', error);
      return [];
    }

    return companies || [];
  }

  /**
   * Claim a partner-created rider account using a unique rider ID
   * This replaces the old self-apply flow for partner-affiliated riders
   */
  async claimRiderAccount(
    userId: string,
    uniqueRiderId: string,
    companyId: string,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(`Rider claim attempt: user=${userId} id=${uniqueRiderId} company=${companyId}`);

    try {
      // Check user doesn't already have an active verified_riders record
      const { data: existingActive } = await this.supabase
        .from('verified_riders')
        .select('id, verification_status')
        .eq('user_id', userId)
        .single();

      if (existingActive) {
        return { success: false, message: 'You already have a verified rider account.' };
      }

      // Find the dormant record
      const { data: dormant, error: findError } = await this.supabase
        .from('verified_riders')
        .select('id, verification_status, user_id, company_id, full_name')
        .eq('unique_rider_id', uniqueRiderId.toLowerCase().trim())
        .eq('company_id', companyId)
        .single();

      if (findError || !dormant) {
        return { success: false, message: 'Invalid rider ID or company. Please check and try again.' };
      }

      if (dormant.verification_status === 'terminated') {
        return { success: false, message: 'This rider account has been terminated. Contact your logistics company.' };
      }

      if (dormant.verification_status !== 'dormant') {
        return { success: false, message: 'This rider ID is already claimed by another account.' };
      }

      if (dormant.user_id !== null) {
        return { success: false, message: 'This rider ID is already claimed by another account.' };
      }

      // Activate the rider record
      const { error: updateError } = await this.supabase
        .from('verified_riders')
        .update({
          user_id: userId,
          verification_status: 'active',
          claimed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', dormant.id);

      if (updateError) {
        this.logger.error('Failed to claim rider account:', updateError);
        return { success: false, message: 'Failed to activate account. Please try again.' };
      }

      // Mark user as a rider in their profile
      await this.supabase
        .from('user_profiles')
        .update({ is_rider: true, updated_at: new Date().toISOString() })
        .eq('id', userId);

      // Seed rider_profiles with company pricing if configured
      const { data: company } = await this.supabase
        .from('verified_logistics_partners')
        .select('pricing_config')
        .eq('id', companyId)
        .single();

      if (company?.pricing_config && dormant.vehicle_type) {
        const normalizeVehicleType = (type: string): string => {
          const map: Record<string, string> = {
            bicycle: 'bike', motorcycle: 'bike', tricycle: 'wheelbarrow',
            wheelbarrow: 'wheelbarrow', car: 'car', van: 'van', truck: 'truck', bike: 'bike',
          };
          return map[type.toLowerCase().trim()] ?? type.toLowerCase().trim();
        };
        const rates = company.pricing_config[normalizeVehicleType(dormant.vehicle_type)];
        if (rates?.base_price && rates?.per_km_rate) {
          const categories = ['intracity', 'intercity', 'interstate', 'express', 'cargo'];
          const servicePricing = Object.fromEntries(
            categories.map((cat) => [
              cat,
              { enabled: true, base_price: rates.base_price, per_km_rate: rates.per_km_rate },
            ])
          );
          // Upsert: create or update rider_profiles with company-set pricing
          const { data: existingProfile } = await this.supabase
            .from('rider_profiles')
            .select('id')
            .eq('user_id', userId)
            .single();

          if (existingProfile) {
            await this.supabase
              .from('rider_profiles')
              .update({ service_pricing: servicePricing, updated_at: new Date().toISOString() })
              .eq('user_id', userId);
          } else {
            await this.supabase
              .from('rider_profiles')
              .insert({
                user_id: userId,
                vehicle_type: dormant.vehicle_type,
                service_pricing: servicePricing,
                profile_status: 'active',
              });
          }
        }
      }

      // Send notification email if possible
      const { data: userProfile } = await this.supabase
        .from('user_profiles')
        .select('email')
        .eq('id', userId)
        .single();

      if (userProfile?.email) {
        try {
          await this.notificationService.sendRiderVerified(userProfile.email, dormant.full_name);
        } catch (e) {
          this.logger.warn('Failed to send rider activation email:', e);
        }
      }

      this.logger.log(`Rider account claimed: ${uniqueRiderId} by user ${userId}`);
      return {
        success: true,
        message: `Welcome, ${dormant.full_name}! Your rider account is now active and you can start accepting deliveries.`,
      };
    } catch (error) {
      this.logger.error('Error claiming rider account:', error);
      return { success: false, message: 'Failed to process claim. Please try again.' };
    }
  }

  /**
   * Get pending verification requests count
   */
  async getPendingVerificationsCount(): Promise<number> {
    const { count, error } = await this.supabase
      .from('rider_verification_requests')
      .select('*', { count: 'exact', head: true })
      .in('status', ['in_progress', 'under_review']);

    if (error) {
      this.logger.error('Failed to get pending verifications count:', error);
      return 0;
    }

    return count || 0;
  }

  /**
   * Get total verified riders count
   */
  async getTotalVerifiedRidersCount(): Promise<number> {
    const { count, error } = await this.supabase
      .from('verified_riders')
      .select('*', { count: 'exact', head: true })
      .eq('verification_status', 'active');

    if (error) {
      this.logger.error('Failed to get verified riders count:', error);
      return 0;
    }

    return count || 0;
  }
}
