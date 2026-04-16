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
      return {
        success: result.success,
        message: result.message,
        requiresPasswordChange: result.requires_password_change
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

      // Get rider statistics
      const { data: riderStats } = await this.supabase
        .from('verified_riders')
        .select('count(*)')
        .eq('company_id', partnerId)
        .eq('verification_status', 'active');

      // Get recent deliveries (mock data for now)
      const recentDeliveries = await this.getRecentDeliveries(partnerId);

      // Get performance metrics
      const performanceMetrics = await this.getPerformanceMetrics(partnerId);

      return {
        partner: {
          id: partner.id,
          company_name: partner.company_name,
          partner_username: partner.partner_username,
          contact_email: partner.contact_email,
          contact_phone: partner.contact_phone,
          service_areas: partner.service_areas,
          partner_status: partner.partner_status,
          verified_at: partner.verified_at
        },
        statistics: {
          totalRiders: riderStats?.[0]?.count || 0,
          activeRiders: partner.active_riders || 0,
          totalDeliveries: partner.total_deliveries || 0,
          completedDeliveries: partner.completed_deliveries || 0,
          averageDeliveryTime: partner.average_delivery_time || 0,
          onTimeDeliveryRate: partner.on_time_delivery_rate || 0,
          totalRevenue: partner.total_revenue || 0,
          platformCommission: partner.platform_commission || 0
        },
        recentDeliveries,
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
          full_name,
          vehicle_type,
          verification_status,
          total_deliveries,
          completed_deliveries,
          average_delivery_time,
          customer_rating,
          on_time_rate,
          verified_at
        `)
        .eq('company_id', partnerId)
        .order('verified_at', { ascending: false });

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
      const { data, error } = await this.supabase
        .from('verified_logistics_partners')
        .update({
          contact_person_name: updateData.contactPersonName,
          contact_email: updateData.contactEmail,
          contact_phone: updateData.contactPhone,
          company_website: updateData.companyWebsite,
          headquarters_address: updateData.headquartersAddress,
          updated_at: new Date().toISOString()
        })
        .eq('id', partnerId)
        .select('id, company_name, partner_username, contact_email, contact_phone, company_website, headquarters_address')
        .single();

      if (error) {
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
        .rpc('generate_partner_password_reset_token', { p_username: username });

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

      // Update password
      const { error } = await this.supabase
        .from('verified_logistics_partners')
        .update({
          partner_password_hash: newPassword, // Will be hashed by trigger
          updated_at: new Date().toISOString()
        })
        .eq('id', partnerId);

      if (error) {
        throw new BadRequestException('Failed to change password');
      }

      return {
        success: true,
        message: 'Password changed successfully'
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
   * Get recent deliveries (mock implementation)
   */
  private async getRecentDeliveries(partnerId: string): Promise<any[]> {
    // This would typically query a deliveries table
    // For now, return mock data
    return [
      {
        id: '1',
        customerName: 'John Doe',
        deliveryAddress: '123 Main St, Lagos',
        status: 'completed',
        deliveredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        riderName: 'James Wilson'
      },
      {
        id: '2',
        customerName: 'Jane Smith',
        deliveryAddress: '456 Oak Ave, Abuja',
        status: 'in_progress',
        deliveredAt: null,
        riderName: 'Michael Brown'
      }
    ];
  }

  /**
   * Get performance metrics (mock implementation)
   */
  private async getPerformanceMetrics(partnerId: string): Promise<any> {
    // This would typically query performance data
    return {
      weeklyDeliveries: 245,
      weeklyRevenue: 48750.50,
      averageRating: 4.7,
      onTimeRate: 94.2,
      customerSatisfaction: 96.8
    };
  }

  /**
   * Get delivery trends (mock implementation)
   */
  private async getDeliveryTrends(partnerId: string): Promise<any[]> {
    // This would typically query a deliveries table
    // For now, return mock data
    const trends: Array<{date: string, deliveries: number, revenue: number}> = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      trends.push({
        date: date.toISOString().split('T')[0],
        deliveries: Math.floor(Math.random() * 50) + 20,
        revenue: Math.floor(Math.random() * 10000) + 5000
      });
    }
    return trends;
  }

  /**
   * Get rider performance (mock implementation)
   */
  private async getRiderPerformance(partnerId: string): Promise<any[]> {
    return [
      {
        riderName: 'James Wilson',
        deliveries: 156,
        rating: 4.8,
        onTimeRate: 95.2
      },
      {
        riderName: 'Michael Brown',
        deliveries: 142,
        rating: 4.6,
        onTimeRate: 92.8
      },
      {
        riderName: 'Sarah Johnson',
        deliveries: 134,
        rating: 4.9,
        onTimeRate: 97.5
      }
    ];
  }

  /**
   * Get revenue breakdown (mock implementation)
   */
  private async getRevenueBreakdown(partnerId: string): Promise<any> {
    return {
      totalRevenue: 245000.75,
      platformCommission: 24500.08,
      netRevenue: 220500.67,
      breakdown: [
        { category: 'Express Delivery', amount: 125000.50, percentage: 51.0 },
        { category: 'Standard Delivery', amount: 85000.25, percentage: 34.7 },
        { category: 'Bulk Delivery', amount: 35000.00, percentage: 14.3 }
      ]
    };
  }
}
