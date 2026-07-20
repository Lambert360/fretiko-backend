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
  HttpStatus 
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { RiderVerificationService, RiderVerification, VerifiedRider } from './rider-verification.service';
import { 
  CreateRiderVerificationDto, 
  VerifyRiderDto, 
  RejectRiderDto,
  VerificationFiltersDto,
  RiderFiltersDto 
} from './dto/create-rider-verification.dto';

@Controller('rider-verification')
@UseGuards(JwtAuthGuard)
export class RiderVerificationController {
  constructor(private readonly riderVerificationService: RiderVerificationService) {}

  /**
   * Claim a partner-created dormant rider account
   * POST /rider-verification/claim
   */
  @Post('claim')
  async claimRiderAccount(
    @Body() body: { unique_rider_id: string; company_id: string },
    @Req() req: any,
  ): Promise<{ success: boolean; message: string }> {
    return this.riderVerificationService.claimRiderAccount(
      req.user.sub,
      body.unique_rider_id,
      body.company_id,
    );
  }

  /**
   * Submit rider verification request
   * POST /rider-verification/apply
   */
  @Post('apply')
  async applyForVerification(
    @Body() data: CreateRiderVerificationDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.riderVerificationService.createVerificationRequest(data, req.user.sub);
      return {
        success: true,
        message: 'Verification request submitted successfully. You will be notified once reviewed.',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to submit verification request',
      };
    }
  }

  /**
   * Get verification status for current user
   * GET /rider-verification/status
   */
  @Get('status')
  async getVerificationStatus(@Req() req: any): Promise<{
    success: boolean;
    verification?: RiderVerification;
    message?: string;
  }> {
    try {
      const verification = await this.riderVerificationService.getVerificationByUserId(req.user.sub);
      return {
        success: true,
        verification,
      };
    } catch (error) {
      return {
        success: false,
        message: 'No verification request found',
      };
    }
  }

  /**
   * Get verified companies for rider selection
   * GET /rider-verification/companies?state=Lagos
   */
  @Get('companies')
  async getVerifiedCompanies(
    @Query('state') state?: string,
  ): Promise<{
    success: boolean;
    companies?: Array<{ id: string; company_name: string }>;
    message?: string;
  }> {
    try {
      const companies = await this.riderVerificationService.getVerifiedCompanies(state);
      return {
        success: true,
        companies,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to fetch verified companies',
      };
    }
  }

  /**
   * Get all verification requests (admin endpoint)
   * GET /rider-verification/requests
   * Requires: view_rider_verifications permission
   */
  @Get('requests')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_rider_verifications')
  async getVerificationRequests(
    @Query() filters: VerificationFiltersDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    data?: any;
    message?: string;
  }> {
    try {
      const result = await this.riderVerificationService.getAllVerifications(filters);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to fetch verification requests',
      };
    }
  }

  /**
   * Get verification request by ID (admin endpoint)
   * GET /rider-verification/requests/:id
   * Requires: view_rider_verifications permission
   */
  @Get('requests/:id')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_rider_verifications')
  async getVerificationRequestById(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    verification?: RiderVerification;
    message?: string;
  }> {
    try {
      const verification = await this.riderVerificationService.getVerificationByUserId(id);
      return {
        success: true,
        verification,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Verification request not found',
      };
    }
  }

  /**
   * Update verification to under review (admin endpoint)
   * PATCH /rider-verification/requests/:id/review
   * Requires: view_rider_verifications permission
   */
  @Patch('requests/:id/review')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_rider_verifications')
  async updateVerificationToUnderReview(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.riderVerificationService.updateVerificationToUnderReview(id, req.user.sub);
      return {
        success: true,
        message: 'Verification status updated to under review',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to update verification status',
      };
    }
  }

  /**
   * Verify rider (admin endpoint)
   * POST /rider-verification/requests/:id/verify
   * Requires: verify_riders permission
   */
  @Post('requests/:id/verify')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('verify_riders')
  async verifyRider(
    @Param('id') id: string,
    @Body() data: VerifyRiderDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.riderVerificationService.verifyRider(id, req.user.sub, data);
      return {
        success: true,
        message: 'Rider verified successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to verify rider',
      };
    }
  }

  /**
   * Reject rider verification (admin endpoint)
   * POST /rider-verification/requests/:id/reject
   * Requires: verify_riders permission
   */
  @Post('requests/:id/reject')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('verify_riders')
  async rejectRider(
    @Param('id') id: string,
    @Body() data: RejectRiderDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.riderVerificationService.rejectRider(id, req.user.sub, data);
      return {
        success: true,
        message: 'Rider verification rejected successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to reject rider verification',
      };
    }
  }

  /**
   * Get verified riders (admin endpoint)
   * GET /rider-verification/verified
   * Requires: manage_verified_riders permission
   */
  @Get('verified')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('manage_verified_riders')
  async getVerifiedRiders(
    @Query() filters: RiderFiltersDto,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    data?: any;
    message?: string;
  }> {
    try {
      const result = await this.riderVerificationService.getVerifiedRiders(filters);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to fetch verified riders',
      };
    }
  }

  /**
   * Get verified rider by ID (admin endpoint)
   * GET /rider-verification/verified/:id
   * Requires: manage_verified_riders permission
   */
  @Get('verified/:id')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('manage_verified_riders')
  async getVerifiedRiderById(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<{
    success: boolean;
    rider?: VerifiedRider;
    message?: string;
  }> {
    try {
      const rider = await this.riderVerificationService.getVerifiedRiderById(id);
      return {
        success: true,
        rider,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Verified rider not found',
      };
    }
  }

  /**
   * Get dashboard statistics (admin endpoint)
   * GET /rider-verification/stats
   * Requires: view_rider_verifications permission
   */
  @Get('stats')
  @UseGuards(StaffJwtAuthGuard, PermissionsGuard)
  @Permissions('view_rider_verifications')
  async getStats(@Req() req: any): Promise<{
    success: boolean;
    data?: any;
    message?: string;
  }> {
    try {
      const pendingVerifications = await this.riderVerificationService.getPendingVerificationsCount();
      const totalVerifiedRiders = await this.riderVerificationService.getTotalVerifiedRidersCount();

      return {
        success: true,
        data: {
          pendingVerifications,
          totalVerifiedRiders,
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
