import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuctionsService } from '../auctions.service';

/**
 * Guard to ensure only auction owners can modify their auctions
 * Used for update/delete operations
 */
@Injectable()
export class AuctionOwnerGuard implements CanActivate {
  constructor(private auctionsService: AuctionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    // Support both :id and :auctionId parameter names
    const auctionId = request.params.auctionId || request.params.id;

    if (!user || !auctionId) {
      throw new ForbiddenException('Access denied');
    }

    try {
      const auction = await this.auctionsService.findById(auctionId);

      if (!auction) {
        throw new ForbiddenException('Auction not found');
      }

      if (auction.seller_id !== user.sub) {
        throw new ForbiddenException('You can only modify your own auctions');
      }

      return true;
    } catch (error) {
      throw new ForbiddenException('Access denied');
    }
  }
}