import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { MfaService } from './mfa.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { MfaSessionDto, MfaVerifyDto, MfaUnenrollDto } from './dto/mfa.dto';

/**
 * MFA management endpoints for already-authenticated end users (Settings > Security).
 * All routes require BOTH:
 *  - a valid app JWT (JwtAuthGuard), proving the caller is logged in, and
 *  - a live Supabase access/refresh token pair (obtained at sign-in), since
 *    Supabase's MFA APIs operate on a GoTrue session, not our custom JWT.
 */
@Controller('auth/mfa')
@UseGuards(JwtAuthGuard)
export class MfaController {
  constructor(private readonly mfaService: MfaService) {}

  @Post('enroll')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60 } })
  async enroll(@Body() dto: MfaSessionDto) {
    const result = await this.mfaService.enroll(dto.supabaseAccessToken, dto.supabaseRefreshToken);
    return { success: true, ...result };
  }

  @Post('verify')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async verify(@Body() dto: MfaVerifyDto) {
    const result = await this.mfaService.verifyEnrollment(
      dto.supabaseAccessToken,
      dto.supabaseRefreshToken,
      dto.factorId,
      dto.code,
    );
    return result;
  }

  @Post('factors')
  async factors(@Body() dto: MfaSessionDto) {
    return this.mfaService.listFactors(dto.supabaseAccessToken, dto.supabaseRefreshToken);
  }

  @Post('unenroll')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60 } })
  async unenroll(@Body() dto: MfaUnenrollDto) {
    return this.mfaService.unenroll(dto.supabaseAccessToken, dto.supabaseRefreshToken, dto.factorId);
  }
}
