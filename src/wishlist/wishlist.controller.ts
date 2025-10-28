import {
  Controller,
  Get,
  Post,
  Delete,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WishlistService } from './wishlist.service';

@Controller('wishlist')
@UseGuards(JwtAuthGuard)
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  async getWishlistItems(@Request() req) {
    console.log('💖 Fetching wishlist items for user:', req.user.sub);
    return this.wishlistService.getWishlistItems(req.user.sub, req.supabaseToken);
  }

  @Get('count')
  async getWishlistCount(@Request() req) {
    console.log('💖 Fetching wishlist count for user:', req.user.sub);
    return this.wishlistService.getWishlistCount(req.user.sub, req.supabaseToken);
  }

  @Post()
  async addToWishlist(@Request() req, @Body() wishlistData: { 
    productId: string; 
    productName: string; 
    productImage: string; 
    price: number 
  }) {
    console.log('💖 Adding to wishlist for user:', req.user.sub, wishlistData);
    return this.wishlistService.addToWishlist(req.user.sub, wishlistData, req.supabaseToken);
  }

  @Delete(':productId')
  async removeFromWishlist(@Request() req, @Param('productId') productId: string) {
    console.log('💖 Removing from wishlist:', productId);
    return this.wishlistService.removeFromWishlist(req.user.sub, productId, req.supabaseToken);
  }

  @Delete()
  async clearWishlist(@Request() req) {
    console.log('💖 Clearing wishlist for user:', req.user.sub);
    return this.wishlistService.clearWishlist(req.user.sub, req.supabaseToken);
  }

  @Get('check/:productId')
  async checkIsInWishlist(@Request() req, @Param('productId') productId: string) {
    console.log('💖 Checking if product is in wishlist:', productId);
    return this.wishlistService.checkIsInWishlist(req.user.sub, productId, req.supabaseToken);
  }

  // ============================================
  // WISHLIST SHARING ENDPOINTS
  // ============================================

  @Post('share')
  async shareWishlist(@Request() req, @Body() shareData: {
    friendId: string;
    shareType?: 'view_only' | 'view_and_add';
    shareMessage?: string;
    selectedItemIds?: string[];
  }) {
    console.log('💖 Sharing wishlist with friend:', {
      ownerId: req.user.sub,
      friendId: shareData.friendId,
      shareType: shareData.shareType,
      selectedItemsCount: shareData.selectedItemIds?.length
    });

    return this.wishlistService.shareWishlistWithFriend(
      req.user.sub,  // ownerId
      shareData.friendId,  // friendId
      shareData.shareType || 'view_and_add',  // shareType with default
      shareData.shareMessage,  // shareMessage
      shareData.selectedItemIds,  // selectedItemIds
      req.supabaseToken  // userToken
    );
  }

  @Get('shared')
  async getSharedWishlists(@Request() req) {
    console.log('💖 Getting wishlists shared with user:', req.user.sub);
    return this.wishlistService.getSharedWishlists(req.user.sub, req.supabaseToken);
  }

  @Get('shared/:ownerId')
  async getSharedWishlistItems(@Request() req, @Param('ownerId') ownerId: string) {
    console.log('💖 Getting shared wishlist items from owner:', ownerId, 'for user:', req.user.sub);
    return this.wishlistService.getSharedWishlistItems(req.user.sub, ownerId, req.supabaseToken);
  }

  @Post('shared/:ownerId/add')
  async addToSharedWishlist(
    @Request() req, 
    @Param('ownerId') ownerId: string,
    @Body() itemData: {
      productId: string;
      productName: string;
      productImage: string;
      price: number;
      collaborationNote?: string;
    }
  ) {
    console.log('💖 Adding item to shared wishlist:', {
      collaboratorId: req.user.sub,
      ownerId,
      productId: itemData.productId
    });
    
    return this.wishlistService.addToSharedWishlist(
      req.user.sub,
      ownerId,
      itemData,
      req.supabaseToken
    );
  }

  @Get('collaborative')
  async getWishlistWithCollaborators(@Request() req) {
    console.log('💖 Getting collaborative wishlist for user:', req.user.sub);
    return this.wishlistService.getWishlistWithCollaborators(req.user.sub, undefined, req.supabaseToken);
  }

  @Get('collaborative/:ownerId')
  async getWishlistWithCollaboratorsForOwner(@Request() req, @Param('ownerId') ownerId: string) {
    console.log('💖 Getting collaborative wishlist for owner:', ownerId);
    return this.wishlistService.getWishlistWithCollaborators(req.user.sub, ownerId, req.supabaseToken);
  }

  @Post('add-to-friend')
  async addToFriendWishlist(@Request() req, @Body() data: {
    friendUserId: string;
    productId: string;
    productName: string;
    productImage: string;
    price: number;
    note?: string;
  }) {
    console.log('💖 Adding item to friend\'s wishlist:', data);
    return this.wishlistService.addToFriendWishlist(
      data.friendUserId,
      {
        productId: data.productId,
        productName: data.productName,
        productImage: data.productImage,
        price: data.price
      },
      req.user.sub,
      data.note,
      req.supabaseToken
    );
  }

  @Put('stop-sharing/:friendId')
  async stopSharingWishlist(@Request() req, @Param('friendId') friendId: string) {
    console.log('💖 Stopping wishlist sharing with friend:', friendId);
    return this.wishlistService.stopSharingWishlist(req.user.sub, friendId, req.supabaseToken);
  }

  @Get('shareable-friends')
  async getShareableFriends(@Request() req, @Query('search') search?: string, @Query('limit') limit?: string) {
    console.log('💖 Getting shareable friends for user:', req.user.sub, 'search:', search);
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.wishlistService.getShareableFriends(req.user.sub, req.supabaseToken, search, limitNum);
  }

  // ============================================
  // GIFT FUNCTIONALITY ENDPOINTS
  // ============================================

  @Post('gift')
  async createGiftOrder(@Request() req, @Body() giftData: {
    giftRecipientId: string;
    orderId: string;
    wishlistItemId: string;
    giftMessage?: string;
    isSurprise?: boolean;
  }) {
    console.log('💖 Creating gift order:', giftData);
    return this.wishlistService.createGiftOrder(
      req.user.sub,
      giftData.giftRecipientId,
      giftData.orderId,
      giftData.wishlistItemId,
      giftData.giftMessage,
      giftData.isSurprise,
      req.supabaseToken
    );
  }

  @Get('gifts/received')
  async getReceivedGifts(@Request() req) {
    console.log('💖 Getting received gifts for user:', req.user.sub);
    return this.wishlistService.getReceivedGifts(req.user.sub, req.supabaseToken);
  }

  @Get('gifts/given')
  async getGivenGifts(@Request() req) {
    console.log('💖 Getting given gifts for user:', req.user.sub);
    return this.wishlistService.getGivenGifts(req.user.sub, req.supabaseToken);
  }

  @Get('can-gift/:wishlistItemId')
  async canPurchaseAsGift(@Request() req, @Param('wishlistItemId') wishlistItemId: string) {
    console.log('💖 Checking if item can be purchased as gift:', wishlistItemId);
    return this.wishlistService.canPurchaseAsGift(req.user.sub, wishlistItemId, req.supabaseToken);
  }

  @Post('validate-gift-purchase')
  async validateGiftPurchase(
    @Request() req,
    @Body() body: {
      items: Array<{ wishlistItemId: string; quantity?: number }>;
    }
  ) {
    console.log('🎁 Validating gift purchase for user:', req.user.sub, 'items:', body.items.length);
    return this.wishlistService.validateGiftPurchase(req.user.sub, body.items, req.supabaseToken);
  }
}