import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface PricingMode {
  mode: 'formula' | 'range' | 'hybrid';
  servicePricing?: {
    [serviceCategory: string]: {
      enabled: boolean;
      base_price?: number;
      per_km_rate?: number;
      custom_price?: number;
    };
  };
  pricingRange?: {
    min_price: number;
    max_price: number;
    preferred_price: number;
  };
  pricingPreferences?: {
    use_formula_for_short_distance: boolean;
    use_range_for_long_distance: boolean;
    threshold_km: number;
    formula_max_distance: number;
    range_min_distance: number;
  };
}

export interface PriceCompatibility {
  compatible: boolean;
  compatibility_type: 'perfect' | 'acceptable' | 'below_range' | 'above_range' | 'unknown';
  message: string;
  rider_pricing_mode: string;
  price_diff?: number;
  price_diff_percent?: number;
  rider_min_price?: number;
  rider_max_price?: number;
  active_mode?: string;
}

@Injectable()
export class RiderPricingService {
  private readonly logger = new Logger(RiderPricingService.name);
  private supabase: SupabaseClient;

  constructor(private configService: ConfigService) {
    this.supabase = createClient(
      this.configService.get<string>('SUPABASE_URL')!,
      this.configService.get<string>('SUPABASE_SERVICE_KEY')!,
    );
  }

  async updateRiderPricingMode(
    riderId: string,
    pricingMode: PricingMode,
  ): Promise<{ success: boolean; message: string }> {
    try {
      console.log(`🔄 Updating pricing mode for rider ${riderId} to ${pricingMode.mode}`);

      // Validate pricing mode data
      const validationResult = this.validatePricingMode(pricingMode);
      if (!validationResult.valid) {
        return { success: false, message: validationResult.message };
      }

      // Update rider profile
      const { error } = await this.supabase
        .from('rider_profiles')
        .update({
          pricing_mode: pricingMode.mode,
          pricing_range: pricingMode.pricingRange || null,
          pricing_preferences: pricingMode.pricingPreferences || null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', riderId);

      if (error) {
        console.error('❌ Error updating rider pricing mode:', error);
        return { success: false, message: 'Failed to update pricing mode' };
      }

      console.log(`✅ Successfully updated pricing mode for rider ${riderId}`);
      return { success: true, message: 'Pricing mode updated successfully' };

    } catch (error) {
      console.error('❌ Error in updateRiderPricingMode:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async getRiderPricingMode(riderId: string): Promise<{
    success: boolean;
    pricingMode?: PricingMode;
    message: string;
  }> {
    try {
      const { data, error } = await this.supabase
        .from('rider_profiles')
        .select('pricing_mode, service_pricing, pricing_range, pricing_preferences')
        .eq('user_id', riderId)
        .single();

      if (error || !data) {
        console.error('❌ Error fetching rider pricing mode:', error);
        return { success: false, message: 'Rider not found' };
      }

      const pricingMode: PricingMode = {
        mode: data.pricing_mode || 'formula',
        servicePricing: data.service_pricing,
        pricingRange: data.pricing_range,
        pricingPreferences: data.pricing_preferences,
      };

      return { success: true, pricingMode, message: 'Pricing mode retrieved successfully' };

    } catch (error) {
      console.error('❌ Error in getRiderPricingMode:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async calculateRiderPrice(
    riderId: string,
    distanceKm: number,
    serviceCategory: string = 'intracity',
    orderAmount?: number,
  ): Promise<{
    success: boolean;
    price?: number;
    pricingMode?: string;
    message: string;
  }> {
    try {
      // Use database function for calculation
      const { data, error } = await this.supabase.rpc('calculate_rider_price', {
        rider_profile_id: riderId,
        distance_km: distanceKm,
        service_category: serviceCategory,
        order_amount: orderAmount,
      });

      if (error) {
        console.error('❌ Error calculating rider price:', error);
        return { success: false, message: 'Failed to calculate price' };
      }

      return {
        success: true,
        price: data,
        message: 'Price calculated successfully',
      };

    } catch (error) {
      console.error('❌ Error in calculateRiderPrice:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async checkPriceCompatibility(
    riderId: string,
    orderPrice: number,
    serviceCategory: string = 'intracity',
  ): Promise<{
    success: boolean;
    compatibility?: PriceCompatibility;
    message: string;
  }> {
    try {
      // Use database function for compatibility check
      const { data, error } = await this.supabase.rpc('check_price_compatibility', {
        rider_profile_id: riderId,
        order_price: orderPrice,
        service_category: serviceCategory,
      });

      if (error) {
        console.error('❌ Error checking price compatibility:', error);
        return { success: false, message: 'Failed to check compatibility' };
      }

      return {
        success: true,
        compatibility: data,
        message: 'Compatibility check completed',
      };

    } catch (error) {
      console.error('❌ Error in checkPriceCompatibility:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async getRidersWithPricingCompatibility(
    orderPrice: number,
    serviceCategory: string = 'intracity',
    riderIds?: string[],
  ): Promise<{
    success: boolean;
    riders?: Array<{
      riderId: string;
      riderName: string;
      pricingMode: string;
      compatibility: PriceCompatibility;
      calculatedPrice?: number;
    }>;
    message: string;
  }> {
    try {
      let query = this.supabase
        .from('rider_profiles')
        .select(`
          user_id,
          username,
          pricing_mode,
          pricing_range,
          pricing_preferences,
          service_pricing
        `);

      if (riderIds && riderIds.length > 0) {
        query = query.in('user_id', riderIds);
      }

      const { data: riders, error } = await query;

      if (error) {
        console.error('❌ Error fetching riders for compatibility check:', error);
        return { success: false, message: 'Failed to fetch riders' };
      }

      const ridersWithCompatibility = await Promise.all(
        riders.map(async (rider) => {
          const compatibilityResult = await this.checkPriceCompatibility(
            rider.user_id,
            orderPrice,
            serviceCategory,
          );

          const priceResult = await this.calculateRiderPrice(
            rider.user_id,
            5, // Default distance for comparison
            serviceCategory,
          );

          return {
            riderId: rider.user_id,
            riderName: rider.username || 'Unknown Rider',
            pricingMode: rider.pricing_mode || 'formula',
            compatibility: compatibilityResult.compatibility || {
              compatible: true,
              compatibility_type: 'unknown',
              message: 'Compatibility check failed',
              rider_pricing_mode: rider.pricing_mode || 'formula',
            },
            calculatedPrice: priceResult.price,
          };
        })
      );

      return {
        success: true,
        riders: ridersWithCompatibility,
        message: 'Compatibility check completed',
      };

    } catch (error) {
      console.error('❌ Error in getRidersWithPricingCompatibility:', error);
      return { success: false, message: 'Internal server error' };
    }
  }

  async migrateRiderToNewPricingMode(
    riderId: string,
    newMode: 'range' | 'hybrid',
    options?: {
      minPrice?: number;
      maxPrice?: number;
      preferredPrice?: number;
      thresholdKm?: number;
    },
  ): Promise<{ success: boolean; message: string }> {
    try {
      console.log(`🔄 Migrating rider ${riderId} to ${newMode} pricing mode`);

      // Get current rider profile
      const { data: currentProfile, error } = await this.supabase
        .from('rider_profiles')
        .select('service_pricing, pricing_mode')
        .eq('user_id', riderId)
        .single();

      if (error || !currentProfile) {
        return { success: false, message: 'Rider not found' };
      }

      const newPricingMode: PricingMode = {
        mode: newMode,
        servicePricing: currentProfile.service_pricing,
      };

      if (newMode === 'range') {
        // Calculate range from current formula pricing
        const intracityPricing = currentProfile.service_pricing?.intracity;
        if (intracityPricing) {
          const basePrice = intracityPricing.base_price || 2.0;
          const perKmRate = intracityPricing.per_km_rate || 0.5;
          
          newPricingMode.pricingRange = {
            min_price: options?.minPrice || basePrice,
            max_price: options?.maxPrice || (basePrice + (perKmRate * 20)), // 20km max
            preferred_price: options?.preferredPrice || (basePrice + (perKmRate * 10)), // 10km preferred
          };
        }
      } else if (newMode === 'hybrid') {
        // Set up hybrid preferences
        newPricingMode.pricingPreferences = {
          use_formula_for_short_distance: true,
          use_range_for_long_distance: true,
          threshold_km: options?.thresholdKm || 10,
          formula_max_distance: 5,
          range_min_distance: 5,
        };

        // Also set up range for long distances
        const intracityPricing = currentProfile.service_pricing?.intracity;
        if (intracityPricing) {
          const basePrice = intracityPricing.base_price || 2.0;
          const perKmRate = intracityPricing.per_km_rate || 0.5;
          
          newPricingMode.pricingRange = {
            min_price: options?.minPrice || basePrice,
            max_price: options?.maxPrice || (basePrice + (perKmRate * 20)),
            preferred_price: options?.preferredPrice || (basePrice + (perKmRate * 10)),
          };
        }
      }

      // Update the rider profile
      const updateResult = await this.updateRiderPricingMode(riderId, newPricingMode);
      
      if (updateResult.success) {
        console.log(`✅ Successfully migrated rider ${riderId} to ${newMode} pricing mode`);
        return { success: true, message: `Successfully migrated to ${newMode} pricing mode` };
      } else {
        return updateResult;
      }

    } catch (error) {
      console.error('❌ Error in migrateRiderToNewPricingMode:', error);
      return { success: false, message: 'Migration failed' };
    }
  }

  async getPricingModeStatistics(): Promise<{
    totalRiders: number;
    formulaMode: number;
    rangeMode: number;
    hybridMode: number;
    averagePrice: number;
    priceRange: { min: number; max: number };
  }> {
    try {
      const { data, error } = await this.supabase
        .from('rider_profiles')
        .select('pricing_mode, pricing_range');

      if (error || !data) {
        return {
          totalRiders: 0,
          formulaMode: 0,
          rangeMode: 0,
          hybridMode: 0,
          averagePrice: 0,
          priceRange: { min: 0, max: 0 },
        };
      }

      const stats = data.reduce((acc, rider) => {
        acc.totalRiders++;
        
        switch (rider.pricing_mode) {
          case 'formula':
            acc.formulaMode++;
            break;
          case 'range':
            acc.rangeMode++;
            if (rider.pricing_range?.preferred_price) {
              acc.prices.push(rider.pricing_range.preferred_price);
            }
            break;
          case 'hybrid':
            acc.hybridMode++;
            if (rider.pricing_range?.preferred_price) {
              acc.prices.push(rider.pricing_range.preferred_price);
            }
            break;
        }
        
        return acc;
      }, {
        totalRiders: 0,
        formulaMode: 0,
        rangeMode: 0,
        hybridMode: 0,
        prices: [] as number[],
      });

      const averagePrice = stats.prices.length > 0 
        ? stats.prices.reduce((sum, price) => sum + price, 0) / stats.prices.length 
        : 0;

      const priceRange = stats.prices.length > 0
        ? {
            min: Math.min(...stats.prices),
            max: Math.max(...stats.prices),
          }
        : { min: 0, max: 0 };

      return {
        totalRiders: stats.totalRiders,
        formulaMode: stats.formulaMode,
        rangeMode: stats.rangeMode,
        hybridMode: stats.hybridMode,
        averagePrice,
        priceRange,
      };

    } catch (error) {
      console.error('❌ Error in getPricingModeStatistics:', error);
      return {
        totalRiders: 0,
        formulaMode: 0,
        rangeMode: 0,
        hybridMode: 0,
        averagePrice: 0,
        priceRange: { min: 0, max: 0 },
      };
    }
  }

  private validatePricingMode(pricingMode: PricingMode): { valid: boolean; message: string } {
    // Validate pricing mode
    if (!['formula', 'range', 'hybrid'].includes(pricingMode.mode)) {
      return { valid: false, message: 'Invalid pricing mode' };
    }

    // Validate range pricing if provided
    if (pricingMode.mode === 'range' && pricingMode.pricingRange) {
      const { min_price, max_price, preferred_price } = pricingMode.pricingRange;
      
      if (min_price < 0 || max_price < 0 || preferred_price < 0) {
        return { valid: false, message: 'Prices must be positive' };
      }
      
      if (min_price > max_price) {
        return { valid: false, message: 'Minimum price cannot be greater than maximum price' };
      }
      
      if (preferred_price < min_price || preferred_price > max_price) {
        return { valid: false, message: 'Preferred price must be within range' };
      }
    }

    // Validate hybrid preferences if provided
    if (pricingMode.mode === 'hybrid' && pricingMode.pricingPreferences) {
      const { threshold_km, formula_max_distance, range_min_distance } = pricingMode.pricingPreferences;
      
      if (threshold_km < 0 || formula_max_distance < 0 || range_min_distance < 0) {
        return { valid: false, message: 'Distance values must be positive' };
      }
      
      if (formula_max_distance > range_min_distance) {
        return { valid: false, message: 'Formula max distance cannot be greater than range min distance' };
      }
    }

    return { valid: true, message: 'Valid pricing mode' };
  }
}
