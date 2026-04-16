import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { 
  CreatePartnerApplicationDto, 
  VerifyPartnerDto, 
  RejectApplicationDto,
  ApplicationFiltersDto,
  PartnerFiltersDto 
} from './dto/create-partner-application.dto';
import { LogisticsNotificationService } from './logistics-notification.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditEntityType, AuditStatus } from '../audit/dto/audit.dto';

export interface PartnerApplication {
  id: string;
  tracking_id: string;
  company_name: string;
  company_logo_url?: string;
  company_registration_number?: string;
  tax_id?: string;
  contact_person_name: string;
  contact_email: string;
  contact_phone?: string;
  company_website?: string;
  headquarters_address: string;
  service_areas: string[];
  operating_hours?: Record<string, { start: string; end: string }>;
  vehicle_fleet: Record<string, { count: number; photos?: string[] }>;
  total_riders?: number;
  average_daily_deliveries?: number;
  years_in_operation?: number;
  insurance_coverage?: Record<string, any>;
  service_categories?: string[];
  registration_document_urls?: string[];
  insurance_document_urls?: string[];
  fleet_document_urls?: string[];
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

export interface VerifiedPartner {
  id: string;
  application_id: string;
  company_name: string;
  company_logo_url?: string;
  contact_email: string;
  contact_phone?: string;
  headquarters_address: string;
  service_areas: string[];
  partner_status: 'active' | 'suspended' | 'terminated';
  total_riders: number;
  active_riders: number;
  total_deliveries: number;
  completed_deliveries: number;
  average_delivery_time?: number;
  on_time_delivery_rate?: number;
  total_revenue: number;
  platform_commission: number;
  verified_by?: string;
  verified_at: string;
  verification_notes?: string;
  created_at: string;
  updated_at: string;
}

export interface PartnerApplicationList {
  applications: PartnerApplication[];
  total: number;
  page: number;
  limit: number;
}

export interface VerifiedPartnerList {
  partners: VerifiedPartner[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class LogisticsPartnersService {
  private readonly logger = new Logger(LogisticsPartnersService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationService: LogisticsNotificationService,
    private auditService: AuditService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Get content type based on file extension
   */
  private getContentType(fileName: string): string {
    const extension = fileName.toLowerCase().split('.').pop();
    const contentTypes: { [key: string]: string } = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'txt': 'text/plain',
      'bin': 'application/octet-stream'
    };
    return contentTypes[extension || ''] || 'application/octet-stream';
  }

  /**
   * Upload file to Supabase Storage
   */
  private async uploadFile(file: any, folder: string, fileName: string): Promise<string> {
    try {
      // Generate unique filename
      const fileExtension = fileName.split('.').pop();
      const uniqueFileName = `${folder}/${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExtension}`;
      
      // Use appropriate bucket based on folder type
      let bucket: string;
      if (folder === 'logos') {
        bucket = 'company-logos'; // Use dedicated logos bucket (public)
      } else {
        bucket = 'partnership-documents'; // Use documents bucket for all other files
      }
      
      // Upload file to Supabase Storage
      const detectedContentType = this.getContentType(fileName);
      this.logger.log(`Uploading ${fileName} with content type: ${detectedContentType} to bucket: ${bucket}`);
      
      // Ensure file is in proper buffer format for Supabase
      let fileBuffer: Buffer;
      if (file instanceof Buffer) {
        fileBuffer = file;
      } else if (file.buffer) {
        fileBuffer = Buffer.from(file.buffer);
      } else if (file.arrayBuffer) {
        const arrayBuffer = await file.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuffer);
      } else {
        // Fallback: try to convert to buffer
        fileBuffer = Buffer.from(file.toString());
      }
      
      const { data: uploadData, error: uploadError } = await this.supabase.storage
        .from(bucket)
        .upload(uniqueFileName, fileBuffer, {
          contentType: detectedContentType,
          upsert: false,
        });

      if (uploadError) {
        this.logger.error(`File upload failed for ${fileName}:`, uploadError);
        throw new BadRequestException(`Upload failed: ${uploadError.message}`);
      }

      // Get public URL
      const { data: urlData } = this.supabase.storage
        .from(bucket)
        .getPublicUrl(uniqueFileName);

      return urlData.publicUrl;
    } catch (error) {
      this.logger.error(`Error uploading file ${fileName}:`, error);
      this.logger.error('Error details:', JSON.stringify(error, null, 2));
      throw new BadRequestException(`Failed to upload file: ${fileName}`);
    }
  }

  /**
   * Upload multiple files and return URLs
   */
  private async uploadFiles(files: any[], folder: string): Promise<string[]> {
    const uploadPromises = files.map(async (file) => {
      if (typeof file === 'string' && file.startsWith('blob:')) {
        // Handle blob URLs - need to fetch the actual file data
        try {
          const response = await fetch(file);
          const blob = await response.blob();
          const fileName = `file_${Date.now()}.bin`;
          return await this.uploadFile(blob, folder, fileName);
        } catch (error) {
          this.logger.error(`Failed to fetch blob URL: ${file}`, error);
          return null;
        }
      } else if (file instanceof File || file instanceof Blob) {
        // Handle File/Blob objects
        const fileName = (file as File).name || `file_${Date.now()}.bin`;
        return await this.uploadFile(file, folder, fileName);
      } else if (typeof file === 'string') {
        // Return existing URLs as-is
        return file;
      }
      return null;
    });

    const results = await Promise.all(uploadPromises);
    return results.filter(url => url !== null);
  }

  /**
   * Create a new partnership application
   */
  async createApplication(
    data: CreatePartnerApplicationDto, 
    companyLogoFile?: Express.Multer.File
  ): Promise<{ trackingId: string }> {
    this.logger.log(`Creating partnership application for ${data.company_name}`);
    this.logger.log('Input data:', JSON.stringify({
      company_name: data.company_name,
      hasCompanyLogoFile: !!companyLogoFile,
      companyLogoUrl: data.company_logo_url,
      registrationDocumentUrls: data.registration_document_urls,
      insuranceDocumentUrls: data.insurance_document_urls,
      fleetDocumentUrls: data.fleet_document_urls
    }, null, 2));

    try {
      // Generate tracking ID manually (fits 20 char limit)
      const trackingId = `LPA${Date.now().toString(36).substr(-8).toUpperCase()}`;
      this.logger.log(`Generated tracking ID: ${trackingId}`);

      // Upload files to Supabase Storage
      this.logger.log('Uploading files to Supabase Storage...');
      
      let companyLogoUrl = data.company_logo_url;
      let registrationDocumentUrls = data.registration_document_urls || [];
      let insuranceDocumentUrls = data.insurance_document_urls || [];
      let fleetDocumentUrls = data.fleet_document_urls || [];

      // Parse document URLs if they're strings (coming from FormData)
      if (typeof registrationDocumentUrls === 'string') {
        try {
          registrationDocumentUrls = JSON.parse(registrationDocumentUrls);
        } catch (e) {
          registrationDocumentUrls = [];
        }
      }
      if (typeof insuranceDocumentUrls === 'string') {
        try {
          insuranceDocumentUrls = JSON.parse(insuranceDocumentUrls);
        } catch (e) {
          insuranceDocumentUrls = [];
        }
      }
      if (typeof fleetDocumentUrls === 'string') {
        try {
          fleetDocumentUrls = JSON.parse(fleetDocumentUrls);
        } catch (e) {
          fleetDocumentUrls = [];
        }
      }

      this.logger.log('Parsed document URLs:', {
        registration: registrationDocumentUrls.length,
        insurance: insuranceDocumentUrls.length,
        fleet: fleetDocumentUrls.length
      });

      // Upload company logo if file is provided
      try {
        if (companyLogoFile) {
          this.logger.log('Uploading company logo file...');
          companyLogoUrl = await this.uploadFile(companyLogoFile, 'logos', companyLogoFile.originalname);
          this.logger.log(`Company logo uploaded successfully: ${companyLogoUrl}`);
        } else if (companyLogoUrl && typeof companyLogoUrl === 'string' && companyLogoUrl.startsWith('blob:')) {
          // Handle blob URLs (fallback)
          this.logger.log('Handling company logo blob URL...');
          const response = await fetch(companyLogoUrl);
          const blob = await response.blob();
          companyLogoUrl = await this.uploadFile(blob, 'logos', 'company_logo.png');
          this.logger.log(`Company logo blob uploaded successfully: ${companyLogoUrl}`);
        }
      } catch (uploadError) {
        this.logger.error('Company logo upload failed:', uploadError);
        throw uploadError;
      }

      // Upload registration documents (now receiving actual Supabase URLs)
      this.logger.log(`Processing registration documents: ${registrationDocumentUrls.length} items`);
      if (registrationDocumentUrls.length > 0) {
        // These are already Supabase URLs, no need to upload
        this.logger.log(`Registration documents are already uploaded: ${registrationDocumentUrls.length} URLs`);
      }

      // Upload insurance documents (now receiving actual Supabase URLs)
      this.logger.log(`Processing insurance documents: ${insuranceDocumentUrls.length} items`);
      if (insuranceDocumentUrls.length > 0) {
        // These are already Supabase URLs, no need to upload
        this.logger.log(`Insurance documents are already uploaded: ${insuranceDocumentUrls.length} URLs`);
      }

      // Upload fleet documents (now receiving actual Supabase URLs)
      this.logger.log(`Processing fleet documents: ${fleetDocumentUrls.length} items`);
      if (fleetDocumentUrls.length > 0) {
        // These are already Supabase URLs, no need to upload
        this.logger.log(`Fleet documents are already uploaded: ${fleetDocumentUrls.length} URLs`);
      }

      this.logger.log('All file uploads completed, proceeding with database insert...');

      // Parse JSON fields for database insert
      const serviceAreas = typeof data.service_areas === 'string' 
        ? JSON.parse(data.service_areas) 
        : data.service_areas;
      
      const vehicleFleet = typeof data.vehicle_fleet === 'string' 
        ? JSON.parse(data.vehicle_fleet) 
        : data.vehicle_fleet;
      
      const operatingHours = typeof data.operating_hours === 'string' 
        ? JSON.parse(data.operating_hours) 
        : data.operating_hours;
      
      const insuranceCoverage = typeof data.insurance_coverage === 'string' 
        ? JSON.parse(data.insurance_coverage) 
        : data.insurance_coverage;
      
      const serviceCategories = typeof data.service_categories === 'string' 
        ? JSON.parse(data.service_categories) 
        : data.service_categories;

      this.logger.log('Parsed fields for database:', {
        serviceAreas: Array.isArray(serviceAreas) ? serviceAreas.length : 'not array',
        vehicleFleet: typeof vehicleFleet,
        serviceCategories: Array.isArray(serviceCategories) ? serviceCategories.length : 'not array'
      });

      // Simple INSERT - include tracking_id to prevent trigger conflicts
      const { error } = await this.supabase
        .from('logistics_partner_applications')
        .insert({
          tracking_id: trackingId, // Include tracking_id to prevent trigger
          company_name: data.company_name,
          company_logo_url: companyLogoUrl,
          company_registration_number: data.company_registration_number,
          tax_id: data.tax_id,
          contact_person_name: data.contact_person_name,
          contact_email: data.contact_email,
          contact_phone: data.contact_phone,
          company_website: data.company_website,
          headquarters_address: data.headquarters_address,
          service_areas: serviceAreas, // Parsed array
          operating_hours: operatingHours, // Parsed object
          vehicle_fleet: vehicleFleet, // Parsed object
          total_riders: data.total_riders || 0,
          average_daily_deliveries: data.average_daily_deliveries || 0,
          years_in_operation: data.years_in_operation,
          insurance_coverage: insuranceCoverage, // Parsed object
          service_categories: serviceCategories, // Parsed array
          registration_document_urls: registrationDocumentUrls,
          insurance_document_urls: insuranceDocumentUrls,
          fleet_document_urls: fleetDocumentUrls
        });

      if (error) {
        this.logger.error('Failed to create application:', error);
        this.logger.error('Database error details:', JSON.stringify(error, null, 2));
        this.logger.error('Application data being inserted:', {
          tracking_id: trackingId,
          company_name: data.company_name,
          company_logo_url: companyLogoUrl,
          service_areas: data.service_areas,
          vehicle_fleet: data.vehicle_fleet
        });
        throw new BadRequestException(`Failed to create application: ${error.message || 'Unknown database error'}`);
      }

      if (!trackingId) {
        this.logger.error('No tracking ID returned from database');
        throw new BadRequestException('Failed to generate tracking ID');
      }

      // Send application received email
      await this.notificationService.sendCompanyApplicationReceived(
        data.contact_email,
        data.company_name,
        trackingId
      );

      return { trackingId };
    } catch (error) {
      this.logger.error('Error creating application:', error);
      throw new BadRequestException('Failed to create application');
    }
  }

  /**
   * Get all logistics partnership applications
   */
  async getApplications(filters?: ApplicationFiltersDto): Promise<PartnerApplication[]> {
    // Implementation here
    return [];
  }

  /**
   * Get application by tracking ID (public endpoint)
   */
  async getApplicationByTrackingId(trackingId: string): Promise<PartnerApplication> {
    const { data: application, error } = await this.supabase
      .from('logistics_partner_applications')
      .select('*')
      .eq('tracking_id', trackingId)
      .single();

    if (error || !application) {
      throw new NotFoundException('Application not found');
    }

    return application;
  }

  /**
   * Get all applications with filters (admin endpoint)
   */
  async getAllApplications(filters: ApplicationFiltersDto): Promise<PartnerApplicationList> {
    let query = this.supabase
      .from('logistics_partner_applications')
      .select('*', { count: 'exact' });

    // Apply filters
    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    if (filters.search) {
      query = query.or(`company_name.ilike.%${filters.search}%,contact_email.ilike.%${filters.search}%`);
    }

    // Apply pagination
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    // Order by created_at desc
    query = query.order('created_at', { ascending: false });

    const { data: applications, error, count } = await query;

    if (error) {
      this.logger.error('Failed to fetch applications:', error);
      throw new BadRequestException('Failed to fetch applications');
    }

    return {
      applications: applications || [],
      total: count || 0,
      page: page,
      limit: limit,
    };
  }

  /**
   * Update application status to under_review
   */
  async updateApplicationToUnderReview(id: string, adminId: string): Promise<void> {
    const { error } = await this.supabase
      .from('logistics_partner_applications')
      .update({
        status: 'under_review',
        reviewed_by: adminId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      this.logger.error('Failed to update application status:', error);
      throw new BadRequestException('Failed to update application status');
    }

    // Get application details for email
    const { data: application } = await this.supabase
      .from('logistics_partner_applications')
      .select('company_name, contact_email')
      .eq('id', id)
      .single();

    if (application) {
      await this.notificationService.sendCompanyUnderReview(
        application.contact_email,
        application.company_name
      );
    }
  }

  /**
   * Verify partner application
   */
  async verifyPartner(applicationId: string, adminId: string, data: VerifyPartnerDto): Promise<void> {
    this.logger.log(`Verifying partner application: ${applicationId}`);

    // Get application details
    const { data: application, error: fetchError } = await this.supabase
      .from('logistics_partner_applications')
      .select('*')
      .eq('id', applicationId)
      .single();

    if (fetchError || !application) {
      throw new NotFoundException('Application not found');
    }

    try {
      // Start transaction
      const { error: updateError } = await this.supabase
        .from('logistics_partner_applications')
        .update({
          status: 'verified',
          reviewed_by: adminId,
          reviewed_at: new Date().toISOString(),
          verification_details: data.verification_details || {},
          admin_notes: data.notes,
        })
        .eq('id', applicationId);

      if (updateError) {
        throw new BadRequestException('Failed to verify application');
      }

      // Create verified partner record
      const { data: partner, error: partnerError } = await this.supabase
        .from('verified_logistics_partners')
        .insert({
          application_id: applicationId,
          company_name: application.company_name,
          company_logo_url: application.company_logo_url,
          contact_email: application.contact_email,
          contact_phone: application.contact_phone,
          headquarters_address: application.headquarters_address,
          service_areas: application.service_areas,
          verified_by: adminId,
          verification_notes: data.notes,
        })
        .select()
        .single();

      if (partnerError) {
        throw new BadRequestException('Failed to create verified partner');
      }

      // Send verification email with password setup instructions
      await this.notificationService.sendCompanyVerifiedWithPasswordSetup(
        application.contact_email,
        application.company_name,
        partner.partner_username
      );

      // Log audit
      await this.auditService.log({
        staffId: adminId,
        action: AuditAction.UPDATE,
        entityType: AuditEntityType.LOGISTICS_PARTNERSHIP,
        entityId: applicationId,
        details: `Partner application verified for ${application.company_name}`,
        status: AuditStatus.SUCCESS,
      });

      this.logger.log(`Partner verified successfully: ${application.company_name}`);
    } catch (error) {
      this.logger.error('Error verifying partner:', error);
      throw error;
    }
  }

  /**
   * Reject partner application
   */
  async rejectApplication(applicationId: string, adminId: string, data: RejectApplicationDto): Promise<void> {
    this.logger.log(`Rejecting partner application: ${applicationId}`);

    // Get application details
    const { data: application, error: fetchError } = await this.supabase
      .from('logistics_partner_applications')
      .select('*')
      .eq('id', applicationId)
      .single();

    if (fetchError || !application) {
      throw new NotFoundException('Application not found');
    }

    try {
      // Update application status
      const { error: updateError } = await this.supabase
        .from('logistics_partner_applications')
        .update({
          status: 'rejected',
          reviewed_by: adminId,
          reviewed_at: new Date().toISOString(),
          rejection_reason: data.reason,
          admin_notes: data.admin_notes,
        })
        .eq('id', applicationId);

      if (updateError) {
        throw new BadRequestException('Failed to reject application');
      }

      // Send rejection email
      await this.notificationService.sendCompanyRejected(
        application.contact_email,
        application.company_name,
        data.reason
      );

      // Log audit
      await this.auditService.log({
        staffId: adminId,
        action: AuditAction.UPDATE,
        entityType: AuditEntityType.LOGISTICS_PARTNERSHIP,
        entityId: applicationId,
        details: `Partner application rejected for ${application.company_name}. Reason: ${data.reason}`,
        status: AuditStatus.SUCCESS,
      });

      this.logger.log(`Partner application rejected: ${application.company_name}`);
    } catch (error) {
      this.logger.error('Error rejecting application:', error);
      throw error;
    }
  }

  /**
   * Get verified partners
   */
  async getVerifiedPartners(filters: PartnerFiltersDto): Promise<VerifiedPartnerList> {
    let query = this.supabase
      .from('verified_logistics_partners')
      .select('*', { count: 'exact' });

    // Apply filters
    if (filters.status) {
      query = query.eq('partner_status', filters.status);
    }

    if (filters.search) {
      query = query.or(`company_name.ilike.%${filters.search}%,contact_email.ilike.%${filters.search}%`);
    }

    // Apply pagination
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    // Order by created_at desc
    query = query.order('created_at', { ascending: false });

    const { data: partners, error, count } = await query;

    if (error) {
      this.logger.error('Failed to fetch verified partners:', error);
      throw new BadRequestException('Failed to fetch verified partners');
    }

    return {
      partners: partners || [],
      total: count || 0,
      page: page,
      limit: limit,
    };
  }

  /**
   * Get partner by ID
   */
  async getPartnerById(partnerId: string): Promise<VerifiedPartner> {
    const { data: partner, error } = await this.supabase
      .from('verified_logistics_partners')
      .select('*')
      .eq('id', partnerId)
      .single();

    if (error || !partner) {
      throw new NotFoundException('Partner not found');
    }

    return partner;
  }

  /**
   * Update partner status
   */
  async updatePartnerStatus(partnerId: string, status: 'active' | 'suspended' | 'terminated'): Promise<void> {
    const { error } = await this.supabase
      .from('verified_logistics_partners')
      .update({
        partner_status: status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', partnerId);

    if (error) {
      this.logger.error('Failed to update partner status:', error);
      throw new BadRequestException('Failed to update partner status');
    }

    this.logger.log(`Partner status updated to ${status}: ${partnerId}`);
  }

  /**
   * Get pending applications count
   */
  async getPendingApplicationsCount(): Promise<number> {
    const { count, error } = await this.supabase
      .from('logistics_partner_applications')
      .select('*', { count: 'exact', head: true })
      .in('status', ['in_progress', 'under_review']);

    if (error) {
      this.logger.error('Failed to get pending applications count:', error);
      return 0;
    }

    return count || 0;
  }

  /**
   * Get total verified partners count
   */
  async getTotalVerifiedPartnersCount(): Promise<number> {
    const { count, error } = await this.supabase
      .from('verified_logistics_partners')
      .select('*', { count: 'exact', head: true })
      .eq('partner_status', 'active');

    if (error) {
      this.logger.error('Failed to get verified partners count:', error);
      return 0;
    }

    return count || 0;
  }
}
