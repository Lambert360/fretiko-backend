import { 
  Controller, 
  Post, 
  Get, 
  Patch,
  Delete,
  Param,
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
import { PartnersWalletService } from './partners-wallet.service';
import { 
  PartnerLoginDto, 
  PartnerResetPasswordDto,
  PartnerChangePasswordDto 
} from './dto/partner-auth.dto';

@Controller('partners')
export class PartnersController {
  constructor(
    private readonly partnersService: PartnersService,
    private readonly walletService: PartnersWalletService,
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
   * Add a rider to the partner's company
   * POST /partners/riders
   */
  @Post('riders')
  async addRider(@Req() request: Request, @Body() riderData: any) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) {
        return { success: false, message: 'Authentication required' };
      }
      const payload = this.jwtService.verify(token);
      const result = await this.partnersService.addRider(payload.sub, riderData);
      return result;
    } catch (error) {
      return { success: false, message: 'Failed to add rider' };
    }
  }

  /**
   * Update partner pricing config
   * PATCH /partners/pricing
   */
  @Patch('pricing')
  async updatePricing(
    @Req() request: Request,
    @Body() body: { pricing_config: Record<string, { base_price: number; per_km_rate: number }> }
  ) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.partnersService.updatePricingConfig(payload.sub, body.pricing_config);
    } catch (error) {
      return { success: false, message: 'Failed to update pricing' };
    }
  }

  /**
   * Update rider status (suspend / terminate / reactivate)
   * PATCH /partners/riders/:riderId/status
   */
  @Patch('riders/:riderId/status')
  async updateRiderStatus(
    @Req() request: Request,
    @Param('riderId') riderId: string,
    @Body() body: { action: 'suspend' | 'terminate' | 'reactivate' }
  ) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.partnersService.updateRiderStatus(payload.sub, riderId, body.action);
    } catch (error) {
      return { success: false, message: 'Failed to update rider status' };
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

  // ── Interstate/International delivery endpoints ────────────────────────────

  /** GET /partners/interstate-config */
  @Get('interstate-config')
  async getInterstateConfig(@Req() request: Request) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      const config = await this.partnersService.getInterstateConfig(payload.sub);
      return { success: true, data: config };
    } catch (error) {
      return { success: false, message: 'Failed to fetch interstate configuration' };
    }
  }

  /** PATCH /partners/interstate-config */
  @Patch('interstate-config')
  async updateInterstateConfig(
    @Req() request: Request,
    @Body() body: {
      enabled?: boolean;
      basePrice?: number;
      perKmRate?: number;
      internationalBasePrice?: number;
      internationalPerKmRate?: number;
      estimatedDeliveryDaysMin?: number;
      estimatedDeliveryDaysMax?: number;
      internationalEnabled?: boolean;
    },
  ) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.partnersService.updateInterstateConfig(payload.sub, body);
    } catch (error) {
      return { success: false, message: 'Failed to update interstate configuration' };
    }
  }

  /** GET /partners/interstate-orders */
  @Get('interstate-orders')
  async getInterstateOrders(@Req() request: Request) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      const orders = await this.partnersService.getInterstateOrders(payload.sub);
      return { success: true, data: orders };
    } catch (error) {
      return { success: false, message: 'Failed to fetch interstate orders' };
    }
  }

  /** POST /partners/interstate-orders/:orderId/accept */
  @Post('interstate-orders/:orderId/accept')
  async acceptInterstateOrder(@Req() request: Request, @Param('orderId') orderId: string) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.partnersService.acceptInterstateOrder(payload.sub, orderId);
    } catch (error) {
      return { success: false, message: 'Failed to accept order' };
    }
  }

  /** POST /partners/interstate-orders/:orderId/reject */
  @Post('interstate-orders/:orderId/reject')
  async rejectInterstateOrder(
    @Req() request: Request,
    @Param('orderId') orderId: string,
    @Body() body: { reason?: string },
  ) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.partnersService.rejectInterstateOrder(payload.sub, orderId, body?.reason);
    } catch (error) {
      return { success: false, message: 'Failed to reject order' };
    }
  }

  /** PATCH /partners/interstate-orders/:orderId/status */
  @Patch('interstate-orders/:orderId/status')
  async updateInterstateOrderStatus(
    @Req() request: Request,
    @Param('orderId') orderId: string,
    @Body() body: { status: 'in_transit' | 'delivered' },
  ) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.partnersService.updateInterstateOrderStatus(payload.sub, orderId, body.status);
    } catch (error) {
      return { success: false, message: 'Failed to update order status' };
    }
  }

  // ── Wallet endpoints ──────────────────────────────────────────────────────

  /** GET /partners/wallet */
  @Get('wallet')
  async getWallet(@Req() request: Request) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      const result = await this.walletService.getWallet(payload.sub);
      return { success: true, data: result };
    } catch {
      return { success: false, message: 'Failed to fetch wallet' };
    }
  }

  /** GET /partners/wallet/banks/:country — fetch bank list for a country */
  @Get('wallet/banks/:country')
  async getBanks(@Param('country') country: string) {
    try {
      const banks = await this.walletService.getBanks(country);
      return { status: 'success', data: banks, message: `Retrieved ${banks.length} banks for ${country.toUpperCase()}` };
    } catch (error: any) {
      return { status: 'error', data: [], message: error.message || 'Failed to fetch banks' };
    }
  }

  /** POST /partners/wallet/bank-accounts/preview — verify account via Flutterwave */
  @Post('wallet/bank-accounts/preview')
  async previewBankAccount(@Body() body: { accountNumber: string; bankCode: string }) {
    try {
      const preview = await this.walletService.previewBankAccount(body.accountNumber, body.bankCode);
      return { status: 'success', data: preview, message: 'Account verified with bank' };
    } catch (error: any) {
      return { status: 'error', message: error.message || 'Could not verify account' };
    }
  }

  /** GET /partners/wallet/bank-accounts */
  @Get('wallet/bank-accounts')
  async getBankAccounts(@Req() request: Request) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      const accounts = await this.walletService.getBankAccounts(payload.sub);
      return { success: true, data: accounts };
    } catch {
      return { success: false, message: 'Failed to fetch bank accounts' };
    }
  }

  /** POST /partners/wallet/bank-accounts */
  @Post('wallet/bank-accounts')
  async addBankAccount(@Req() request: Request, @Body() body: any) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      const account = await this.walletService.addBankAccount(payload.sub, body);
      return { success: true, data: account, message: 'Bank account added.' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to add bank account' };
    }
  }

  /** PATCH /partners/wallet/bank-accounts/:id/default */
  @Patch('wallet/bank-accounts/:id/default')
  async setDefaultBankAccount(@Req() request: Request, @Param('id') id: string) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.walletService.setDefaultBankAccount(payload.sub, id);
    } catch {
      return { success: false, message: 'Failed to update bank account' };
    }
  }

  /** DELETE /partners/wallet/bank-accounts/:id */
  @Delete('wallet/bank-accounts/:id')
  async deleteBankAccount(@Req() request: Request, @Param('id') id: string) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.walletService.deleteBankAccount(payload.sub, id);
    } catch {
      return { success: false, message: 'Failed to remove bank account' };
    }
  }

  /** POST /partners/wallet/withdraw */
  @Post('wallet/withdraw')
  async requestWithdrawal(@Req() request: Request, @Body() body: { amount: number; bankAccountId: string }) {
    try {
      const token = this.extractTokenFromRequest(request);
      if (!token) return { success: false, message: 'Authentication required' };
      const payload = this.jwtService.verify(token);
      return await this.walletService.requestWithdrawal(payload.sub, body);
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to submit withdrawal' };
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
