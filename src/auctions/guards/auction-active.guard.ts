import { Injectable, CanActivate, ExecutionContext, BadRequestException } from '@nestjs/common';
import { AuctionsService } from '../auctions.service';

/**
 * Guard to ensure auction is active and accepting bids
 * Used for bidding operations
 */
@Injectable()
export class AuctionActiveGuard implements CanActivate {
  constructor(private auctionsService: AuctionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    // Support multiple parameter names: body.auction_id, params.auctionId, params.id
    const auctionId = request.body.auction_id || request.params.auctionId || request.params.id;

    if (!auctionId) {
      throw new BadRequestException('Auction ID is required');
    }

    try {
      const auction = await this.auctionsService.findById(auctionId);

      if (!auction) {
        throw new BadRequestException('Auction not found');
      }

      // Check if auction is active
      if (auction.status !== 'active') {
        throw new BadRequestException(`Auction is ${auction.status} and not accepting bids`);
      }

      // Check if auction time is valid
      const now = new Date();
      if (now < auction.start_time) {
        throw new BadRequestException('Auction has not started yet');
      }

      if (now > auction.end_time) {
        throw new BadRequestException('Auction has ended');
      }

      // Store auction in request for use in controller
      request.auction = auction;

      return true;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Unable to verify auction status');
    }
  }
}