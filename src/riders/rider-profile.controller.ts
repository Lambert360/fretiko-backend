import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RiderProfileService } from './rider-profile.service';
import {
  CreateRiderProfileDto,
  UpdateRiderProfileDto,
  VehicleInfoDto,
  ServicePricingDto,
  ToggleOnlineStatusDto,
  UploadPhotosDto,
} from './dto/rider-profile.dto';

@Controller('riders/profile')
@UseGuards(JwtAuthGuard)
export class RiderProfileController {
  constructor(private readonly riderProfileService: RiderProfileService) {}

  /**
   * Get current rider's profile
   */
  @Get()
  async getRiderProfile(@Request() req) {
    try {
      const userId = req.user.sub;
      const profile = await this.riderProfileService.getRiderProfile(userId);
      
      if (!profile) {
        return {
          success: true,
          profile: null,
          message: 'No rider profile found. Please create one.',
        };
      }

      return {
        success: true,
        profile,
      };
    } catch (error) {
      console.error('Error fetching rider profile:', error);
      throw new HttpException(
        error.message || 'Failed to fetch rider profile',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get rider profile with stats
   */
  @Get('stats')
  async getRiderProfileWithStats(@Request() req) {
    try {
      const userId = req.user.sub;
      const profileWithStats = await this.riderProfileService.getRiderProfileWithStats(userId);

      return {
        success: true,
        profile: profileWithStats,
      };
    } catch (error) {
      console.error('Error fetching rider profile with stats:', error);
      throw new HttpException(
        error.message || 'Failed to fetch rider profile with stats',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Create rider profile
   */
  @Post()
  async createRiderProfile(
    @Request() req,
    @Body() createDto: CreateRiderProfileDto,
  ) {
    try {
      const userId = req.user.sub;
      const profile = await this.riderProfileService.createRiderProfile(userId, createDto);

      return {
        success: true,
        profile,
        message: 'Rider profile created successfully',
      };
    } catch (error) {
      console.error('Error creating rider profile:', error);
      throw new HttpException(
        error.message || 'Failed to create rider profile',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Update rider profile
   */
  @Patch()
  async updateRiderProfile(
    @Request() req,
    @Body() updateDto: UpdateRiderProfileDto,
  ) {
    try {
      const userId = req.user.sub;
      const profile = await this.riderProfileService.updateRiderProfile(userId, updateDto);

      return {
        success: true,
        profile,
        message: 'Rider profile updated successfully',
      };
    } catch (error) {
      console.error('Error updating rider profile:', error);
      throw new HttpException(
        error.message || 'Failed to update rider profile',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Update vehicle information
   */
  @Patch('vehicle')
  async updateVehicleInfo(
    @Request() req,
    @Body() vehicleDto: VehicleInfoDto,
  ) {
    try {
      const userId = req.user.sub;
      const profile = await this.riderProfileService.updateVehicleInfo(userId, vehicleDto);

      return {
        success: true,
        profile,
        message: 'Vehicle information updated successfully',
      };
    } catch (error) {
      console.error('Error updating vehicle info:', error);
      throw new HttpException(
        error.message || 'Failed to update vehicle information',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Update service pricing
   */
  @Patch('pricing')
  async updateServicePricing(
    @Request() req,
    @Body() pricingDto: ServicePricingDto,
  ) {
    try {
      const userId = req.user.sub;
      const profile = await this.riderProfileService.updateServicePricing(userId, pricingDto);

      return {
        success: true,
        profile,
        message: 'Service pricing updated successfully',
      };
    } catch (error) {
      console.error('Error updating service pricing:', error);
      throw new HttpException(
        error.message || 'Failed to update service pricing',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Toggle online/offline status
   */
  @Post('toggle-online')
  async toggleOnlineStatus(
    @Request() req,
    @Body() toggleDto: ToggleOnlineStatusDto,
  ) {
    try {
      const userId = req.user.sub;
      const profile = await this.riderProfileService.toggleOnlineStatus(
        userId,
        toggleDto.is_online,
      );

      return {
        success: true,
        profile,
        message: `You are now ${toggleDto.is_online ? 'online' : 'offline'}`,
      };
    } catch (error) {
      console.error('Error toggling online status:', error);
      throw new HttpException(
        error.message || 'Failed to toggle online status',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Upload vehicle photos
   */
  @Post('upload-photos')
  async uploadVehiclePhotos(
    @Request() req,
    @Body() uploadDto: UploadPhotosDto,
  ) {
    try {
      const userId = req.user.sub;
      const profile = await this.riderProfileService.uploadVehiclePhotos(
        userId,
        uploadDto.photos,
      );

      return {
        success: true,
        profile,
        message: 'Vehicle photos uploaded successfully',
      };
    } catch (error) {
      console.error('Error uploading vehicle photos:', error);
      throw new HttpException(
        error.message || 'Failed to upload vehicle photos',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

