import { Controller, Get, Post, Param, Body, UseGuards, Req } from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('escrow')
@UseGuards(JwtAuthGuard)
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  @Get('pending/vendor')
  async getPendingVendorEscrows(@Req() req) {
    const userId = req.user.sub;
    return this.escrowService.getEscrowsByUser(userId, 'vendor');
  }

  @Get('pending/rider')
  async getPendingRiderEscrows(@Req() req) {
    const userId = req.user.sub;
    return this.escrowService.getEscrowsByUser(userId, 'rider');
  }

  @Post(':id/release')
  async releaseEscrow(
    @Req() req,
    @Param('id') escrowId: string,
    @Body() body: { reason: string },
  ) {
    // ✅ FIX Bug 16: Add authorization check
    const userId = req.user.sub;
    await this.escrowService.releaseEscrow(escrowId, body.reason, userId);
    return { success: true, message: 'Escrow released successfully' };
  }

  @Post(':id/refund')
  async refundEscrow(
    @Req() req,
    @Param('id') escrowId: string,
    @Body() body: { reason: string },
  ) {
    // ✅ FIX Bug 17: Add authorization check
    const userId = req.user.sub;
    await this.escrowService.refundEscrow(escrowId, body.reason, userId);
    return { success: true, message: 'Escrow refunded successfully' };
  }

  @Post(':id/dispute')
  async disputeEscrow(
    @Req() req,
    @Param('id') escrowId: string,
    @Body() body: { reason: string },
  ) {
    const userId = req.user.sub;
    await this.escrowService.disputeEscrow(escrowId, body.reason, userId);
    return { success: true, message: 'Escrow marked as disputed' };
  }
}

