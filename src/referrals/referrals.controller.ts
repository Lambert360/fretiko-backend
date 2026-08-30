import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ReferralsService, ReferralData } from './referrals.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('referrals')
@UseGuards(JwtAuthGuard)
export class ReferralsController {
  constructor(
    private readonly referralsService: ReferralsService,
  ) {}

  /**
   * Get current user's referral data (code, URL, stats)
   */
  @Get('me')
  async getMyReferralData(@Request() req) {
    const userId = req.user.id;
    return this.referralsService.getUserReferralData(userId);
  }

  /**
   * Validate a referral code (public endpoint for signup flow)
   */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  async validateReferralCode(@Body() body: { code: string }) {
    return this.referralsService.validateReferralCode(body.code);
  }

  /**
   * Track a referral click (public endpoint)
   */
  @Post('track-click')
  @HttpCode(HttpStatus.OK)
  async trackReferralClick(@Body() body: { code: string }) {
    return this.referralsService.trackReferralClick(body.code);
  }

  /**
   * Complete referral when user signs up (called during signup)
   */
  @Post('complete')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async completeReferral(
    @Request() req,
    @Body() body: { referralCode: string },
  ) {
    const userId = req.user.id;
    return this.referralsService.completeReferral(userId, body.referralCode);
  }

  /**
   * Get referral history for current user
   */
  @Get('history')
  async getReferralHistory(@Request() req) {
    const userId = req.user.id;
    return this.referralsService.getReferralHistory(userId);
  }
}
