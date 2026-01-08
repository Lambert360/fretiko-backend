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

@Injectable()
export class CheckoutService {
  private supabase;

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
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Generate a 3-digit PIN for order handoff verification
   */
  private generatePIN(): string {
    return Math.floor(100 + Math.random() * 900).toString();
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
          quantity
        ),
        services!cart_items_service_id_fkey (
          id,
          name,
          base_price,
          user_id,
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

    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const shipping = this.calculateShipping(subtotal, items);
    const tax = this.calculateTax(subtotal);
    const escrowFee = this.calculateEscrowFee(subtotal + shipping + tax);
    const total = subtotal + shipping + tax + escrowFee;

    return {
      items,
      subtotal,
      shipping,
      tax,
      escrowFee,
      total,
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
          quantity
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
    }));

    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const shipping = this.calculateShipping(subtotal, items);
    const tax = this.calculateTax(subtotal);
    const escrowFee = this.calculateEscrowFee(subtotal + shipping + tax);
    const total = subtotal + shipping + tax + escrowFee;

    return {
      items,
      subtotal,
      shipping,
      tax,
      escrowFee,
      total,
    };
  }

  // Get direct checkout summary for single product purchase
  async getDirectCheckoutSummary(userId: string, productId: string, quantity: number, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get product details
    const { data: product, error: productError } = await client
      .from('products')
      .select('id, name, price, user_id, category_id, quantity')
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

    const subtotal = product.price * quantity;
    const shipping = this.calculateShipping(subtotal, items);
    const tax = this.calculateTax(subtotal);
    const escrowFee = this.calculateEscrowFee(subtotal + shipping + tax);
    const total = subtotal + shipping + tax + escrowFee;

    return {
      items,
      subtotal,
      shipping,
      tax,
      escrowFee,
      total,
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
    if (auction.winner_id !== userId) {
      throw new HttpException('You are not the winner of this auction', HttpStatus.FORBIDDEN);
    }

    // Verify auction is ended (check end_time instead of time_status which is a computed field)
    const now = new Date();
    const endTime = new Date(auction.end_time);
    if (endTime > now) {
      throw new HttpException('Auction has not ended yet', HttpStatus.BAD_REQUEST);
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

    const items = [{
      id: auction.id,
      name: auction.title,
      price: auction.winning_bid,
      quantity: 1,
      sellerId: auction.seller_id,
      requiresEscrow: true, // Auctions always use escrow
      imageUrl: auction.thumbnail_url,
      itemType: 'auction',
    }];

    const subtotal = auction.winning_bid;
    const shipping = this.calculateShipping(subtotal, items);
    const tax = this.calculateTax(subtotal);
    const commissionFee = Math.round(subtotal * (auction.commission_rate / 100));
    const escrowFee = this.calculateEscrowFee(subtotal + shipping + tax);
    const total = subtotal + shipping + tax + escrowFee;

    return {
      items,
      subtotal,
      shipping,
      tax,
      escrowFee,
      commissionFee,
      commissionRate: auction.commission_rate,
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

    // Validate payment method and balance if wallet
    if (orderData.paymentMethodId === 'wallet') {
      const { data: wallet } = await client
        .from('wallets')
        .select('available_balance')
        .eq('user_id', userId)
        .single();

      // Calculate actual total with rider pricing
      let actualTotal = summary.total;
      if (orderData.selectedRider) {
        if (orderData.selectedRider.riderId === 'pickup') {
          actualTotal = summary.subtotal + summary.tax + (orderData.useEscrow ? summary.escrowFee : 0);
        } else {
          actualTotal = summary.subtotal + orderData.selectedRider.deliveryPrice + summary.tax + 
                       (orderData.useEscrow ? summary.escrowFee : 0);
        }
      }

      if (!wallet || wallet.available_balance < actualTotal) {
        throw new HttpException('Insufficient wallet balance', HttpStatus.BAD_REQUEST);
      }
    }

    // Generate order number
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    // Handle selected rider
    let actualDeliveryFee = summary.shipping;
    let riderId = null;
    
    if (orderData.selectedRider) {
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
    } else if (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) {
      orderSource = 'wishlist';
    } else if (orderData.directCheckout) {
      orderSource = 'regular';
    }

    // Log delivery type detection
    console.log('🚚 [DEBUG] Delivery type detection:', {
      hasSelectedRider: !!orderData.selectedRider,
      selectedRider: orderData.selectedRider,
      selectedRiderRiderId: orderData.selectedRider?.riderId,
      isPickup: orderData.selectedRider?.riderId === 'pickup',
      calculatedRiderId: riderId,
      deliveryType: orderData.selectedRider?.riderId === 'pickup' ? 'pickup' : 'delivery'
    });

    // Create order with correct schema
    const orderToInsert = {
      buyer_id: userId,              // ✅ Correct column name
      vendor_id: vendorId,           // ✅ Required field
      order_number: orderNumber,
      status: 'pending',             // ✅ Start as pending so vendor can accept
      escrow_enabled: orderData.useEscrow || false,  // ✅ Correct column name
      total_amount: actualTotal,
      delivery_fee: actualDeliveryFee,  // ✅ Correct column name
      platform_fee: actualTotal * 0.02, // 2% platform fee
      rider_id: riderId,
      delivery_type: orderData.selectedRider?.riderId === 'pickup' ? 'pickup' : 'delivery',
      delivery_address: {
        fullName: orderData.deliveryAddress.fullName,
        phone: orderData.deliveryAddress.phone,
        address: orderData.deliveryAddress.address,
        city: orderData.deliveryAddress.city,
        state: orderData.deliveryAddress.state,
        postalCode: orderData.deliveryAddress.postalCode,
      },
      delivery_instructions: orderData.deliveryInstructions,
      estimated_delivery: riderId ? 
        new Date(Date.now() + (orderData.selectedRider?.estimatedArrival || 30) * 60 * 1000).toISOString() :
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours for pickup
      rider_info: orderData.selectedRider ? {
        riderId: orderData.selectedRider.riderId,
        riderName: orderData.selectedRider.riderName,
        vehicleType: orderData.selectedRider.vehicleType,
        deliveryPrice: orderData.selectedRider.deliveryPrice,
        estimatedArrival: orderData.selectedRider.estimatedArrival,
      } : null,
      source: orderSource,  // ✅ Track order source
      metadata: {
        // Store additional details in metadata JSONB
        subtotal: summary.subtotal,
        tax_amount: summary.tax,
        escrow_fee: orderData.useEscrow ? summary.escrowFee : 0,
        payment_method: orderData.paymentMethodId,
        original_shipping: summary.shipping,
        // Add auction_id to metadata for easier querying
        ...(isAuctionOrder && orderData.auctionCheckout ? {
          auction_id: orderData.auctionCheckout.auctionId,
        } : {}),
        // Add wishlist_item_ids to metadata for cleanup
        ...(orderSource === 'wishlist' && orderData.wishlistItemIds ? {
          wishlist_item_ids: orderData.wishlistItemIds,
        } : {}),
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: order, error: orderError } = await client
      .from('orders')
      .insert(orderToInsert)
      .select()
      .single();

    if (orderError) {
      console.error('Order creation error:', orderError);
      throw new HttpException('Failed to create order', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Create order items - handle BOTH products AND services AND auctions
    const orderItems = summary.items.map(item => {
      const isService = item.itemType === 'service';
      const isAuction = item.itemType === 'auction';
      
      return {
        order_id: order.id,
        product_id: isService || isAuction ? null : item.id,
        service_id: isService ? item.id : null,
        product_name: item.name,
        category: item.category || 'General',  // ✅ Store category for countdown calculation
        quantity: item.quantity,
        unit_price: item.price,
        total_price: item.price * item.quantity,
        scheduled_date: isService ? item.serviceDate : null,
        scheduled_time: isService ? item.serviceTime : null,
        service_notes: isService ? item.serviceNotes : null,
        product_metadata: isAuction ? {
          auction_id: orderData.auctionCheckout?.auctionId,
          auction_lot: item.product_metadata?.auction_lot,
          description: item.product_metadata?.description,
        } : null,
        created_at: new Date().toISOString(),
      };
    });

    const { error: itemsError } = await client
      .from('order_items')
      .insert(orderItems);

    if (itemsError) {
      console.error('Order items creation error:', itemsError);
      // Try to rollback order creation
      await client.from('orders').delete().eq('id', order.id);
      throw new HttpException('Failed to create order items', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // ✅ HANDLE REWARDS REDEMPTION
    let rewardsUsed = 0;
    let finalPaymentAmount = actualTotal;

    if (orderData.useRewards && orderData.rewardsAmount > 0) {
      console.log(`🎁 User wants to use ${orderData.rewardsAmount} rewards for order ${order.id}`);
      
      try {
        // Verify user has sufficient rewards
        const rewardsBalance = await this.rewardsService.getUserRewardsBalance(userId);
        if (!rewardsBalance || rewardsBalance.available_rewards < orderData.rewardsAmount) {
          throw new HttpException(
            `Insufficient rewards balance. Available: ${rewardsBalance?.available_rewards || 0}, Requested: ${orderData.rewardsAmount}`,
            HttpStatus.BAD_REQUEST
          );
        }
        
        // Redeem rewards
        const redemptionResult = await this.rewardsService.redeemRewards(
          userId,
          orderData.rewardsAmount,
          order.id
        );
        
        if (!redemptionResult.success) {
          throw new HttpException('Failed to redeem rewards', HttpStatus.INTERNAL_SERVER_ERROR);
        }
        
        rewardsUsed = orderData.rewardsAmount;
        finalPaymentAmount = Math.max(0, actualTotal - rewardsUsed);
        
        console.log(`✅ Redeemed ${rewardsUsed} rewards for order ${order.id}`);
        console.log(`💰 Final payment amount: ${finalPaymentAmount} (original: ${actualTotal})`);
      } catch (rewardsError) {
        console.error('Rewards redemption error:', rewardsError);
        // Rollback order creation
        await client.from('orders').delete().eq('id', order.id);
        throw rewardsError;
      }
    }

    // Update order with rewards used
    if (rewardsUsed > 0) {
      const { error: updateError } = await client
        .from('orders')
        .update({ 
          rewards_used: rewardsUsed,
          updated_at: new Date().toISOString()
        })
        .eq('id', order.id);
      
      if (updateError) {
        console.error('Failed to update order with rewards_used:', updateError);
        // Non-critical, continue with order
      }
    }

    // Process payment if wallet (use final amount after rewards discount)
    if (orderData.paymentMethodId === 'wallet') {
      await this.processWalletPayment(userId, order.id, finalPaymentAmount, vendorId, riderId, client);
    }

    // ✅ Mark invoice as paid if this order came from an invoice (after payment is processed)
    if (order.source === 'invoice' && order.metadata?.invoiceId) {
      try {
        await this.invoiceService.markInvoiceAsPaid(order.metadata.invoiceId, order.id);
        console.log(`✅ Invoice ${order.metadata.invoiceId} marked as paid after payment processing`);
      } catch (error) {
        console.error('Failed to mark invoice as paid:', error);
        // Don't throw - invoice marking is not critical to payment processing
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

    // Update product stock (only for products, not services, and not auctions)
    if (!isAuctionOrder) {
      for (const item of summary.items) {
        // Skip services - they don't have stock
        if (item.itemType === 'service') {
          continue;
        }
        
        // Fetch current quantity for products
        const { data: product } = await client
          .from('products')
          .select('quantity')
          .eq('id', item.id)
          .single();

        if (product) {
          const newQuantity = Math.max(0, product.quantity - item.quantity);
          
          await client
            .from('products')
            .update({
              quantity: newQuantity,
              updated_at: new Date().toISOString(),
            })
            .eq('id', item.id);
        }
      }
    }

    // Handle auction-specific logic
    if (isAuctionOrder && orderData.auctionCheckout) {
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
        const escrowBreakdown = this.calculateEscrowBreakdown(actualTotal, riderId);
        await this.notificationHelper.notifyVendorOrderPaid(vendorId, {
          orderId: order.id,
          orderNumber: order.order_number,
          vendorAmount: escrowBreakdown.vendorAmount,
          escrowId: order.id, // Escrow uses order_id as reference
        });
        console.log(`✅ Vendor ${vendorId} notified of payment in escrow`);
      } catch (notifyError) {
        console.error('Failed to notify vendor of payment (non-critical):', notifyError);
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
    const result = await this.walletService.processWalletTransaction(
      userId,
      WalletTransactionType.PURCHASE_HOLD,
      amount,
      `Payment for order ${orderId}`,
      orderId,
      'order',
    );

    if (!result.success) {
      console.error('❌ Wallet transaction failed:', result.error);
      throw new HttpException(
        result.error || 'Payment processing failed',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    console.log(`✅ Wallet payment processed successfully:`, {
      transactionId: result.transactionId,
    });

    // ✅ Payment processed - money now in escrow
    // Status stays 'pending' so vendor can accept the order
    // (Don't change status to 'paid' - vendor needs to accept first)

    // ✅ GENERATE HANDOFF PINS (3-digit)
    // For self-pickup: only delivery PIN needed (buyer shows to vendor)
    // For regular delivery: both PINs needed (pickup PIN for rider→vendor, delivery PIN for rider→buyer)
    const pickupPin = Math.floor(100 + Math.random() * 900).toString(); // 3-digit (100-999)
    const deliveryPin = Math.floor(100 + Math.random() * 900).toString(); // 3-digit (100-999)
    
    await client
      .from('orders')
      .update({
        pickup_pin: pickupPin,
        delivery_pin: deliveryPin,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);
    
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
      const escrowBreakdown = this.calculateEscrowBreakdown(amount, riderId);
      const escrow = await this.escrowService.createEscrow(orderId, escrowBreakdown);
      console.log(`✅ Escrow created for order ${orderId}: ₣${amount}`);
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

  // Calculate escrow breakdown (platform fee: 2%, delivery fee: 10% if rider)
  // ✅ FIX: Round amounts to 6 decimal places (matching DECIMAL(18,6)) and validate sum
  private calculateEscrowBreakdown(
    totalAmount: number,
    riderId: string | null,
  ): { totalAmount: number; vendorAmount: number; riderAmount: number; platformAmount: number } {
    // Helper function to round to 6 decimal places (matching DECIMAL(18,6) precision)
    const round6 = (value: number): number => Math.round(value * 1000000) / 1000000;

    const platformFee = round6(totalAmount * 0.02); // 2% platform fee
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

  // Create single order within a group
  private async createSingleOrderInGroup(
    userId: string,
    orderGroupId: string,
    vendorGroup: any,
    riderAssignment: any,
    orderData: any,
    sequence: number,
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    
    const orderToInsert = {
      buyer_id: userId,
      vendor_id: vendorGroup.vendorId,
      order_number: orderNumber,
      status: 'pending',
      escrow_enabled: orderData.useEscrow || false,
      total_amount: vendorGroup.subtotal,
      delivery_fee: riderAssignment.pricing.total / riderAssignment.vendorIds.length, // Split delivery fee
      platform_fee: vendorGroup.subtotal * 0.02, // 2% platform fee
      rider_id: riderAssignment.rider.id,
      delivery_type: 'delivery',
      delivery_address: orderData.deliveryAddress,
      delivery_instructions: orderData.deliveryInstructions,
      estimated_delivery: new Date(Date.now() + riderAssignment.route.estimatedTime * 60 * 1000).toISOString(),
      rider_info: {
        riderId: riderAssignment.rider.id,
        riderName: riderAssignment.rider.name,
        vehicleType: riderAssignment.vehicleType,
        deliveryPrice: riderAssignment.pricing.total / riderAssignment.vendorIds.length,
        estimatedArrival: riderAssignment.route.estimatedTime,
        multiStop: riderAssignment.vendorIds.length > 1,
        stopSequence: riderAssignment.vendorIds.indexOf(vendorGroup.vendorId) + 1,
      },
      source: (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) ? 'wishlist' : 'regular',
      pickup_pin: this.generatePIN(),
      delivery_pin: this.generatePIN(),
      order_group_id: orderGroupId,
      is_grouped: true,
      group_sequence: sequence,
      metadata: {
        // Add wishlist_item_ids to metadata for cleanup (only for wishlist orders)
        ...(orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0 ? {
          wishlist_item_ids: orderData.wishlistItemIds,
        } : {}),
      },
    };
    
    const { data: order, error } = await client
      .from('orders')
      .insert(orderToInsert)
      .select()
      .single();
      
    if (error) throw new HttpException('Failed to create order in group', HttpStatus.INTERNAL_SERVER_ERROR);
    
    // Create order items - handle BOTH products AND services
    const orderItems = vendorGroup.items.map(item => {
      const isService = item.itemType === 'service';
      
      return {
        order_id: order.id,
        product_id: isService ? null : item.id,
        service_id: isService ? item.id : null,
        product_name: item.name,
        category: item.category || 'General',  // ✅ Store category for countdown calculation
        quantity: item.quantity,
        unit_price: item.price,
        total_price: item.price * item.quantity,
        scheduled_date: isService ? item.serviceDate : null,
        scheduled_time: isService ? item.serviceTime : null,
        service_notes: isService ? item.serviceNotes : null,
      };
    });
    
    await client.from('order_items').insert(orderItems);
    
    // Update stock - only for products, not services
    for (const item of vendorGroup.items) {
      // Skip services
      if (item.itemType === 'service') {
        continue;
      }
      
      await client.rpc('decrement_product_stock', {
        p_product_id: item.id,
        p_quantity: item.quantity,
      });
    }
    
    return order;
  }

  // Deduct wallet balance for entire group
  private async deductWalletForGroup(
    userId: string,
    totalAmount: number,
    orderGroupId: string,
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    
    // Get wallet ID first
    const { data: walletData } = await client
      .from('wallets')
      .select('id, available_balance')
      .eq('user_id', userId)
      .single();

    if (!walletData) {
      throw new HttpException('Wallet not found', HttpStatus.NOT_FOUND);
    }

    // Deduct from wallet
    const { error: walletError } = await client
      .from('wallets')
      .update({
        available_balance: walletData.available_balance - totalAmount,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
      
    if (walletError) throw new HttpException('Failed to deduct wallet balance', HttpStatus.INTERNAL_SERVER_ERROR);
    
    // Log transaction in wallet_ledger
    await client.from('wallet_ledger').insert({
      wallet_id: walletData.id,
      transaction_type: 'purchase_hold',
      amount: totalAmount,
      balance_after: walletData.available_balance - totalAmount,
      description: `Multi-vendor order group payment`,
      reference_id: orderGroupId,
      reference_type: 'order_group',
    });
  }

  // Create grouped order (main method)
  async createGroupedOrder(userId: string, orderData: any, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    
    let orderGroupId = null;
    let createdOrderIds: string[] = [];
    let walletDeducted = false;
    let totalAmount = 0; // Define outside try block for rollback access
    
    try {
      // Get cart summary OR wishlist summary
      let summary;
      if (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) {
        // ✅ Handle wishlist source for grouped orders
        console.log('💖 Backend createGroupedOrder - Wishlist checkout with itemIds:', orderData.wishlistItemIds);
        summary = await this.getWishlistCheckoutSummary(
          userId,
          orderData.wishlistItemIds,
          userToken,
        );
      } else {
        summary = await this.getCheckoutSummary(userId, userToken);
      }
      
      // Group items by vendor (sellerId)
      const vendorGroups = this.groupItemsByVendor(summary.items);
      
      if (vendorGroups.length === 1) {
        // Single vendor - use existing flow
        return this.createOrder(userId, orderData, userToken);
      }
      
      // Multi-vendor flow
      // 1. Generate group number
      const groupNumber = `GRP-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
      
      // 2. Calculate total across all vendors
      totalAmount = summary.subtotal + summary.tax + orderData.totalRiderFee + 
                   (orderData.useEscrow ? summary.escrowFee : 0);
      
      // 3. Validate wallet balance (single deduction for entire group)
      const { data: wallet } = await client
        .from('wallets')
        .select('available_balance')
        .eq('user_id', userId)
        .single();
        
      if (!wallet || wallet.available_balance < totalAmount) {
        throw new HttpException('Insufficient wallet balance', HttpStatus.BAD_REQUEST);
      }
      
      // 4. Create order group record
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
      
      // 5. Create individual orders for each vendor
      const orders: any[] = [];
      for (let i = 0; i < vendorGroups.length; i++) {
        const group = vendorGroups[i];
        const riderAssignment = orderData.riderAssignments[i]; // From rider optimization
        
        const order = await this.createSingleOrderInGroup(
          userId,
          orderGroup.id,
          group,
          riderAssignment,
          orderData,
          i + 1, // sequence
          userToken
        );
        
        orders.push(order);
        createdOrderIds.push(order.id);
      }
      
      // 6. Deduct wallet balance ONCE for entire group
      await this.deductWalletForGroup(userId, totalAmount, orderGroup.id, userToken);
      walletDeducted = true;
      
      // 7. Create escrows per vendor if enabled
      if (orderData.useEscrow) {
        for (const order of orders) {
          const breakdown = {
            totalAmount: order.total_amount,
            vendorAmount: order.total_amount - order.delivery_fee - order.platform_fee,
            riderAmount: order.delivery_fee,
            platformAmount: order.platform_fee,
          };
          await this.escrowService.createEscrow(order.id, breakdown);
        }
      }
      
      // 8. Send notifications to all vendors and riders
      try {
        for (const order of orders) {
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
        console.warn('⚠️ Notification sending failed (non-critical):', notifError);
      }
      
      // ✅ Remove purchased items from wishlist after grouped order creation
      if (orderData.wishlistItemIds && orderData.wishlistItemIds.length > 0) {
        try {
          await this.wishlistService.removePurchasedItems(
            userId,
            orderData.wishlistItemIds,
            userToken,
          );
          console.log(`✅ Removed ${orderData.wishlistItemIds.length} items from wishlist after grouped order creation`);
        } catch (error) {
          console.error('Failed to remove wishlist items (non-critical):', error);
          // Don't throw - wishlist cleanup is not critical to order creation
        }
      }
      
      return {
        orderGroup: orderGroup,
        orders: orders,
      };
      
    } catch (error) {
      console.error('❌ Grouped order creation failed, rolling back:', error);
      
      // Rollback: Delete created orders
      if (createdOrderIds.length > 0) {
        await client.from('orders').delete().in('id', createdOrderIds);
        await client.from('order_items').delete().in('order_id', createdOrderIds);
      }
      
      // Rollback: Delete order group
      if (orderGroupId) {
        await client.from('order_groups').delete().eq('id', orderGroupId);
      }
      
      // Rollback: Refund wallet if deducted using helper function
      if (walletDeducted) {
        try {
          const refundResult = await this.walletService.processWalletTransaction(
            userId,
            WalletTransactionType.ESCROW_REFUND,
            totalAmount,
            `Refund for failed order group creation`,
            orderGroupId || undefined,
            'order_group',
          );

          if (!refundResult.success) {
            console.error('❌ Failed to refund wallet during rollback:', refundResult.error);
          } else {
            console.log('✅ Wallet refunded during rollback:', refundResult.transactionId);
          }
        } catch (refundError) {
          console.error('❌ Error during wallet refund rollback:', refundError);
        }
      }
      
      throw error;
    }
  }
}