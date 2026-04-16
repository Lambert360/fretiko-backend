import { 
  Controller, 
  Post, 
  Get, 
  Patch, 
  Body, 
  Req,
  Res,
  HttpStatus,
  HttpCode,
  ValidationPipe
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { PartnersService } from './partners.service';
import { 
  PartnerLoginDto, 
  PartnerResetPasswordDto,
  PartnerChangePasswordDto 
} from './dto/partner-auth.dto';

@Controller('partners')
export class PartnersController {
  constructor(
    private readonly partnersService: PartnersService,
    private readonly jwtService: JwtService
  ) {}

  /**
   * Partner login
   * POST /partners/login
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(ValidationPipe) loginDto: PartnerLoginDto,
    @Res({ passthrough: true }) response: Response
  ) {
    try {
      const result = await this.partnersService.validateLogin(
        loginDto.username, 
        loginDto.password
      );

      if (!result.success) {
        return {
          success: false,
          message: result.message
        };
      }

      // Generate JWT token
      const payload = {
        sub: result.partner.id,
        username: result.partner.partner_username,
        company_name: result.partner.company_name,
        role: 'partner'
      };

      const token = this.jwtService.sign(payload, {
        expiresIn: '24h'
      });

      // Set HTTP-only cookie for enhanced security
      response.cookie('partner_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      });

      return {
        success: true,
        message: result.message,
        partner: {
          id: result.partner.id,
          company_name: result.partner.company_name,
          partner_username: result.partner.partner_username,
          contact_email: result.partner.contact_email
        },
        token,
        requiresPasswordChange: result.requiresPasswordChange
      };
    } catch (error) {
      return {
        success: false,
        message: 'Login failed. Please try again.'
      };
    }
  }

  /**
   * Partner logout
   * POST /partners/logout
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie('partner_token');
    return {
      success: true,
      message: 'Logged out successfully'
    };
  }

  /**
   * Get partner dashboard data
   * GET /partners/dashboard
   */
  @Get('dashboard')
  async getDashboard(@Req() request: Request) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) {
        return {
          success: false,
          message: 'Authentication required'
        };
      }

      const payload = this.jwtService.verify(token);
      const dashboardData = await this.partnersService.getDashboardData(payload.sub);

      return {
        success: true,
        data: dashboardData
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to fetch dashboard data'
      };
    }
  }

  /**
   * Get partner's riders
   * GET /partners/riders
   */
  @Get('riders')
  async getRiders(@Req() request: Request) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) {
        return {
          success: false,
          message: 'Authentication required'
        };
      }

      const payload = this.jwtService.verify(token);
      const riders = await this.partnersService.getPartnerRiders(payload.sub);

      return {
        success: true,
        data: riders
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to fetch riders'
      };
    }
  }

  /**
   * Update partner profile
   * PATCH /partners/profile
   */
  @Patch('profile')
  async updateProfile(
    @Req() request: Request,
    @Body() updateData: any
  ) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) {
        return {
          success: false,
          message: 'Authentication required'
        };
      }

      const payload = this.jwtService.verify(token);
      const updatedPartner = await this.partnersService.updatePartnerProfile(
        payload.sub, 
        updateData
      );

      return {
        success: true,
        message: 'Profile updated successfully',
        partner: updatedPartner
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update profile'
      };
    }
  }

  /**
   * Request password reset
   * POST /partners/reset-password
   */
  @Post('reset-password')
  async requestPasswordReset(
    @Body(ValidationPipe) resetDto: PartnerResetPasswordDto
  ) {
    try {
      const result = await this.partnersService.requestPasswordReset(resetDto.username || '');
      
      return {
        success: result.success,
        message: result.message
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to process password reset request'
      };
    }
  }

  /**
   * Reset password with token
   * POST /partners/reset-password/confirm
   */
  @Post('reset-password/confirm')
  async confirmPasswordReset(
    @Body(ValidationPipe) confirmDto: PartnerResetPasswordDto
  ) {
    try {
      const result = await this.partnersService.confirmPasswordReset(
        confirmDto.token || '', 
        confirmDto.newPassword || ''
      );
      
      return {
        success: result.success,
        message: result.message
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to reset password'
      };
    }
  }

  /**
   * Change password (authenticated partner)
   * POST /partners/change-password
   */
  @Post('change-password')
  async changePassword(
    @Req() request: Request,
    @Body(ValidationPipe) changeDto: PartnerChangePasswordDto
  ) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) {
        return {
          success: false,
          message: 'Authentication required'
        };
      }

      const payload = this.jwtService.verify(token);
      const result = await this.partnersService.changePassword(
        payload.sub,
        changeDto.currentPassword,
        changeDto.newPassword
      );
      
      return {
        success: result.success,
        message: result.message
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to change password'
      };
    }
  }

  /**
   * Get partner analytics
   * GET /partners/analytics
   */
  @Get('analytics')
  async getAnalytics(@Req() request: Request) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) {
        return {
          success: false,
          message: 'Authentication required'
        };
      }

      const payload = this.jwtService.verify(token);
      const analytics = await this.partnersService.getPartnerAnalytics(payload.sub);

      return {
        success: true,
        data: analytics
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to fetch analytics'
      };
    }
  }

  /**
   * Helper method to extract token from request
   */
  private extractTokenFromRequest(request: Request): string | null {
    // Try to get token from cookie first
    const token = request.cookies?.partner_token;
    if (token) {
      return token;
    }

    // Fallback to Authorization header
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return null;
  }
}
