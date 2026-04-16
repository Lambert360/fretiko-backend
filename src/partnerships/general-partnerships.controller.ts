import { 
  Controller, 
  Get, 
  Post, 
  Patch,
  Body, 
  Param, 
  Query, 
  UseGuards,
  HttpStatus
} from '@nestjs/common';
import { 
  ApiTags,
  ApiResponse,
  ApiOperation,
  ApiBearerAuth 
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GeneralPartnershipsService, GeneralPartnership } from './general-partnerships.service';
import { 
  CreateGeneralPartnershipDto, 
  UpdatePartnershipStatusDto 
} from './dto/create-general-partnership.dto';

@ApiTags('general-partnerships')
@Controller('general-partnerships')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class GeneralPartnershipsController {
  constructor(private readonly generalPartnershipsService: GeneralPartnershipsService) {}

  /**
   * Create a new general partnership application
   */
  @Post()
  @ApiOperation({ summary: 'Create general partnership application' })
  @ApiResponse({ status: 201, description: 'Partnership application created successfully' })
  async createPartnership(@Body() data: CreateGeneralPartnershipDto): Promise<{
    success: boolean;
    id: string;
    message: string;
  }> {
    try {
      const result = await this.generalPartnershipsService.createPartnership(data);
      return {
        success: true,
        id: result.id,
        message: 'Partnership application submitted successfully. We will review your request and get back to you soon.',
      };
    } catch (error) {
      return {
        success: false,
        id: '',
        message: error.message || 'Failed to submit partnership application',
      };
    }
  }

  /**
   * Get all general partnership applications
   */
  @Get()
  @ApiOperation({ summary: 'Get all general partnership applications' })
  @ApiResponse({ status: 200, description: 'Partnerships retrieved successfully' })
  async getPartnerships(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ): Promise<{
    success: boolean;
    partnerships: GeneralPartnership[];
    total: number;
    message: string;
  }> {
    try {
      const result = await this.generalPartnershipsService.getPartnerships({
        page,
        limit,
        status,
        search,
      });
      return {
        success: true,
        partnerships: result.partnerships,
        total: result.total,
        message: 'Partnerships retrieved successfully',
      };
    } catch (error) {
      return {
        success: false,
        partnerships: [],
        total: 0,
        message: error.message || 'Failed to fetch partnerships',
      };
    }
  }

  /**
   * Get partnership by ID
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get general partnership by ID' })
  @ApiResponse({ status: 200, description: 'Partnership retrieved successfully' })
  async getPartnershipById(@Param('id') id: string): Promise<{
    success: boolean;
    partnership?: GeneralPartnership;
    message: string;
  }> {
    try {
      const partnership = await this.generalPartnershipsService.getPartnershipById(id);
      return {
        success: true,
        partnership,
        message: 'Partnership retrieved successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to fetch partnership',
      };
    }
  }

  /**
   * Update partnership status
   */
  @Patch(':id/status')
  @ApiOperation({ summary: 'Update general partnership status' })
  @ApiResponse({ status: 200, description: 'Partnership status updated successfully' })
  async updatePartnershipStatus(
    @Param('id') id: string,
    @Body() data: UpdatePartnershipStatusDto,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      await this.generalPartnershipsService.updatePartnershipStatus(id, data.status);
      return {
        success: true,
        message: 'Partnership status updated successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Failed to update partnership status',
      };
    }
  }
}
