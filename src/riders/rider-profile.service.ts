import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import {
  CreateRiderProfileDto,
  UpdateRiderProfileDto,
  VehicleInfoDto,
  ServicePricingDto,
} from './dto/rider-profile.dto';

export interface RiderProfile {
  id: string;
  user_id: string;
  vehicle_type: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_year?: number;
  vehicle_color?: string;
  license_plate?: string;
  vehicle_capacity_weight?: number;
  vehicle_capacity_volume?: number;
  vehicle_photos: string[];
  vehicle_condition: string;
  service_pricing: any;
  promised_delivery_time?: number;
  delivery_promise_message?: string;
  is_online: boolean;
  is_available: boolean;
  max_delivery_distance: number;
  operating_hours: any;
  profile_status: string;
  profile_completion: number;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class RiderProfileService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Get rider profile by user ID
   */
  async getRiderProfile(userId: string): Promise<RiderProfile | null> {
    try {
      // First check if user is a rider
      const { data: userProfile, error: userError } = await this.supabase
        .from('user_profiles')
        .select('is_rider')
        .eq('id', userId)
        .single();

      if (userError || !userProfile?.is_rider) {
        throw new ForbiddenException('User is not a rider');
      }

      const { data, error } = await this.supabase
        .from('rider_profiles')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No profile found
          return null;
        }
        console.error('Error fetching rider profile:', error);
        throw new Error('Failed to fetch rider profile');
      }

      return data;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      console.error('Error in getRiderProfile:', error);
      throw new Error('Failed to fetch rider profile');
    }
  }

  /**
   * Create a new rider profile
   */
  async createRiderProfile(
    userId: string,
    data: CreateRiderProfileDto,
  ): Promise<RiderProfile> {
    try {
      // Check if user is a rider
      const { data: userProfile, error: userError } = await this.supabase
        .from('user_profiles')
        .select('is_rider')
        .eq('id', userId)
        .single();

      if (userError || !userProfile?.is_rider) {
        throw new ForbiddenException('User is not a rider');
      }

      // Check if profile already exists
      const existingProfile = await this.getRiderProfile(userId);
      if (existingProfile) {
        throw new BadRequestException('Rider profile already exists');
      }

      // Calculate initial profile completion
      const profileCompletion = this.calculateProfileCompletion({
        ...data,
        user_id: userId,
      } as any);

      const { data: newProfile, error } = await this.supabase
        .from('rider_profiles')
        .insert({
          user_id: userId,
          ...data,
          profile_completion: profileCompletion,
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating rider profile:', error);
        throw new Error('Failed to create rider profile');
      }

      return newProfile;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof BadRequestException) {
        throw error;
      }
      console.error('Error in createRiderProfile:', error);
      throw new Error('Failed to create rider profile');
    }
  }

  /**
   * Update rider profile
   */
  async updateRiderProfile(
    userId: string,
    data: UpdateRiderProfileDto,
  ): Promise<RiderProfile> {
    try {
      // Verify profile exists
      const existingProfile = await this.getRiderProfile(userId);
      if (!existingProfile) {
        throw new NotFoundException('Rider profile not found');
      }

      // Calculate updated profile completion
      const updatedData = { ...existingProfile, ...data };
      const profileCompletion = this.calculateProfileCompletion(updatedData);

      const { data: updatedProfile, error } = await this.supabase
        .from('rider_profiles')
        .update({
          ...data,
          profile_completion: profileCompletion,
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        console.error('Error updating rider profile:', error);
        throw new Error('Failed to update rider profile');
      }

      return updatedProfile;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Error in updateRiderProfile:', error);
      throw new Error('Failed to update rider profile');
    }
  }

  /**
   * Update vehicle information
   */
  async updateVehicleInfo(
    userId: string,
    data: VehicleInfoDto,
  ): Promise<RiderProfile> {
    return this.updateRiderProfile(userId, data);
  }

  /**
   * Update service pricing
   */
  async updateServicePricing(
    userId: string,
    pricing: ServicePricingDto,
  ): Promise<RiderProfile> {
    try {
      // Verify at least one service is enabled
      const hasEnabledService = Object.values(pricing).some(
        (service: any) => service?.enabled === true,
      );

      if (!hasEnabledService) {
        throw new BadRequestException('At least one service category must be enabled');
      }

      return this.updateRiderProfile(userId, { service_pricing: pricing });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      console.error('Error in updateServicePricing:', error);
      throw new Error('Failed to update service pricing');
    }
  }

  /**
   * Toggle online status
   */
  async toggleOnlineStatus(userId: string, isOnline: boolean): Promise<RiderProfile> {
    try {
      const { data, error } = await this.supabase
        .from('rider_profiles')
        .update({ is_online: isOnline })
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        console.error('Error toggling online status:', error);
        throw new Error('Failed to toggle online status');
      }

      // Also update rider_locations table if it exists
      try {
        await this.supabase
          .from('rider_locations')
          .update({ is_online: isOnline })
          .eq('user_id', userId);
      } catch (locError) {
        // Non-critical error, just log it
        console.warn('Could not update rider_locations:', locError);
      }

      return data;
    } catch (error) {
      console.error('Error in toggleOnlineStatus:', error);
      throw new Error('Failed to toggle online status');
    }
  }

  /**
   * Upload vehicle photos
   */
  async uploadVehiclePhotos(userId: string, photos: string[]): Promise<RiderProfile> {
    try {
      if (photos.length > 5) {
        throw new BadRequestException('Maximum 5 photos allowed');
      }

      return this.updateRiderProfile(userId, { vehicle_photos: photos });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      console.error('Error in uploadVehiclePhotos:', error);
      throw new Error('Failed to upload vehicle photos');
    }
  }

  /**
   * Calculate profile completion percentage
   */
  calculateProfileCompletion(profile: Partial<RiderProfile>): number {
    let completion = 0;

    // Vehicle type (20%)
    if (profile.vehicle_type) {
      completion += 20;
    }

    // At least 1 service enabled (20%)
    if (profile.service_pricing) {
      const hasEnabledService = Object.values(profile.service_pricing).some(
        (service: any) => service?.enabled === true,
      );
      if (hasEnabledService) {
        completion += 20;
      }
    }

    // Pricing set (20%) - check if any service has pricing configured
    if (profile.service_pricing) {
      const hasPricing = Object.values(profile.service_pricing).some(
        (service: any) =>
          service?.enabled &&
          (service?.base_price > 0 || service?.per_km_rate > 0 || service?.custom_price > 0),
      );
      if (hasPricing) {
        completion += 20;
      }
    }

    // Vehicle photo uploaded (20%)
    if (profile.vehicle_photos && profile.vehicle_photos.length > 0) {
      completion += 20;
    }

    // Delivery promise set (10%)
    if (profile.promised_delivery_time && profile.delivery_promise_message) {
      completion += 10;
    }

    // Operating hours set (10%)
    if (profile.operating_hours) {
      completion += 10;
    }

    return Math.min(100, completion);
  }

  /**
   * Get rider profile with stats (for Stats tab)
   */
  async getRiderProfileWithStats(userId: string): Promise<any> {
    try {
      const profile = await this.getRiderProfile(userId);
      if (!profile) {
        throw new NotFoundException('Rider profile not found');
      }

      // Fetch trust scores and stats
      const { data: trustScore } = await this.supabase
        .from('trust_scores')
        .select('rider_trust_score, completed_orders')
        .eq('user_id', userId)
        .single();

      // Fetch wallet earnings
      const { data: wallet } = await this.supabase
        .from('wallets')
        .select('total_rider_earnings')
        .eq('user_id', userId)
        .single();

      return {
        ...profile,
        stats: {
          total_deliveries: trustScore?.completed_orders || 0,
          rating: this.calculateRating(trustScore?.completed_orders || 0),
          total_earnings: wallet?.total_rider_earnings || 0,
          trust_score: trustScore?.rider_trust_score || 750,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Error in getRiderProfileWithStats:', error);
      throw new Error('Failed to fetch rider profile with stats');
    }
  }

  /**
   * Calculate rating based on completed orders
   */
  private calculateRating(completedOrders: number): number {
    if (completedOrders === 0) return 0;
    if (completedOrders < 5) return 3.5;
    if (completedOrders < 10) return 4.0;
    if (completedOrders < 25) return 4.2;
    if (completedOrders < 50) return 4.5;
    if (completedOrders < 100) return 4.7;
    return 4.9;
  }
}

