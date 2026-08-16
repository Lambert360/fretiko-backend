import { 
  Controller, 
  Post, 
  Get, 
  Patch, 
  Param, 
  Query, 
  Body, 
  UseGuards,
  Req,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  ParseFilePipe,
  ValidationPipe,
  MaxFileSizeValidator,
  FileTypeValidator
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { LogisticsPartnersService, PartnerApplication, VerifiedPartner } from './logistics-partners.service';
import { 
  CreatePartnerApplicationDto, 
  VerifyPartnerDto, 
  RejectApplicationDto,
  ApplicationFiltersDto,
  PartnerFiltersDto 
} from './dto/create-partner-application.dto';

@Controller('logistics-partners')
export class LogisticsPartnersController {
  constructor(private readonly logisticsPartnersService: LogisticsPartnersService) {}

  /**
   * Submit partnership application (public endpoint)
   * POST /logistics-partners/apply
   */
  @Post('apply')
  @UseInterceptors(FileInterceptor('companyLogo'))
  async applyForPartnership(
    @Body() data: any,
    @UploadedFile() companyLogo?: Express.Multer.File,
  ): Promise<{
    success: boolean;
    trackingId: string;
    message: string;
  }> {
    try {
      // Handle both JSON and FormData inputs
      let applicationData: CreatePartnerApplicationDto;
      
      if (typeof data === 'object' && !Array.isArray(data)) {
        // FormData case - data is already parsed
        applicationData = {
          company_name: data.company_name,
          company_logo_url: companyLogo ? `file:${companyLogo.originalname}` : data.company_logo_url,
          company_registration_number: data.company_registration_number,
          tax_id: data.tax_id,
          contact_person_name: data.contact_person_name,
          contact_email: data.contact_email,
          contact_phone: data.contact_phone,
          company_website: data.company_website,
          headquarters_address: data.headquarters_address,
          service_areas: data.service_areas,
          operating_hours: data.operating_hours,
          vehicle_fleet: data.vehicle_fleet,
          total_riders: data.total_riders,
          average_daily_deliveries: data.average_daily_deliveries,
          years_in_operation: data.years_in_operation,
          insurance_coverage: data.insurance_coverage,
          service_categories: data.service_categories,
          registration_document_urls: data.registration_document_urls || [],
          insurance_document_urls: data.insurance_document_urls || [],
          fleet_document_urls: data.fleet_document_urls || []
        };
      } else {
        // JSON case
        applicationData = data as CreatePartnerApplicationDto;
      }

      const result = await this.logisticsPartnersService.createApplication(applicationData, companyLogo);
      return {
        success: true,
        trackingId: result.trackingId,
        message: 'Application submitted successfully. Please save your tracking ID for future reference.',
      };
    } catch (error) {
      return {
        success: false,
        trackingId: '',
        message: error.message || 'Failed to submit application',
      };
    }
  }

  /**
   * Track application status (public endpoint)
   * GET /logistics-partners/track/:trackingId
   */
  @Get('track/:trackingId')
  async trackApplication(@Param('trackingId') trackingId: string): Promise<{
    success: boolean;
    application?: PartnerApplication;
    message?: string;
  }> {
    try {
      const application = await this.logisticsPartnersService.getApplicationByTrackingId(trackingId);
      return {
        success: true,
        application,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Application not found or invalid tracking ID',
      };
    }
  }

  /**
   * Get all applications (admin endpoint)
   * GET /logistics-partners/applications
   * Requires: view_partner_applications permission
   */
  @Get('applications')
  @UseGuards(StaffJwtAuthGuard)
  async getApplications(
    @Query() filters: ApplicationFiltersDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    data?: any;
    message?: string;
  }> {
    try {
      const result = await this.logisticsPartnersService.getAllApplications(filters);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to fetch applications',
      };
    }
  }

  /**
   * Get application by ID (admin endpoint)
   * GET /logistics-partners/applications/:id
   * Requires: view_partner_applications permission
   */
  @Get('applications/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('view_partner_applications')
  async getApplicationById(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    application?: PartnerApplication;
    message?: string;
  }> {
    try {
      // Get application by tracking ID for admin use
      const application = await this.logisticsPartnersService.getApplicationByTrackingId(id);
      return {
        success: true,
        application,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Application not found',
      };
    }
  }

  /**
   * Update application to under review (admin endpoint)
   * PATCH /logistics-partners/applications/:id/review
   * Requires: view_partner_applications permission
   */
  @Patch('applications/:id/review')
  @UseGuards(PermissionsGuard)
  @Permissions('view_partner_applications')
  async updateApplicationToUnderReview(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.logisticsPartnersService.updateApplicationToUnderReview(id, req.user.sub);
      return {
        success: true,
        message: 'Application status updated to under review',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to update application status',
      };
    }
  }

  /**
   * Verify partner application (admin endpoint)
   * POST /logistics-partners/applications/:id/verify
   * Requires: verify_logistics_partners permission
   */
  @Post('applications/:id/verify')
  @UseGuards(PermissionsGuard)
  @Permissions('verify_logistics_partners')
  async verifyApplication(
    @Param('id') id: string,
    @Body() data: VerifyPartnerDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.logisticsPartnersService.verifyPartner(id, req.user.sub, data);
      return {
        success: true,
        message: 'Partner application verified successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to verify application',
      };
    }
  }

  /**
   * Reject partner application (admin endpoint)
   * POST /logistics-partners/applications/:id/reject
   * Requires: verify_logistics_partners permission
   */
  @Post('applications/:id/reject')
  @UseGuards(PermissionsGuard)
  @Permissions('verify_logistics_partners')
  async rejectApplication(
    @Param('id') id: string,
    @Body() data: RejectApplicationDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.logisticsPartnersService.rejectApplication(id, req.user.sub, data);
      return {
        success: true,
        message: 'Partner application rejected successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to reject application',
      };
    }
  }

  /**
   * Get verified partners (admin endpoint)
   * GET /logistics-partners/verified
   * Requires: view_verified_partners permission
   */
  @Get('verified')
  @UseGuards(PermissionsGuard)
  @Permissions('view_verified_partners')
  async getVerifiedPartners(
    @Query() filters: PartnerFiltersDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    data?: any;
    message?: string;
  }> {
    try {
      const result = await this.logisticsPartnersService.getVerifiedPartners(filters);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to fetch verified partners',
      };
    }
  }

  /**
   * Get partner by ID (admin endpoint)
   * GET /logistics-partners/verified/:id
   * Requires: view_verified_partners permission
   */
  @Get('verified/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('view_verified_partners')
  async getPartnerById(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    partner?: VerifiedPartner;
    message?: string;
  }> {
    try {
      const partner = await this.logisticsPartnersService.getPartnerById(id);
      return {
        success: true,
        partner,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Partner not found',
      };
    }
  }

  /**
   * Update partner status (admin endpoint)
   * PATCH /logistics-partners/verified/:id/status
   * Requires: manage_verified_partners permission
   */
  @Patch('verified/:id/status')
  @UseGuards(PermissionsGuard)
  @Permissions('manage_verified_partners')
  async updatePartnerStatus(
    @Param('id') id: string,
    @Body() body: { status: 'active' | 'suspended' | 'terminated' },
    @Req() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.logisticsPartnersService.updatePartnerStatus(id, body.status);
      return {
        success: true,
        message: `Partner status updated to ${body.status}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to update partner status',
      };
    }
  }

  /**
   * Get dashboard statistics (admin endpoint)
   * GET /logistics-partners/stats
   * Requires: view_partner_applications permission
   */
  @Get('stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_partner_applications')
  async getStats(@Req() req: any): Promise<{
    success: boolean;
    data?: any;
    message?: string;
  }> {
    try {
      const pendingApplications = await this.logisticsPartnersService.getPendingApplicationsCount();
      const totalPartners = await this.logisticsPartnersService.getTotalVerifiedPartnersCount();

      return {
        success: true,
        data: {
          pendingApplications,
          totalPartners,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to fetch statistics',
      };
    }
  }
}
