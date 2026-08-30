import { Injectable, HttpException, HttpStatus, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { EscrowService } from '../escrow/escrow.service';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RewardsService } from '../rewards/rewards.service';
import { InvoiceService } from '../chat/invoice.service';
import { WishlistService } from '../wishlist/wishlist.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletTransactionType } from '../wallet/constants/transaction-types';
import { AuctionsService } from '../auctions/auctions.service';
import { GiftCardService } from '../gift-cards/gift-cards.service';

@Injectable()
export class CheckoutService {
  private supabase;
  private readonly PLATFORM_COMMISSION_RATE: number;

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => RewardsService))
    private rewardsService: RewardsService,
    @Inject(forwardRef(() => InvoiceService))
    private invoiceService: InvoiceService,
    private wishlistService: WishlistService,
    private walletService: WalletService,
    @Inject(forwardRef(() => AuctionsService))
    private auctionsService: AuctionsService,
    @Inject(forwardRef(() => GiftCardService))
    private giftCardService: GiftCardService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.PLATFORM_COMMISSION_RATE = parseFloat(
      this.configService.get<string>('PLATFORM_COMMISSION_RATE', '0.1')
    );
  }

  /**
   * Generate a 3-digit PIN for order handoff verification
   */
  private generatePIN(): string {
    return Math.floor(100 + Math.random() * 900).toString();
  }

  /**
   * Determine whether a seller location is out-of-state or out-of-country
   * relative to the buyer's delivery address.
   */
  private detectInterstate(
    sellerLocation: { state?: string; country?: string; city?: string } | null | undefined,
    buyerState?: string,
    buyerCountry?: string,
  ): { isOutOfState: boolean; isOutOfCountry: boolean } {
    if (!sellerLocation || (!sellerLocation.state && !sellerLocation.country)) {
      return { isOutOfState: false, isOutOfCountry: false };
    }
    const sellerCountry = (sellerLocation.country || '').trim().toLowerCase();
    const sellerState = (sellerLocation.state || '').trim().toLowerCase();
    const bCountry = (buyerCountry || '').trim().toLowerCase();
    const bState = (buyerState || '').trim().toLowerCase();

    const isOutOfCountry =
      sellerCountry !== '' && bCountry !== '' && sellerCountry !== bCountry;
    const isOutOfState =
      !isOutOfCountry &&
      sellerState !== '' &&
      bState !== '' &&
      sellerState !== bState;

    return { isOutOfState, isOutOfCountry };
  }

  /**
   * Parse a "State, Country" (or "City, State, Country") string into a location object.
   */
  private parseItemLocation(
    location?: string | null,
  ): { state?: string; country?: string; city?: string } | null {
    if (!location || typeof location !== 'string') return null;
    const parts = location
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length >= 2) {
      return { state: parts[0], country: parts[parts.length - 1] };
    }
    return { state: parts[0] };
  }

  // Get checkout summary from user's cart
  async getCheckoutSummary(userId: string, userToken?: string, selectedItemIds?: string[]) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    console.log('🛒 Backend getCheckoutSummary - selectedItemIds:', selectedItemIds);

    // Get cart items with BOTH product AND service details
    const { data: cartItems, error: cartError } = await client
      .from('cart_items')
      .select(`
        *,
        products!cart_items_product_id_fkey (
          id,
          name,
          price,
          user_id,
          category_id,
          quantity,
          location
        ),
        services!cart_items_service_id_fkey (
          id,
          name,
          base_price,
          user_id,
          location,
          service_categories (
            name
          )
        )
      `)
      .eq('user_id', userId);

    if (cartError) {
      console.error('Cart fetch error:', cartError);
      throw new HttpException('Failed to fetch cart items', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    if (!cartItems || cartItems.length === 0) {
      throw new HttpException('Cart is empty', HttpStatus.BAD_REQUEST);
    }

    console.log(`📋 Backend found ${cartItems.length} cart items`);

    // Calculate summary - handle BOTH products AND services
    let items = cartItems.map(item => {
      const isService = !!item.service_id;
      
      if (isService) {
        // Service item
        return {
          id: item.services.id,
          name: item.services.name,
          price: item.price_at_add,
          quantity: item.quantity,
          sellerId: item.services.user_id,
          requiresEscrow: false,
          itemType: 'service',
          serviceDate: item.scheduled_date,
          serviceTime: item.scheduled_time,
          serviceNotes: item.service_notes,
          category: item.services?.service_categories?.name || 'Services',
          itemLocation: item.services?.location || undefined,
        };
      } else {
        // Product item
        return {
          id: item.products.id,
          name: item.products.name,
          price: item.products.price,
          quantity: item.quantity,
          sellerId: item.products.user_id,
          requiresEscrow: false,
          itemType: 'product',
          itemLocation: item.products?.location || undefined,
        };
      }
    });

    // Filter items if selectedItemIds is provided (selective checkout)
    if (selectedItemIds && selectedItemIds.length > 0) {
      console.log('🔍 Backend filtering to selected items:', selectedItemIds);
      const beforeCount = items.length;
      items = items.filter(item => selectedItemIds.includes(item.id));
      console.log(`✅ Backend filtered: ${items.length} of ${beforeCount} items selected`);
      
      if (items.length === 0) {
        throw new HttpException('No selected items found in cart', HttpStatus.BAD_REQUEST);
      }
    }

    // Fetch seller locations so the mobile can pass the vendor's state/country
    // as pickupLocation when requesting nearby riders (pickup location filtering)
    const sellerIds = [...new Set(items.map((i: any) => i.sellerId).filter(Boolean))];
    let sellerLocationMap: Record<string, { state?: string; country?: string; city?: string }> = {};
    if (sellerIds.length > 0) {
      const { data: sellerProfiles } = await this.supabase
        .from('user_profiles')
        .select('id, location')
        .in('id', sellerIds);
      sellerProfiles?.forEach((profile: any) => {
        sellerLocationMap[profile.id] = {
          state: profile.location?.state || undefined,
          country: profile.location?.country || undefined,
          city: profile.location?.city || undefined,
        };
      });
    }

    const itemsWithLocation = items.map((item: any) => {
      const parsedItemLocation = this.parseItemLocation(item.itemLocation);
      return {
        ...item,
        sellerLocation: parsedItemLocation || sellerLocationMap[item.sellerId] || null,
      };
    });

    // Fetch buyer's default delivery address for interstate detection
    const { data: buyerDefaultAddress } = await this.supabase
      .from('delivery_addresses')
      .select('state, country')
      .eq('user_id', userId)
      .eq('is_default', true)
      .single();
    const buyerState = buyerDefaultAddress?.state || undefined;
    const buyerCountry = buyerDefaultAddress?.country || undefined;

    // Add interstate/international flags to each item
    const itemsWithInterstate = itemsWithLocation.map((item: any) => {
      const { isOutOfState, isOutOfCountry } = this.detectInterstate(
        item.sellerLocation, buyerState, buyerCountry,
      );
      return { ...item, isOutOfState, isOutOfCountry };
    });

    const hasOutOfStateItems = itemsWithInterstate.some((i: any) => i.isOutOfState || i.isOutOfCountry);
    const hasOutOfCountryItems = itemsWithInterstate.some((i: any) => i.isOutOfCountry);

    const subtotal = itemsWithInterstate.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);
    const shipping = this.calculateShipping(subtotal, itemsWithInterstate);
    const tax = this.calculateTax(subtotal);
    const escrowFee = this.calculateEscrowFee(subtotal + shipping + tax);
    const total = subtotal + shipping + tax + escrowFee;

    return {
      items: itemsWithInterstate,
      subtotal,
      shipping,
      tax,
      escrowFee,
      total,
      hasOutOfStateItems,
      hasOutOfCountryItems,
    };
  }

  // Get wishlist checkout summary
  async getWishlistCheckoutSummary(userId: string, wishlistItemIds: string[], userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    if (!wishlistItemIds || wishlistItemIds.length === 0) {
      throw new HttpException('Wishlist item IDs are required', HttpStatus.BAD_REQUEST);
    }

    // Fetch wishlist items with product details
    const { data: wishlistItems, error: wishlistError } = await client
      .from('wishlist')
      .select(`
        id,
        product_id,
        products (
          id,
          name,
          price,
          user_id,
          status,
          quantity,
          location
        )
      `)
      .eq('user_id', userId)
      .in('id', wishlistItemIds);

    if (wishlistError) {
      console.error('Error fetching wishlist items:', wishlistError);
      throw new HttpException('Failed to fetch wishlist items', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    if (!wishlistItems || wishlistItems.length === 0) {
      throw new HttpException('No wishlist items found', HttpStatus.NOT_FOUND);
    }

    // Filter out items with deleted or inactive products
    const validItems = wishlistItems.filter(item => 
      item.products && 
      item.products.status === 'active' &&
      item.products.quantity > 0
    );

    if (validItems.length === 0) {
      throw new HttpException('No valid products found in wishlist items', HttpStatus.BAD_REQUEST);
    }

    // Build items array for checkout summary
    const items = validItems.map(item => ({
      id: item.products.id,
      name: item.products.name,
      price: item.products.price,
      quantity: 1, // Wishlist items are always quantity 1
      sellerId: item.products.user_id,
      requiresEscrow: true, // Wishlist purchases always use escrow
      itemLocation: item.products?.location || undefined,
    }));

    // Attach seller location so mobile can pass vendor state/country to rider filter
    const wishlistSellerIds = [...new Set(items.map((i: any) => i.sellerId).filter(Boolean))];
    let wishlistSellerLocMap: Record<string, any> = {};
    if (wishlistSellerIds.length > 0) {
      const { data: wishlistSellerProfiles } = await this.supabase
        .from('user_profiles').select('id, location').in('id', wishlistSellerIds);
      wishlistSellerProfiles?.forEach((p: any) => {
        wishlistSellerLocMap[p.id] = { state: p.location?.state, country: p.location?.country, city: p.location?.city };
      });
    }
    const wishlistItemsWithLoc = items.map((item: any) => {
      const parsedItemLocation = this.parseItemLocation(item.itemLocation);
      return {
        ...item,
        sellerLocation: parsedItemLocation || wishlistSellerLocMap[item.sellerId] || null,
      };
    });

    // Fetch buyer's default delivery address for interstate detection
    const { data: wishlistBuyerAddr } = await this.supabase
      .from('delivery_addresses')
      .select('state, country')
      .eq('user_id', userId)
      .eq('is_default', true)
      .single();
    const wBuyerState = wishlistBuyerAddr?.state || undefined;
    const wBuyerCountry = wishlistBuyerAddr?.country || undefined;

    const wishlistItemsWithInterstate = wishlistItemsWithLoc.map((item: any) => {
      const { isOutOfState, isOutOfCountry } = this.detectInterstate(
        item.sellerLocation, wBuyerState, wBuyerCountry,
      );
      return { ...item, isOutOfState, isOutOfCountry };
    });

    const hasOutOfStateItems = wishlistItemsWithInterstate.some((i: any) => i.isOutOfState || i.isOutOfCountry);
    const hasOutOfCountryItems = wishlistItemsWithInterstate.some((i: any) => i.isOutOfCountry);

    const subtotal = wishlistItemsWithInterstate.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);
    const shipping = this.calculateShipping(subtotal, wishlistItemsWithInterstate);
    const tax = this.calculateTax(subtotal);
    const escrowFee = this.calculateEscrowFee(subtotal + shipping + tax);
    const total = subtotal + shipping + tax + escrowFee;

    return {
      items: wishlistItemsWithInterstate,
      subtotal,
      shipping,
      tax,
      escrowFee,
      total,
      hasOutOfStateItems,
      hasOutOfCountryItems,
    };
  }

  // Get direct checkout summary for single product purchase
  async getDirectCheckoutSummary(userId: string, productId: string, quantity: number, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get product details
    const { data: product, error: productError } = await client
      .from('products')
      .select('id, name, price, user_id, category_id, quantity, location')
      .eq('id', productId)
      .single();

    if (productError || !product) {
      throw new HttpException('Product not found', HttpStatus.NOT_FOUND);
    }

    // Check stock availability
    if (product.quantity < quantity) {
      throw new HttpException('Insufficient stock', HttpStatus.BAD_REQUEST);
    }

    const items = [{
      id: product.id,
      name: product.name,
      price: product.price,
      quantity,
      sellerId: product.user_id,
      requiresEscrow: false,
    }];

    // Attach seller location: prefer the product's own location, fall back to seller profile
    const parsedProductLocation = this.parseItemLocation(product.location);
    let directSellerLoc = parsedProductLocation;
    if (!directSellerLoc) {
      const { data: directSellerProfile } = await this.supabase
        .from('user_profiles').select('id, location').eq('id', product.user_id).single();
      directSellerLoc = directSellerProfile
        ? { state: directSellerProfile.location?.state, country: directSellerProfile.location?.country, city: directSellerProfile.location?.city }
        : null;
    }
    const itemsWithLoc = items.map((item: any) => ({ ...item, sellerLocation: directSellerLoc }));

    // Fetch buyer's default delivery address for interstate detection
    const { data: directBuyerAddr } = await this.supabase
      .from('delivery_addresses')
      .select('state, country')
      .eq('user_id', userId)
      .eq('is_default', true)
      .single();
    const dBuyerState = directBuyerAddr?.state || undefined;
    const dBuyerCountry = directBuyerAddr?.country || undefined;

    const itemsWithInterstate = itemsWithLoc.map((item: any) => {
      const { isOutOfState, isOutOfCountry } = this.detectInterstate(
        item.sellerLocation, dBuyerState, dBuyerCountry,
      );
      return { ...item, isOutOfState, isOutOfCountry };
    });

    const hasOutOfStateItems = itemsWithInterstate.some((i: any) => i.isOutOfState || i.isOutOfCountry);
    const hasOutOfCountryItems = itemsWithInterstate.some((i: any) => i.isOutOfCountry);

    const subtotal = product.price * quantity;
    const shipping = this.calculateShipping(subtotal, itemsWithInterstate);
    const tax = this.calculateTax(subtotal);
    const escrowFee = this.calculateEscrowFee(subtotal + shipping + tax);
    const total = subtotal + shipping + tax + escrowFee;

    return {
      items: itemsWithInterstate,
      subtotal,
      shipping,
      tax,
      escrowFee,
      total,
      hasOutOfStateItems,
      hasOutOfCountryItems,
    };
  }

  // Get auction winner checkout summary
  async getAuctionCheckoutSummary(userId: string, auctionId: string, userToken?: string) {
    // Use service role client to read auction (bypasses RLS)
    // Authorization is validated below by checking winner_id matches userId
    const { data: auction, error: auctionError } = await this.supabase
      .from('auctions')
      .select(`
        id,
        title,
        winning_bid,
        winner_id,
        seller_id,
        status,
        auction_type,
        start_time,
        end_time,
        commission_rate,
        thumbnail_url
      `)
      .eq('id', auctionId)
      .single();

    if (auctionError || !auction) {
      console.error('Error fetching auction:', auctionError);
      throw new HttpException('Auction not found', HttpStatus.NOT_FOUND);
    }

    // ✅ CRITICAL: Verify user is the winner (authorization check)
    // For multi-item auctions, check auction_items; for single-item, check auction.winner_id
    let isWinner = false;
    
    if (auction.winner_id === userId) {
      isWinner = true;
    } else {
      // Check if user won any items in this auction (for multi-item auctions)
      const { data: wonItems } = await this.supabase
        .from('auction_items')
        .select('id')
        .eq('auction_id', auctionId)
        .eq('winner_id', userId)
        .in('bidding_status', ['ended', 'sold'])
        .limit(1);
      
      if (wonItems && wonItems.length > 0) {
        isWinner = true;
      } else {
        // Also check user_auction_wins view (most reliable source)
        const { data: win } = await this.supabase
          .from('user_auction_wins')
          .select('id')
          .eq('auction_id', auctionId)
          .eq('user_id', userId)
          .eq('status', 'pending_checkout')
          .limit(1);
        
        if (win && win.length > 0) {
          isWinner = true;
        }
      }
    }
    
    if (!isWinner) {
      throw new HttpException('You are not the winner of this auction', HttpStatus.FORBIDDEN);
    }

    // Verify auction is ended for TIMED auctions only.
    // For LIVE auctions we allow checkout while the event is still running,
    // as long as the user has already been recorded as the winner.
    if (auction.auction_type !== 'live') {
      const now = new Date();
      const endTime = new Date(auction.end_time);
      if (endTime > now) {
        throw new HttpException('Auction has not ended yet', HttpStatus.BAD_REQUEST);
      }
    }

    // Check if sale record exists and its status (use service role client)
    const { data: existingSale } = await this.supabase
      .from('auction_sales')
      .select('payment_status, payment_transaction_id')
      .eq('auction_id', auctionId)
      .single();

    // If payment is already completed, don't allow checkout
    if (existingSale?.payment_status === 'completed') {
      throw new HttpException('Auction already paid for', HttpStatus.BAD_REQUEST);
    }

    // If order already exists and is paid, don't allow duplicate checkout
    if (existingSale?.payment_transaction_id) {
      const { data: existingOrder } = await this.supabase
        .from('orders')
        .select('id, order_number, status')
        .eq('id', existingSale.payment_transaction_id)
        .single();

      if (existingOrder && existingOrder.status === 'paid') {
        throw new HttpException(
          `Order already created for this auction. Order #${existingOrder.order_number}`,
          HttpStatus.BAD_REQUEST
        );
      }
    }

    // Get winning bid - check multiple sources
    // For multi-item auctions, winning_bid is stored in auction_items
    // For single-item auctions, it's in auctions table
    let winningBid = auction.winning_bid;
    let itemTitle = auction.title;
    let itemThumbnail = auction.thumbnail_url;
    
    console.log(`🔍 Getting winning bid for auction ${auctionId}, user ${userId}`);
    console.log(`  - Auction winning_bid: ${auction.winning_bid}`);
    console.log(`  - Auction winner_id: ${auction.winner_id}`);
    
    if (!winningBid) {
      // Try to get from user_auction_wins (this is the most reliable source)
      const { data: wins, error: winsError } = await this.supabase
        .from('user_auction_wins')
        .select('winning_bid, item_id, auction_id')
        .eq('auction_id', auctionId)
        .eq('user_id', userId)
        .eq('status', 'pending_checkout');
      
      console.log(`  - Found ${wins?.length || 0} wins in user_auction_wins`);
      if (winsError) {
        console.error(`  - Error querying user_auction_wins:`, winsError);
      }
      
      if (wins && wins.length > 0) {
        const win = wins[0];
        winningBid = win.winning_bid;
        console.log(`  - Using win winning_bid: ${winningBid}`);
        
        // If there's an item_id, get item details
        if (win.item_id) {
          const { data: item } = await this.supabase
            .from('auction_items')
            .select('title, images')
            .eq('id', win.item_id)
            .single();
          
          if (item) {
            itemTitle = item.title || auction.title;
            itemThumbnail = item.images?.[0] || auction.thumbnail_url;
          }
        }
      } else {
        // For multi-item auctions, check auction_items for items won by this user
        const { data: wonItems, error: itemsError } = await this.supabase
          .from('auction_items')
          .select('id, title, winning_bid, current_bid, images')
          .eq('auction_id', auctionId)
          .eq('winner_id', userId)
          .in('bidding_status', ['ended', 'sold']);
        
        console.log(`  - Found ${wonItems?.length || 0} won items in auction_items`);
        if (itemsError) {
          console.error(`  - Error querying auction_items:`, itemsError);
        }
        
        if (wonItems && wonItems.length > 0) {
          // Use the first won item (for now - in future we might need to handle multiple items)
          const wonItem = wonItems[0];
          winningBid = wonItem.winning_bid || wonItem.current_bid;
          itemTitle = wonItem.title || auction.title;
          itemThumbnail = wonItem.images?.[0] || auction.thumbnail_url;
          console.log(`  - Using item winning_bid: ${winningBid}`);
        } else {
          // Last resort: get highest bid from auction_bids
          const { data: highestBid, error: bidError } = await this.supabase
            .from('auction_bids')
            .select('amount')
            .eq('auction_id', auctionId)
            .eq('bidder_id', userId)
            .order('amount', { ascending: false })
            .limit(1)
            .single();
          
          console.log(`  - Highest bid from auction_bids: ${highestBid?.amount || 'not found'}`);
          if (bidError && bidError.code !== 'PGRST116') {
            console.error(`  - Error querying auction_bids:`, bidError);
          }
          
          if (highestBid?.amount) {
            winningBid = highestBid.amount;
            console.log(`  - Using highest bid amount: ${winningBid}`);
          }
        }
      }
    }

    // If still no winning bid, throw error with more details
    if (!winningBid || winningBid <= 0) {
      console.error(`❌ Could not find winning bid for auction ${auctionId}, user ${userId}`);
      console.error(`  - Auction type: ${auction.auction_type}`);
      console.error(`  - Auction status: ${auction.status}`);
      console.error(`  - Auction winner_id: ${auction.winner_id}`);
      throw new HttpException(
        `Winning bid not found for this auction. Please ensure the auction has ended and you are the winner.`,
        HttpStatus.BAD_REQUEST
      );
    }
    
    console.log(`✅ Found winning bid: ${winningBid} for auction ${auctionId}`);

    // Fetch seller location for rider filtering (same pattern as other summary methods)
    const { data: auctionSellerProfile } = await this.supabase
      .from('user_profiles').select('id, location').eq('id', auction.seller_id).single();
    const auctionSellerLoc = auctionSellerProfile
      ? { state: auctionSellerProfile.location?.state, country: auctionSellerProfile.location?.country, city: auctionSellerProfile.location?.city }
      : null;

    const items = [{
      id: auction.id,
      name: itemTitle,
      price: winningBid,
      quantity: 1,
      sellerId: auction.seller_id,
      requiresEscrow: true, // Auctions always use escrow
      imageUrl: itemThumbnail,
      itemType: 'auction',
      sellerLocation: auctionSellerLoc,
    }];

    const subtotal = winningBid;
    const shipping = this.calculateShipping(subtotal, items);
    const tax = this.calculateTax(subtotal);
    // ✅ FIX: All auction orders use 10% platform commission (not the auction.commission_rate from DB)
    const AUCTION_COMMISSION_RATE = 10; // 10% for all auction orders
    const commissionFee = Math.round(subtotal * (AUCTION_COMMISSION_RATE / 100));
    const escrowFee = this.calculateEscrowFee(subtotal + shipping + tax);
    const total = subtotal + shipping + tax + escrowFee;

    return {
      items,
      subtotal,
      shipping,
      tax,
      escrowFee,
      commissionFee,
      commissionRate: AUCTION_COMMISSION_RATE, // Always 10% for auctions
      total,
      auctionId: auction.id,
      sellerId: auction.seller_id,
    };
  }

  // Get available payment methods with wallet balance
  async getPaymentMethods(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get wallet balance
    const { data: wallet } = await client
      .from('wallets')
      .select('available_balance')
      .eq('user_id', userId)
      .single();

    const walletBalance = wallet?.available_balance || 0;

    return [
      {
        id: 'wallet',
        type: 'wallet',
        name: 'Fretiko Wallet',
        description: 'Pay with your Fretiko wallet balance (₣)',
        icon: 'wallet-outline',
        balance: walletBalance,
      },
    ];
  }

  // Get user's default delivery address
  async getDefaultAddress(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data: address, error } = await client
      .from('delivery_addresses')
      .select('*')
      .eq('user_id', userId)
      .eq('is_default', true)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
      console.error('Address fetch error:', error);
      return null;
    }

    return address ? {
      id: address.id,
      fullName: address.full_name,
      phone: address.phone,
      address: address.address,
      city: address.city,
      state: address.state,
      country: address.country || undefined,
      postalCode: address.postal_code,
      isDefault: address.is_default,
    } : null;
  }

  // Save delivery address
  async saveAddress(userId: string, addressData: any, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // If this is being set as default, unset other defaults first
    if (addressData.isDefault) {
      await client
        .from('delivery_addresses')
        .update({ is_default: false })
        .eq('user_id', userId);
    }

    const addressToSave = {
      user_id: userId,
      full_name: addressData.fullName,
      phone: addressData.phone,
      address: addressData.address,
      city: addressData.city,
      state: addressData.state,
      country: addressData.country || null,
      postal_code: addressData.postalCode,
      is_default: addressData.isDefault || false,
      updated_at: new Date().toISOString(),
    };

    let result;
    if (addressData.id) {
      // Update existing address
      const { data, error } = await client
        .from('delivery_addresses')
        .update(addressToSave)
        .eq('id', addressData.id)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        console.error('Address update error:', error);
        throw new HttpException('Failed to update address', HttpStatus.INTERNAL_SERVER_ERROR);
      }
      result = data;
    } else {
      // Create new address
      addressToSave['created_at'] = new Date().toISOString();
      const { data, error } = await client
        .from('delivery_addresses')
        .insert(addressToSave)
        .select()
        .single();

      if (error) {
        console.error('Address create error:', error);
        throw new HttpException('Failed to create address', HttpStatus.INTERNAL_SERVER_ERROR);
      }
      result = data;
    }

    return {
      id: result.id,
      fullName: result.full_name,
      phone: result.phone,
      address: result.address,
      city: result.city,
      state: result.state,
      country: result.country || undefined,
      postalCode: result.postal_code,
      isDefault: result.is_default,
    };
  }

  // Get all delivery addresses
  async getAllAddresses(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('delivery_addresses')
      .select('*')
      .eq('user_id', userId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching addresses:', error);
      throw new HttpException('Failed to fetch addresses', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return data.map(addr => ({
      id: addr.id,
      fullName: addr.full_name,
      phone: addr.phone,
      address: addr.address,
      city: addr.city,
      state: addr.state,
      country: addr.country || undefined,
      postalCode: addr.postal_code,
      isDefault: addr.is_default,
      createdAt: addr.created_at,
      updatedAt: addr.updated_at,
    }));
  }

  // Update delivery address
  async updateAddress(userId: string, addressId: string, addressData: any, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // If this is being set as default, unset other defaults first
    if (addressData.isDefault) {
      await client
        .from('delivery_addresses')
        .update({ is_default: false })
        .eq('user_id', userId);
    }

    const { data, error } = await client
      .from('delivery_addresses')
      .update({
        full_name: addressData.fullName,
        phone: addressData.phone,
        address: addressData.address,
        city: addressData.city,
        state: addressData.state,
        country: addressData.country || null,
        postal_code: addressData.postalCode,
        is_default: addressData.isDefault || false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', addressId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('Error updating address:', error);
      throw new HttpException('Failed to update address', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return {
      id: data.id,
      fullName: data.full_name,
      phone: data.phone,
      address: data.address,
      city: data.city,
      state: data.state,
      country: data.country || undefined,
      postalCode: data.postal_code,
      isDefault: data.is_default,
    };
  }

  // Delete delivery address
  async deleteAddress(userId: string, addressId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Check if this is the default address
    const { data: address } = await client
      .from('delivery_addresses')
      .select('is_default')
      .eq('id', addressId)
      .eq('user_id', userId)
      .single();

    if (!address) {
      throw new HttpException('Address not found', HttpStatus.NOT_FOUND);
    }

    // Delete the address
    const { error } = await client
      .from('delivery_addresses')
      .delete()
      .eq('id', addressId)
      .eq('user_id', userId);

    if (error) {
      console.error('Error deleting address:', error);
      throw new HttpException('Failed to delete address', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // If this was the default address, set another one as default
    if (address.is_default) {
      const { data: remainingAddresses } = await client
        .from('delivery_addresses')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (remainingAddresses && remainingAddresses.length > 0) {
        await client
          .from('delivery_addresses')
          .update({ is_default: true })
          .eq('id', remainingAddresses[0].id);
      }
    }

    return { success: true, message: 'Address deleted successfully' };
  }

  // Set default address
  async setDefaultAddress(userId: string, addressId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Unset all other defaults
    await client
      .from('delivery_addresses')
      .update({ is_default: false })
      .eq('user_id', userId);

    // Set this one as default
    const { data, error } = await client
      .from('delivery_addresses')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('id', addressId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('Error setting default address:', error);
      throw new HttpException('Failed to set default address', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return {
      id: data.id,
      fullName: data.full_name,
      phone: data.phone,
      address: data.address,
      city: data.city,
      state: data.state,
      postalCode: data.postal_code,
      isDefault: data.is_default,
    };
  }

  // Create order
  async createOrder(userId: string, orderData: any, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get order summary based on order type
    let summary;
    let isAuctionOrder = false;

    if (orderData.auctionCheckout) {
      // Auction winner checkout
      summary = await this.getAuctionCheckoutSummary(
        userId,
        orderData.auctionCheckout.auctionId,
        userToken,
      );
      isAuctionOrder = true;
    } else if (orderData.invoiceCheckout) {
      // Invoice checkout - use items from invoice
      console.log('📄 Backend createOrder - Invoice checkout with invoiceId:', orderData.invoiceCheckout.invoiceId);
      summary = {
        items: orderData.invoiceCheckout.items.map(item => ({
          id: item.id,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          sellerId: orderData.invoiceCheckout.vendorId,
          image: item.image,
          itemType: item.type || 'product',
        })),
        subtotal: orderData.invoiceCheckout.totalAmount,
        shipping: 0, // Will be set when rider is selected
        tax: 0,
        escrowFee: 0,
        total: orderData.invoiceCheckout.totalAmount,
        sellerId: orderData.invoiceCheckout.vendorId,
      };
    } else if (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) {
      // Wishlist checkout
      console.log('💖 Backend createOrder - Wishlist checkout with itemIds:', orderData.wishlistItemIds);
      summary = await this.getWishlistCheckoutSummary(
        userId,
        orderData.wishlistItemIds,
        userToken,
      );
    } else if (orderData.directCheckout) {
      // Direct product checkout
      summary = await this.getDirectCheckoutSummary(
        userId,
        orderData.directCheckout.productId,
        orderData.directCheckout.quantity,
        userToken,
      );
    } else {
      // Cart checkout (with optional selective item filtering)
      console.log('🛒 Backend createOrder - Cart checkout with selectedItemIds:', orderData.selectedItemIds);
      summary = await this.getCheckoutSummary(userId, userToken, orderData.selectedItemIds);
    }

    // ✅ INTERSTATE MIXED-CART REJECTION
    // Cart and wishlist checkouts cannot mix in-state and out-of-state items.
    // Direct/auction/invoice checkouts are single-vendor and exempt.
    const isCartOrWishlist = !orderData.auctionCheckout && !orderData.invoiceCheckout && !orderData.directCheckout;
    if (isCartOrWishlist && summary.hasOutOfStateItems) {
      const hasInStateItems = summary.items.some((i: any) => !i.isOutOfState && !i.isOutOfCountry);
      const hasOutOfState = summary.items.some((i: any) => i.isOutOfState || i.isOutOfCountry);
      if (hasInStateItems && hasOutOfState) {
        throw new HttpException(
          'Your cart contains items from vendors in different states/regions. Please check them out separately.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // Build gift card payload for the atomic RPC (validation and redemption happen inside the DB)
    let giftCardPayload: { card_number: string; pin: string; requested_amount: number | null } | null = null;

    if (orderData.giftCard) {
      giftCardPayload = {
        card_number: orderData.giftCard.cardNumber,
        pin: orderData.giftCard.pin,
        requested_amount: orderData.giftCard.amount || null,
      };
    }

    // Generate order number
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    // Handle selected rider
    let actualDeliveryFee = summary.shipping;
    let riderId = null;
    let isInterstateDelivery = false;
    let isInternationalDelivery = false;
    let interstateCompanyId: string | null = null;
    let interstateCompanyName: string | null = null;
    let estimatedDeliveryDays: number | null = null;
    
    if (orderData.interstateCompany) {
      // Interstate/international delivery via logistics company
      isInterstateDelivery = true;
      isInternationalDelivery = summary.hasOutOfCountryItems || false;
      interstateCompanyId = orderData.interstateCompany.companyId;
      interstateCompanyName = orderData.interstateCompany.companyName;
      estimatedDeliveryDays = orderData.interstateCompany.estimatedDeliveryDays || null;
      actualDeliveryFee = orderData.interstateCompany.deliveryPrice;
      riderId = null;
    } else if (orderData.selectedRider) {
      if (orderData.selectedRider.riderId === 'pickup') {
        // Self pickup - no delivery fee, no rider
        actualDeliveryFee = 0;
        riderId = null;
      } else {
        // Rider delivery - use rider's price and assign rider
        actualDeliveryFee = orderData.selectedRider.deliveryPrice;
        riderId = orderData.selectedRider.riderId;
      }
    }

    // Recalculate total with actual delivery fee
    const actualTotal = summary.subtotal + actualDeliveryFee + summary.tax + 
                       (orderData.useEscrow ? summary.escrowFee : 0);

    // Extract vendor_id from items (all items should be from same vendor for now)
    const vendorId = summary.sellerId || summary.items[0]?.sellerId;
    if (!vendorId) {
      throw new HttpException('Vendor ID not found in order items', HttpStatus.BAD_REQUEST);
    }

    // Determine order source
    let orderSource = 'regular';
    if (isAuctionOrder) {
      orderSource = 'auction';
      console.log(`🎯 Order source set to 'auction' for auction checkout (auctionId: ${orderData.auctionCheckout?.auctionId})`);
    } else if (orderData.invoiceCheckout) {
      orderSource = 'invoice';
    } else if (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) {
      orderSource = 'wishlist';
    } else if (orderData.directCheckout) {
      orderSource = 'regular';
    }
    
    console.log(`📦 Order source determined: ${orderSource} (isAuctionOrder: ${isAuctionOrder})`);

    // Log delivery type detection
    console.log('🚚 [DEBUG] Delivery type detection:', {
      hasSelectedRider: !!orderData.selectedRider,
      selectedRider: orderData.selectedRider,
      selectedRiderRiderId: orderData.selectedRider?.riderId,
      isPickup: orderData.selectedRider?.riderId === 'pickup',
      isInterstateDelivery,
      interstateCompanyId,
      calculatedRiderId: riderId,
      deliveryType: isInterstateDelivery ? 'interstate_delivery' : (orderData.selectedRider?.riderId === 'pickup' ? 'pickup' : 'delivery')
    });

    // Validate wallet balance before the atomic RPC (accounting for gift card and rewards)
    if (orderData.paymentMethodId === 'wallet' && actualTotal > 0) {
      const estimatedRewards = orderData.useRewards ? (orderData.rewardsAmount || 0) : 0;
      const requestedGift = giftCardPayload?.requested_amount ?? 0;
      const effectiveGift = Math.min(requestedGift, Math.max(0, actualTotal - estimatedRewards));
      const walletPortion = Math.max(0, actualTotal - effectiveGift - estimatedRewards);

      const { data: wallet } = await client
        .from('wallets')
        .select('available_balance')
        .eq('user_id', userId)
        .single();

      if (!wallet || wallet.available_balance < walletPortion) {
        throw new HttpException('Insufficient wallet balance', HttpStatus.BAD_REQUEST);
      }
    }

    // Create order with correct schema
    const orderToInsert = {
      buyer_id: userId,
      vendor_id: vendorId,
      order_number: orderNumber,
      status: 'pending',
      escrow_enabled: orderData.useEscrow || false,
      total_amount: actualTotal,
      delivery_fee: actualDeliveryFee,
      platform_fee: isAuctionOrder && summary.commissionFee
        ? summary.commissionFee
        : summary.total * 0.02,
      rider_id: riderId,
      delivery_type: isInterstateDelivery
        ? 'interstate_delivery'
        : (orderData.selectedRider?.riderId === 'pickup' ? 'pickup' : 'delivery'),
      delivery_address: {
        fullName: orderData.deliveryAddress.fullName,
        phone: orderData.deliveryAddress.phone,
        address: orderData.deliveryAddress.address,
        city: orderData.deliveryAddress.city,
        state: orderData.deliveryAddress.state,
        country: orderData.deliveryAddress.country,
        postalCode: orderData.deliveryAddress.postalCode,
      },
      delivery_instructions: orderData.deliveryInstructions,
      estimated_delivery: isInterstateDelivery
        ? new Date(Date.now() + (estimatedDeliveryDays || 3) * 24 * 60 * 60 * 1000).toISOString()
        : (riderId
          ? new Date(Date.now() + (orderData.selectedRider?.estimatedArrival || 30) * 60 * 1000).toISOString()
          : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()),
      rider_info: orderData.selectedRider ? {
        riderId: orderData.selectedRider.riderId,
        riderName: orderData.selectedRider.riderName,
        vehicleType: orderData.selectedRider.vehicleType,
        deliveryPrice: orderData.selectedRider.deliveryPrice,
        estimatedArrival: orderData.selectedRider.estimatedArrival,
      } : null,
      source: orderSource,
      metadata: {
        subtotal: summary.subtotal,
        tax_amount: summary.tax,
        escrow_fee: orderData.useEscrow ? summary.escrowFee : 0,
        payment_method: orderData.paymentMethodId,
        original_shipping: summary.shipping,
        ...(isInterstateDelivery ? {
          interstate_delivery: {
            companyId: interstateCompanyId,
            companyName: interstateCompanyName,
            estimatedDeliveryDays,
            deliveryPrice: actualDeliveryFee,
            isInternational: isInternationalDelivery,
          },
        } : {}),
        ...(isAuctionOrder && orderData.auctionCheckout ? {
          auction_id: orderData.auctionCheckout.auctionId,
        } : {}),
        ...(orderSource === 'invoice' && orderData.invoiceCheckout ? {
          invoiceId: orderData.invoiceCheckout.invoiceId,
          invoiceNumber: orderData.invoiceCheckout.invoiceNumber,
        } : {}),
        ...(orderSource === 'wishlist' && orderData.wishlistItemIds ? {
          wishlist_item_ids: orderData.wishlistItemIds,
        } : {}),
      },
    };

    // Build order items for the atomic RPC
    const p_items = summary.items.map(item => {
      const isService = item.itemType === 'service';
      const isAuction = item.itemType === 'auction';
      const isInvoiceOrder = orderSource === 'invoice';

      const unitPrice = item.price || 0;
      if (!item.price || item.price <= 0) {
        console.warn(`⚠️ Warning: Item "${item.name}" has invalid price: ${item.price}. Using 0 as fallback.`);
      }

      return {
        product_id: isService || isAuction || isInvoiceOrder ? null : item.id,
        service_id: (isService && !isInvoiceOrder) ? item.id : null,
        product_name: item.name,
        category: item.category || 'General',
        quantity: item.quantity,
        unit_price: unitPrice,
        total_price: unitPrice * item.quantity,
        scheduled_date: isService ? item.serviceDate : null,
        scheduled_time: isService ? item.serviceTime : null,
        service_notes: isService ? item.serviceNotes : null,
        product_metadata: isAuction ? {
          auction_id: orderData.auctionCheckout?.auctionId,
          auction_item_id: orderData.auctionCheckout?.itemId || item.product_metadata?.auction_item_id || null,
          auction_lot: item.product_metadata?.auction_lot,
          description: item.product_metadata?.description,
        } : null,
      };
    });

    // ✅ HANDLE REWARDS REDEMPTION (before the atomic RPC)
    let rewardsUsed = 0;
    let rewardsTransactionId: string | null = null;

    if (orderData.useRewards && orderData.rewardsAmount > 0) {
      console.log(`🎁 User wants to use ${orderData.rewardsAmount} rewards`);

      const redemptionResult = await this.rewardsService.redeemRewards(
        userId,
        orderData.rewardsAmount,
      );

      if (!redemptionResult.success) {
        throw new HttpException('Failed to redeem rewards', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      rewardsUsed = orderData.rewardsAmount;
      rewardsTransactionId = redemptionResult.transaction_id ?? null;

      console.log(`✅ Redeemed ${rewardsUsed} rewards`);
    }

    // Build escrow breakdown
    const orderCommissionRate = orderToInsert.platform_fee && actualTotal > 0
      ? orderToInsert.platform_fee / actualTotal
      : undefined;
    const escrowBreakdown = this.calculateEscrowBreakdown(actualTotal, riderId, orderCommissionRate);
    const p_escrow = {
      total_amount: escrowBreakdown.totalAmount,
      vendor_amount: escrowBreakdown.vendorAmount,
      rider_amount: escrowBreakdown.riderAmount,
      platform_amount: escrowBreakdown.platformAmount,
    };

    // Call the atomic product order RPC
    const { data: rpcData, error: rpcError } = await this.supabase.rpc(
      'create_product_order_atomic',
      {
        p_buyer_id: userId,
        p_order: orderToInsert,
        p_items: p_items,
        p_escrow: p_escrow,
        p_gift_card: giftCardPayload,
        p_rewards_amount: rewardsUsed,
        p_admin_gift_user_id: this.configService.get<string>('PLATFORM_GIFT_WALLET_USER_ID', '00000000-0000-4000-8000-000000000003'),
        p_user_ip: null,
      }
    );

    if (rpcError) {
      console.error('create_product_order_atomic RPC error:', rpcError);
      if (rewardsUsed > 0) {
        await this.rewardsService.reverseRewardsRedemption(userId, rewardsUsed);
      }
      throw new HttpException(
        rpcError.message || 'Order creation failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const rpcResult = rpcData as any;
    if (!rpcResult || !rpcResult.success) {
      console.error('create_product_order_atomic failed:', rpcResult?.error);
      if (rewardsUsed > 0) {
        await this.rewardsService.reverseRewardsRedemption(userId, rewardsUsed);
      }
      throw new HttpException(
        rpcResult?.error || 'Order creation failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Merge the returned order fields with the local payload
    const order = { ...orderToInsert, ...rpcResult.order } as any;

    console.log(`✅ Order created: ${order.order_number}, source: ${order.source}, isAuctionOrder: ${isAuctionOrder}`);
    if (isAuctionOrder && order.source !== 'auction') {
      console.error(`❌ WARNING: Order ${order.order_number} was created as auction but source is '${order.source}' instead of 'auction'!`);
    }

    // Update rewards transaction with the new order id
    if (rewardsTransactionId) {
      try {
        await client
          .from('rewards_transactions')
          .update({
            reference_id: order.id,
            metadata: { order_id: order.id, redeemed_amount: rewardsUsed },
          })
          .eq('id', rewardsTransactionId);
        console.log(`✅ Rewards transaction ${rewardsTransactionId} linked to order ${order.id}`);
      } catch (error) {
        console.error('Failed to update rewards transaction with order id:', error);
      }
    }

    // ✅ SEND PINs VIA NOTIFICATIONS
    try {
      const { data: vendorProfile } = await client
        .from('user_profiles')
        .select('username')
        .eq('id', order.vendor_id)
        .single();

      if (order.delivery_type === 'pickup') {
        await this.notificationHelper.notifyVendorSelfPickupPin(order.vendor_id, {
          id: order.id,
          orderNumber: order.order_number,
          deliveryPin: order.delivery_pin,
          buyerName: 'Buyer',
        });
        console.log(`✅ Sent self-pickup PIN to vendor ${order.vendor_id}`);

        await this.notificationHelper.notifyBuyerSelfPickupPin(userId, {
          id: order.id,
          orderNumber: order.order_number,
          deliveryPin: order.delivery_pin,
          vendorName: vendorProfile?.username,
        });
        console.log(`✅ Sent self-pickup PIN to buyer ${userId}`);
      } else {
        if (order.rider_id) {
          await this.notificationHelper.notifyRiderPickupPin(order.rider_id, {
            id: order.id,
            orderNumber: order.order_number,
            pickupPin: order.pickup_pin,
            vendorName: vendorProfile?.username,
          });
          console.log(`✅ Sent pickup PIN to rider ${order.rider_id}`);
        }

        await this.notificationHelper.notifyBuyerDeliveryPin(userId, {
          id: order.id,
          orderNumber: order.order_number,
          deliveryPin: order.delivery_pin,
        });
        console.log(`✅ Sent delivery PIN to buyer ${userId}`);
      }
    } catch (notifyError) {
      console.error('Failed to send PIN notifications (non-critical):', notifyError);
    }

    // ✅ Link invoice to order if this order came from an invoice (after payment is processed)
    if (order.source === 'invoice' && order.metadata?.invoiceId) {
      try {
        // Fetch invoice to get invoice number
        const { data: invoice } = await client
          .from('chat_invoices')
          .select('invoice_number')
          .eq('id', order.metadata.invoiceId)
          .single();
        
        // Link order to invoice and update metadata with actual invoice number
        const { error: linkError } = await client
          .from('chat_invoices')
          .update({ order_id: order.id })
          .eq('id', order.metadata.invoiceId);
        
        if (linkError) {
          console.error('Failed to link invoice to order:', linkError);
        } else {
          console.log(`✅ Invoice ${order.metadata.invoiceId} linked to order ${order.id}`);
          
          // Update order metadata with actual invoice number if we have it
          if (invoice?.invoice_number && invoice.invoice_number !== order.metadata.invoiceNumber) {
            await client
              .from('orders')
              .update({
                metadata: {
                  ...order.metadata,
                  invoiceNumber: invoice.invoice_number,
                },
              })
              .eq('id', order.id);
          }
        }
      } catch (error) {
        console.error('Failed to link invoice to order:', error);
        // Don't throw - invoice linking is not critical to order creation
      }
    }

    // ✅ Remove purchased items from wishlist if this order came from wishlist
    if (order.source === 'wishlist' && order.metadata?.wishlist_item_ids) {
      try {
        await this.wishlistService.removePurchasedItems(
          userId,
          order.metadata.wishlist_item_ids,
          userToken,
        );
        console.log(`✅ Removed ${order.metadata.wishlist_item_ids.length} items from wishlist after purchase`);
      } catch (error) {
        console.error('Failed to remove wishlist items:', error);
        // Don't throw - wishlist cleanup is not critical to order creation
      }
    }

    // Clear cart if not direct checkout
    // For selective checkout, DON'T clear the cart here - let the frontend handle it
    // For full cart checkout (no selectedItemIds), clear the entire cart
    if (!orderData.directCheckout && !orderData.auctionCheckout) {
      if (!orderData.selectedItemIds || orderData.selectedItemIds.length === 0) {
        // Full cart checkout - clear everything
        console.log('🗑️ Backend: Clearing entire cart (full cart checkout)');
        await client
          .from('cart_items')
          .delete()
          .eq('user_id', userId);
      } else {
        // Selective checkout - DON'T clear cart (frontend will remove only selected items)
        console.log(`🔒 Backend: Skipping cart clear (selective checkout - ${orderData.selectedItemIds.length} items selected)`);
        console.log('   Frontend will handle removing only selected items');
      }
    }

    // Product stock is now decremented atomically inside create_product_order_atomic.

    // Handle auction-specific logic
    if (isAuctionOrder && orderData.auctionCheckout) {
      // Mark auction win as checked out (for both live and timed auctions)
      try {
        // Get user's wins for this auction
        const wins = await this.auctionsService.getUserAuctionWins(
          userId,
          'pending_checkout',
          userToken,
        );

        // Find the win that matches this auction (and item if multi-item)
        const auctionId = orderData.auctionCheckout.auctionId;
        const itemId = orderData.auctionCheckout.itemId || null; // For multi-item auctions
        
        const matchingWin = wins.find(
          (win: any) =>
            win.auction_id === auctionId &&
            (win.item_id === itemId || (win.item_id === null && itemId === null))
        );

        if (matchingWin) {
          await this.auctionsService.markWinCheckedOut(
            matchingWin.id,
            order.id,
            userId,
            userToken,
          );
          console.log(`✅ Marked auction win ${matchingWin.id} as checked out`);
        } else {
          console.warn(`⚠️ No matching win found for auction ${auctionId}, item ${itemId}`);
        }
      } catch (error) {
        console.error('Failed to mark auction win as checked out:', error);
        // Don't throw - marking win as checked out is not critical to order creation
      }

      // Update auction sale record to link to order and mark as completed
      // The sale record was created as 'pending' when auction ended
      await client
        .from('auction_sales')
        .update({
          payment_status: 'completed',
          payment_transaction_id: order.id,
        })
        .eq('auction_id', orderData.auctionCheckout.auctionId)
        .eq('buyer_id', userId);
    }

    // ✅ NOTIFY VENDOR OF NEW ORDER
    try {
      // Get buyer name for notification
      const { data: buyerProfile } = await client
        .from('user_profiles')
        .select('username')
        .eq('id', userId)
        .single();

      await this.notificationHelper.notifyVendorNewOrder(vendorId, {
        id: order.id,
        orderNumber: order.order_number,
        totalAmount: actualTotal,
        itemCount: summary.items.length,
        buyerName: buyerProfile?.username || 'Customer',
      });
      console.log(`✅ Vendor ${vendorId} notified of new order ${order.order_number}`);
    } catch (notifyError) {
      console.error('Failed to notify vendor (non-critical):', notifyError);
    }

    // ✅ NOTIFY VENDOR OF PAYMENT IN ESCROW (if wallet payment)
    if (orderData.paymentMethodId === 'wallet') {
      try {
        // Calculate commission rate from order's platform_fee (already set correctly for all order types)
        // Auction orders: 10%, Live sales: 5%, Regular orders: 2%
        const orderCommissionRate = order.platform_fee && actualTotal > 0
          ? order.platform_fee / actualTotal
          : undefined; // undefined = use default 2%
        
        const escrowBreakdown = this.calculateEscrowBreakdown(actualTotal, riderId, orderCommissionRate);
        await this.notificationHelper.notifyVendorOrderPaid(vendorId, {
          orderId: order.id,
          orderNumber: order.order_number,
          vendorAmount: escrowBreakdown.vendorAmount,
          escrowId: order.id, // Escrow uses order_id as reference
        });
        console.log(`✅ Vendor ${vendorId} notified of payment in escrow (commission rate: ${orderCommissionRate ? (orderCommissionRate * 100).toFixed(1) + '%' : 'default 2%'})`);
      } catch (notifyError) {
        console.error('Failed to notify vendor of payment (non-critical):', notifyError);
      }
    }

    // ✅ INTERSTATE DELIVERY: Generate pickup PIN and surface order to logistics partner
    if (isInterstateDelivery && interstateCompanyId) {
      try {
        // Generate a pickup PIN so the logistics company's driver can claim the item from
        // the vendor safely (same handoff-verification pattern used for regular rider delivery).
        const interstatePickupPin = this.generatePIN();
        const interstateDeliveryPin = this.generatePIN();

        await client
          .from('orders')
          .update({
            pickup_pin: interstatePickupPin,
            delivery_pin: interstateDeliveryPin,
            metadata: {
              ...order.metadata,
              interstate_delivery: {
                ...(order.metadata?.interstate_delivery || {}),
                status: 'pending_partner_acceptance',
              },
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);

        console.log(`✅ Generated pickup/delivery PINs for interstate order ${order.order_number}, company ${interstateCompanyName}`);
        // The logistics partner sees this order (status: pending_partner_acceptance) in their
        // "Interstate Orders" tab on the web dashboard and can Accept/Reject it there.
      } catch (interstateError) {
        console.error('Failed to finalize interstate delivery setup (non-critical):', interstateError);
      }
    }

    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      total: order.total_amount,
      createdAt: order.created_at,
      estimatedDelivery: order.estimated_delivery,
      isAuctionOrder,
      auctionId: isAuctionOrder ? orderData.auctionCheckout.auctionId : null,
    };
  }

  // Validate checkout
  async validateCheckout(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Check if cart has items
      const { data: cartItems } = await client
        .from('cart_items')
        .select('id, quantity, products!cart_items_product_id_fkey(quantity)')
        .eq('user_id', userId);

      if (!cartItems || cartItems.length === 0) {
        errors.push('Cart is empty');
      } else {
        // Check stock availability
        for (const item of cartItems) {
          if (item.products.quantity < item.quantity) {
            errors.push(`Insufficient stock for ${item.products.name}`);
          }
        }
      }

      // Check if user has a default address
      const { data: address } = await client
        .from('delivery_addresses')
        .select('id')
        .eq('user_id', userId)
        .eq('is_default', true)
        .single();

      if (!address) {
        warnings.push('No default delivery address set');
      }

    } catch (error) {
      console.error('Validation error:', error);
      errors.push('Unable to validate checkout');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // Calculate escrow fee (Currently FREE - set to 0%)
  // TODO: To enable escrow fees in the future, change rate from 0 to desired percentage (e.g., 0.025 for 2.5%)
  // and set minimum fee (e.g., 50 for ₦50 minimum)
  calculateEscrowFee(amount: number): number {
    const escrowRate = 0; // 0% = FREE (change to 0.025 for 2.5%)
    const minimumFee = 0; // ₦0 minimum (change to 50 for ₦50 minimum)
    return Math.max(minimumFee, Math.round(amount * escrowRate));
  }

  // Calculate shipping cost
  private calculateShipping(subtotal: number, items: any[]): number {
    // Services don't require shipping
    const hasPhysicalProducts = items.some(item => item.itemType === 'product');
    
    if (!hasPhysicalProducts) {
      return 0; // No shipping for service-only orders
    }
    
    // Calculate subtotal for physical products only
    const productSubtotal = items
      .filter(item => item.itemType === 'product')
      .reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    // Free shipping for product orders over ₦10,000
    if (productSubtotal >= 10000) {
      return 0;
    }

    // Base shipping rate of ₦500 for physical products
    // Note: Actual shipping will be determined by rider selection
    return 0; // Set to 0 - calculated at rider selection
  }

  // Calculate tax (7.5% VAT)
  // NOTE: Tax calculation disabled - users don't pay tax yet
  private calculateTax(subtotal: number): number {
    return 0; // Disabled for now
  }

  // Get delivery options based on address
  async getDeliveryOptions(address: any, userId: string) {
    // In a real implementation, this would calculate based on location
    // For now, return standard options
    return [
      {
        id: 'standard',
        name: 'Standard Delivery',
        description: '3-5 business days',
        cost: address?.city?.toLowerCase() === 'lagos' ? 0 : 500,
        estimatedDays: 4,
      },
      {
        id: 'express',
        name: 'Express Delivery',
        description: '1-2 business days',
        cost: address?.city?.toLowerCase() === 'lagos' ? 500 : 1000,
        estimatedDays: 1,
      },
    ];
  }

  // Process wallet payment
  /* ==== OLD CODE — processWalletPayment, kept for reference; not executed ====
  private async processWalletPayment(
    userId: string,
    orderId: string,
    amount: number,
    vendorId: string,
    riderId: string | null,
    client: any,
  ) {
    // ✅ Use the process_wallet_transaction helper for proper escrow handling
    // This function automatically handles:
    // - Moving money from available_balance to escrow_balance
    // - Creating proper wallet_ledger entries
    // - Atomic transaction safety
    // - Validating both RPC error and return value success field
    //
    // Note: `amount` here is only the wallet portion of the order total. If the
    // order is fully covered by a gift card, `amount` will be 0 and this hold is
    // skipped entirely - the gift card portion is already held in the buyer's
    // escrow balance by GiftCardService.applyToCheckout().
    // ✅ GENERATE HANDOFF PINS (3-digit)
    // For self-pickup: only delivery PIN needed (buyer shows to vendor)
    // For regular delivery: both PINs needed (pickup PIN for rider→vendor, delivery PIN for rider→buyer)
    const pickupPin = Math.floor(100 + Math.random() * 900).toString(); // 3-digit (100-999)
    const deliveryPin = Math.floor(100 + Math.random() * 900).toString(); // 3-digit (100-999)

    if (amount > 0) {
      // ✅ ATOMIC FIX: Hold and set pins in one Postgres transaction.
      const { data: holdResult, error: holdRpcError } = await client.rpc(
        'complete_purchase_hold_atomic',
        {
          p_order_id: orderId,
          p_buyer_id: userId,
          p_amount: amount,
          p_description: `Payment for order ${orderId}`,
          p_pickup_pin: pickupPin,
          p_delivery_pin: deliveryPin,
        }
      );

      if (holdRpcError) {
        console.error('complete_purchase_hold_atomic RPC error:', holdRpcError);
        throw new HttpException(
          holdRpcError.message || 'Payment processing failed',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      if (!holdResult || !holdResult.success) {
        console.error('complete_purchase_hold_atomic failed:', holdResult?.error);
        throw new HttpException(
          holdResult?.error || 'Payment processing failed',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      console.log(`✅ Wallet payment processed successfully:`, {
        transactionId: holdResult.hold_transaction_id,
      });
    } else {
      console.log(`ℹ️ No wallet portion to hold for order ${orderId} - fully covered by gift card`);

      // Still save the pins for gift-card-only orders
      await client
        .from('orders')
        .update({
          pickup_pin: pickupPin,
          delivery_pin: deliveryPin,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);
    }
    
    console.log(`✅ Generated handoff PINs for order ${orderId}`);
    
    // ✅ SEND PINs VIA NOTIFICATIONS
    try {
      // Get order details for notifications
      const { data: orderDetails } = await client
        .from('orders')
        .select('order_number, buyer_id, vendor_id, rider_id, delivery_type')
        .eq('id', orderId)
        .single();

      if (orderDetails) {
        // Get vendor name for notifications
        const { data: vendorProfile } = await client
          .from('user_profiles')
          .select('username')
          .eq('id', orderDetails.vendor_id)
          .single();

        // ✅ Handle PIN notifications based on delivery type
        if (orderDetails.delivery_type === 'pickup') {
          // Self-pickup: Send deliveryPin to BOTH vendor and buyer
          // Buyer provides deliveryPin to vendor for handoff verification
          
          // Send deliveryPin to vendor (for verification)
          await this.notificationHelper.notifyVendorSelfPickupPin(orderDetails.vendor_id, {
            id: orderId,
            orderNumber: orderDetails.order_number,
            deliveryPin: deliveryPin,
            buyerName: 'Buyer', // Could fetch buyer username if needed
          });
          console.log(`✅ Sent self-pickup PIN to vendor ${orderDetails.vendor_id}`);

          // Send deliveryPin to buyer (to provide to vendor)
          await this.notificationHelper.notifyBuyerSelfPickupPin(orderDetails.buyer_id, {
            id: orderId,
            orderNumber: orderDetails.order_number,
            deliveryPin: deliveryPin,
            vendorName: vendorProfile?.username,
          });
          console.log(`✅ Sent self-pickup PIN to buyer ${orderDetails.buyer_id}`);
        } else {
          // Regular delivery: Send pickupPin to rider, deliveryPin to buyer
          
          // Send pickup PIN to rider
          if (orderDetails.rider_id) {
            await this.notificationHelper.notifyRiderPickupPin(orderDetails.rider_id, {
              id: orderId,
              orderNumber: orderDetails.order_number,
              pickupPin: pickupPin,
              vendorName: vendorProfile?.username,
            });
            console.log(`✅ Sent pickup PIN to rider ${orderDetails.rider_id}`);
          }

          // Send delivery PIN to buyer
          await this.notificationHelper.notifyBuyerDeliveryPin(orderDetails.buyer_id, {
            id: orderId,
            orderNumber: orderDetails.order_number,
            deliveryPin: deliveryPin,
          });
          console.log(`✅ Sent delivery PIN to buyer ${orderDetails.buyer_id}`);
        }
      }
    } catch (notifyError) {
      console.error('Failed to send PIN notifications (non-critical):', notifyError);
    }

    // ✅ CREATE ESCROW RECORD
    try {
      // Get order to get commission rate from platform_fee (already set correctly for all order types)
      // Auction orders: 10%, Live sales: 5%, Regular orders: 2%
      const { data: orderData } = await client
        .from('orders')
        .select('source, metadata, platform_fee, total_amount')
        .eq('id', orderId)
        .single();
      
      // Calculate commission rate from platform_fee for ALL order types
      // This ensures correct commission rates: 10% (auctions), 5% (live sales), 2% (regular)
      const orderCommissionRate = orderData?.platform_fee && orderData?.total_amount && orderData.total_amount > 0
        ? orderData.platform_fee / orderData.total_amount
        : undefined; // undefined = use default 2%
      
      console.log(`💰 Escrow commission rate for order ${orderId}: ${orderCommissionRate ? (orderCommissionRate * 100).toFixed(1) + '%' : 'default 2%'} (source: ${orderData?.source || 'unknown'})`);
      
      // ✅ FIX: Escrow must be created for the FULL order total (wallet + gift card
      // portions), not just the wallet portion (`amount`). The gift card portion is
      // already held in the buyer's escrow balance (see GiftCardService.applyToCheckout),
      // so vendor/rider/platform amounts must be computed off the full total to avoid
      // under-paying the vendor when a gift card was used.
      const escrowTotal = orderData?.total_amount ?? amount;
      const escrowBreakdown = this.calculateEscrowBreakdown(escrowTotal, riderId, orderCommissionRate);
      const escrow = await this.escrowService.createEscrow(orderId, {
        ...escrowBreakdown,
        paymentSource: orderData?.payment_source || 'wallet',
        giftCardAmount: orderData?.gift_card_applied_amount || 0
      });
      console.log(`✅ Escrow created for order ${orderId}: ₣${escrowTotal}`);
      return escrow;
    } catch (escrowError) {
      console.error('❌ CRITICAL: Failed to create escrow after payment:', escrowError);
      // ⚠️ Payment is already processed (money in escrow balance), but escrow record doesn't exist
      // This is a critical failure requiring manual intervention
      throw new HttpException(
        'Payment processed successfully but escrow creation failed. Payment is held in escrow but no escrow record exists. Manual intervention required.',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
  ==== OLD CODE END ==== */

  // Calculate escrow breakdown (platform fee: varies by order type - 10% auctions, 5% live sales, 2% regular, delivery fee: 10% if rider)
  // ✅ FIX: Round amounts to 6 decimal places (matching DECIMAL(18,6)) and validate sum
  // ✅ FIX: Use actual commission rate from order for ALL order types, not just auctions
  private calculateEscrowBreakdown(
    totalAmount: number,
    riderId: string | null,
    platformCommissionRate?: number, // Optional: Commission rate from order (0.10 for 10%, 0.05 for 5%, 0.02 for 2%)
  ): { totalAmount: number; vendorAmount: number; riderAmount: number; platformAmount: number } {
    // Helper function to round to 6 decimal places (matching DECIMAL(18,6) precision)
    const round6 = (value: number): number => Math.round(value * 1000000) / 1000000;

    // Use provided commission rate (from order's platform_fee) or default to 2% for regular orders
    // This ensures correct rates: 10% (auctions), 5% (live sales), 2% (regular)
    const commissionRate = platformCommissionRate !== undefined ? platformCommissionRate : 0.02;
    const platformFee = round6(totalAmount * commissionRate);
    const deliveryFee = riderId ? round6(totalAmount * 0.10) : 0; // 10% delivery fee if rider assigned
    
    // Calculate vendor amount (ensures sum equals totalAmount exactly)
    const vendorAmount = round6(totalAmount - platformFee - deliveryFee);

    // ✅ Validate sum equals totalAmount (within floating point tolerance)
    const sum = round6(vendorAmount + deliveryFee + platformFee);
    const difference = Math.abs(sum - totalAmount);
    
    if (difference > 0.000001) {
      // If rounding caused discrepancy, adjust vendor amount to balance
      // This ensures vendorAmount + riderAmount + platformAmount === totalAmount exactly
      const adjustedVendorAmount = round6(totalAmount - platformFee - deliveryFee);
      console.warn(`⚠️ Escrow breakdown rounding adjustment: ${difference} difference adjusted in vendorAmount`);
      
      return {
        totalAmount,
        vendorAmount: adjustedVendorAmount,
        riderAmount: deliveryFee,
        platformAmount: platformFee,
      };
    }

    return {
      totalAmount,
      vendorAmount,
      riderAmount: deliveryFee,
      platformAmount: platformFee,
    };
  }

  // ========== MULTI-VENDOR CHECKOUT METHODS ==========

  // Group items by vendor
  public groupItemsByVendor(items: any[]): any[] {
    const groups = {};
    
    items.forEach(item => {
      if (!groups[item.sellerId]) {
        groups[item.sellerId] = {
          vendorId: item.sellerId,
          items: [],
          subtotal: 0,
        };
      }
      
      groups[item.sellerId].items.push(item);
      groups[item.sellerId].subtotal += item.price * item.quantity;
    });
    
    return Object.values(groups);
  }

  // Create grouped order (main method)
  async createGroupedOrder(userId: string, orderData: any, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    let orderGroupId: string | null = null;
    let rewardsUsed = 0;
    let rewardsTransactionId: string | null = null;
    let createdOrderIds: string[] = [];

    try {
      let summary;
      if (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) {
        console.log('Backend createGroupedOrder - Wishlist checkout with itemIds:', orderData.wishlistItemIds);
        summary = await this.getWishlistCheckoutSummary(userId, orderData.wishlistItemIds, userToken);
      } else {
        console.log('Backend createGroupedOrder - Cart checkout with selectedItemIds:', orderData.selectedItemIds);
        summary = await this.getCheckoutSummary(userId, userToken, orderData.selectedItemIds);
      }

      const vendorGroups = this.groupItemsByVendor(summary.items);

      if (vendorGroups.length === 1) {
        return this.createOrder(userId, orderData, userToken);
      }

      const pGroups: any[] = [];
      const groupNumber = 'GRP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();

      for (let i = 0; i < vendorGroups.length; i++) {
        const group = vendorGroups[i];
        const riderAssignment = orderData.riderAssignments?.[i] || null;
        const riderId = riderAssignment?.rider?.id || null;
        const deliveryFee = riderAssignment?.pricing?.total
          ? Math.round((riderAssignment.pricing.total / (riderAssignment.vendorIds?.length || 1)) * 100) / 100
          : 0;
        const groupSubtotal = group.subtotal;
        const groupTax = this.calculateTax(groupSubtotal);
        const groupEscrowFee = orderData.useEscrow ? this.calculateEscrowFee(groupSubtotal + deliveryFee + groupTax) : 0;
        const groupTotal = groupSubtotal + deliveryFee + groupTax + groupEscrowFee;
        const orderNumber = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase() + '-' + (i + 1);
        const escrowBreakdown = this.calculateEscrowBreakdown(groupTotal, riderId, groupTotal > 0 ? groupTotal * 0.02 / groupTotal : 0.02);

        const orderToInsert = {
          buyer_id: userId,
          vendor_id: group.vendorId,
          order_number: orderNumber,
          status: 'pending',
          escrow_enabled: orderData.useEscrow || false,
          total_amount: groupTotal,
          delivery_fee: deliveryFee,
          platform_fee: escrowBreakdown.platformAmount,
          rider_id: riderId,
          delivery_type: 'delivery',
          delivery_address: orderData.deliveryAddress,
          delivery_instructions: orderData.deliveryInstructions,
          estimated_delivery: riderAssignment?.route?.estimatedTime
            ? new Date(Date.now() + riderAssignment.route.estimatedTime * 60 * 1000).toISOString()
            : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          rider_info: riderAssignment ? {
            riderId: riderAssignment.rider.id,
            riderName: riderAssignment.rider.name,
            vehicleType: riderAssignment.vehicleType,
            deliveryPrice: deliveryFee,
            estimatedArrival: riderAssignment.route.estimatedTime,
            multiStop: (riderAssignment.vendorIds?.length || 1) > 1,
            stopSequence: (riderAssignment.vendorIds?.indexOf(group.vendorId) || 0) + 1,
          } : null,
          source: (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) ? 'wishlist' : 'regular',
          order_group_id: orderGroupId,
          is_grouped: true,
          group_sequence: i + 1,
          metadata: {
            subtotal: groupSubtotal,
            tax_amount: groupTax,
            escrow_fee: groupEscrowFee,
            payment_method: orderData.paymentMethodId,
            original_shipping: deliveryFee,
            ...(orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0 ? {
              wishlist_item_ids: orderData.wishlistItemIds,
            } : {}),
          },
        };

        const pItems = group.items.map((item: any) => {
          const isService = item.itemType === 'service';
          const isProduct = !isService;
          const unitPrice = item.price || 0;
          return {
            product_id: isProduct ? item.id : null,
            service_id: isService ? item.id : null,
            product_name: item.name,
            category: item.category || 'General',
            quantity: item.quantity,
            unit_price: unitPrice,
            total_price: unitPrice * item.quantity,
            scheduled_date: isService ? item.serviceDate : null,
            scheduled_time: isService ? item.serviceTime : null,
            service_notes: isService ? item.serviceNotes : null,
            product_metadata: null,
          };
        });

        const stockUpdates = group.items
          .filter((item: any) => item.itemType !== 'service')
          .map((item: any) => ({
            product_id: item.id,
            quantity: item.quantity,
          }));

        pGroups.push({
          order: orderToInsert,
          items: pItems,
          escrow: {
            total_amount: escrowBreakdown.totalAmount,
            vendor_amount: escrowBreakdown.vendorAmount,
            rider_amount: escrowBreakdown.riderAmount,
            platform_amount: escrowBreakdown.platformAmount,
          },
          stock_updates: stockUpdates,
        });
      }

      const totalAmount = pGroups.reduce((sum, g) => sum + g.order.total_amount, 0);

      let giftCardPayload: { card_number: string; pin: string; requested_amount: number | null } | null = null;
      if (orderData.giftCard) {
        giftCardPayload = {
          card_number: orderData.giftCard.cardNumber,
          pin: orderData.giftCard.pin,
          requested_amount: orderData.giftCard.amount || null,
        };
      }

      if (orderData.useRewards && orderData.rewardsAmount > 0) {
        const redemptionResult = await this.rewardsService.redeemRewards(userId, orderData.rewardsAmount);
        if (!redemptionResult.success) {
          throw new HttpException('Failed to redeem rewards', HttpStatus.INTERNAL_SERVER_ERROR);
        }
        rewardsUsed = orderData.rewardsAmount;
        rewardsTransactionId = redemptionResult.transaction_id ?? null;
      }

      if (orderData.paymentMethodId === 'wallet' && totalAmount > 0) {
        const estimatedRewards = rewardsUsed;
        const requestedGift = giftCardPayload?.requested_amount ?? 0;
        const effectiveGift = Math.min(requestedGift, Math.max(0, totalAmount - estimatedRewards));
        const walletPortion = Math.max(0, totalAmount - effectiveGift - estimatedRewards);

        const { data: wallet } = await client
          .from('wallets')
          .select('available_balance')
          .eq('user_id', userId)
          .single();

        if (!wallet || wallet.available_balance < walletPortion) {
          if (rewardsUsed > 0) {
            await this.rewardsService.reverseRewardsRedemption(userId, rewardsUsed);
          }
          throw new HttpException('Insufficient wallet balance', HttpStatus.BAD_REQUEST);
        }
      }

      const { data: orderGroup, error: groupError } = await client
        .from('order_groups')
        .insert({
          group_number: groupNumber,
          buyer_id: userId,
          total_amount: totalAmount,
          total_orders: vendorGroups.length,
          delivery_address: orderData.deliveryAddress,
        })
        .select()
        .single();

      if (groupError) throw new HttpException('Failed to create order group', HttpStatus.INTERNAL_SERVER_ERROR);

      orderGroupId = orderGroup.id;

      pGroups.forEach((g: any) => {
        g.order.order_group_id = orderGroupId;
      });

      const { data: rpcData, error: rpcError } = await this.supabase.rpc('create_grouped_order_atomic', {
        p_buyer_id: userId,
        p_groups: pGroups,
        p_gift_card: giftCardPayload,
        p_rewards_amount: rewardsUsed,
        p_admin_gift_user_id: this.configService.get<string>('PLATFORM_GIFT_WALLET_USER_ID', '00000000-0000-4000-8000-000000000003'),
        p_user_ip: null,
      });

      if (rpcError) {
        console.error('create_grouped_order_atomic RPC error:', rpcError);
        if (rewardsUsed > 0) {
          await this.rewardsService.reverseRewardsRedemption(userId, rewardsUsed);
        }
        throw new HttpException(rpcError.message || 'Grouped order creation failed', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      const rpcResult = rpcData as any;
      if (!rpcResult || !rpcResult.success) {
        console.error('create_grouped_order_atomic failed:', rpcResult?.error);
        if (rewardsUsed > 0) {
          await this.rewardsService.reverseRewardsRedemption(userId, rewardsUsed);
        }
        throw new HttpException(rpcResult?.error || 'Grouped order creation failed', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      createdOrderIds = rpcResult.orders || [];

      const { data: orders, error: ordersError } = await client
        .from('orders')
        .select('*')
        .in('id', createdOrderIds)
        .order('group_sequence', { ascending: true });

      if (ordersError) {
        console.error('Failed to fetch created grouped orders:', ordersError);
        if (rewardsUsed > 0) {
          await this.rewardsService.reverseRewardsRedemption(userId, rewardsUsed);
        }
        throw new HttpException('Failed to fetch created orders', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      if (rewardsTransactionId) {
        try {
          await client
            .from('rewards_transactions')
            .update({
              reference_id: createdOrderIds[0],
              metadata: { order_id: createdOrderIds[0], order_group_id: orderGroupId, redeemed_amount: rewardsUsed },
            })
            .eq('id', rewardsTransactionId);
        } catch (error) {
          console.error('Failed to update rewards transaction:', error);
        }
      }

      try {
        for (const order of orders || []) {
          await this.notificationHelper.notifyVendorNewOrder(order.vendor_id, {
            id: order.id,
            orderNumber: order.order_number,
            totalAmount: order.total_amount,
          });
          if (order.rider_id) {
            await this.notificationHelper.notifyRiderNewAssignment(order.rider_id, {
              id: order.id,
              orderNumber: order.order_number,
              deliveryFee: order.delivery_fee,
            });
          }
        }
      } catch (notifError) {
        console.warn('Notification sending failed (non-critical):', notifError);
      }

      if (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) {
        try {
          await this.wishlistService.removePurchasedItems(userId, orderData.wishlistItemIds, userToken);
          console.log('Removed ' + orderData.wishlistItemIds.length + ' items from wishlist after grouped order creation');
        } catch (error) {
          console.error('Failed to remove wishlist items (non-critical):', error);
        }
      } else if (!orderData.selectedItemIds || orderData.selectedItemIds.length === 0) {
        console.log('Backend: Clearing entire cart (full cart checkout)');
        await client.from('cart_items').delete().eq('user_id', userId);
      } else {
        console.log('Backend: Skipping cart clear (selective checkout - ' + orderData.selectedItemIds.length + ' items selected)');
      }

      return {
        orderGroup,
        orders: orders || [],
      };

    } catch (error) {
      console.error('Grouped order creation failed:', error);

      if (createdOrderIds.length > 0) {
        await client.from('orders').delete().in('id', createdOrderIds);
        await client.from('order_items').delete().in('order_id', createdOrderIds);
      }

      if (orderGroupId) {
        await client.from('order_groups').delete().eq('id', orderGroupId);
      }

      if (rewardsUsed > 0 && createdOrderIds.length === 0) {
        try {
          await this.rewardsService.reverseRewardsRedemption(userId, rewardsUsed);
        } catch (rewardError) {
          console.error('Failed to reverse rewards redemption:', rewardError);
        }
      }

      throw error;
    }
  }
}