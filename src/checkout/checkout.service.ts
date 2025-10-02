import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class CheckoutService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  // Get checkout summary from user's cart
  async getCheckoutSummary(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get cart items with product details
    const { data: cartItems, error: cartError } = await client
      .from('cart_items')
      .select(`
        id,
        quantity,
        products!cart_items_product_id_fkey (
          id,
          name,
          price,
          user_id,
          category_id,
          quantity
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

    // Calculate summary
    const items = cartItems.map(item => ({
      id: item.products.id,
      name: item.products.name,
      price: item.products.price,
      quantity: item.quantity,
      sellerId: item.products.user_id,
      requiresEscrow: false,
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
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get auction details
    const { data: auction, error: auctionError } = await client
      .from('auctions')
      .select(`
        id,
        title,
        winning_bid,
        winner_id,
        seller_id,
        status,
        time_status,
        commission_rate,
        thumbnail_url
      `)
      .eq('id', auctionId)
      .single();

    if (auctionError || !auction) {
      throw new HttpException('Auction not found', HttpStatus.NOT_FOUND);
    }

    // Verify user is the winner
    if (auction.winner_id !== userId) {
      throw new HttpException('You are not the winner of this auction', HttpStatus.FORBIDDEN);
    }

    // Verify auction is ended
    if (auction.time_status !== 'ended') {
      throw new HttpException('Auction has not ended yet', HttpStatus.BAD_REQUEST);
    }

    // Check if already paid
    const { data: existingSale } = await client
      .from('auction_sales')
      .select('payment_status')
      .eq('auction_id', auctionId)
      .single();

    if (existingSale?.payment_status === 'paid') {
      throw new HttpException('Auction already paid for', HttpStatus.BAD_REQUEST);
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
    } else if (orderData.directCheckout) {
      // Direct product checkout
      summary = await this.getDirectCheckoutSummary(
        userId,
        orderData.directCheckout.productId,
        orderData.directCheckout.quantity,
        userToken,
      );
    } else {
      // Cart checkout
      summary = await this.getCheckoutSummary(userId, userToken);
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

    // Create order
    const orderToInsert = {
      user_id: userId,
      order_number: orderNumber,
      status: 'pending',
      payment_method: orderData.paymentMethodId,
      use_escrow: orderData.useEscrow || false,
      subtotal: summary.subtotal,
      shipping_cost: actualDeliveryFee,
      tax_amount: summary.tax,
      escrow_fee: orderData.useEscrow ? summary.escrowFee : 0,
      total_amount: actualTotal,
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

    // Create order items
    const orderItems = summary.items.map(item => ({
      order_id: order.id,
      product_id: item.id,
      product_name: item.name,
      quantity: item.quantity,
      unit_price: item.price,
      total_price: item.price * item.quantity,
      created_at: new Date().toISOString(),
    }));

    const { error: itemsError } = await client
      .from('order_items')
      .insert(orderItems);

    if (itemsError) {
      console.error('Order items creation error:', itemsError);
      // Try to rollback order creation
      await client.from('orders').delete().eq('id', order.id);
      throw new HttpException('Failed to create order items', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Process payment if wallet
    if (orderData.paymentMethodId === 'wallet') {
      await this.processWalletPayment(userId, order.id, actualTotal, client);
    }

    // Clear cart if not direct checkout
    if (!orderData.directCheckout) {
      await client
        .from('cart_items')
        .delete()
        .eq('user_id', userId);
    }

    // Update product stock (only for non-auction orders)
    if (!isAuctionOrder) {
      for (const item of summary.items) {
        await client
          .from('products')
          .update({
            quantity: client.raw(`quantity - ${item.quantity}`),
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);
      }
    }

    // Handle auction-specific logic
    if (isAuctionOrder && orderData.auctionCheckout) {
      // Create auction sale record
      await client
        .from('auction_sales')
        .upsert({
          auction_id: orderData.auctionCheckout.auctionId,
          seller_id: summary.sellerId,
          buyer_id: userId,
          final_bid_amount: summary.subtotal,
          commission_amount: summary.commissionFee || 0,
          total_amount: summary.total,
          payment_status: 'paid',
          order_id: order.id,
        });

      // Update auction status
      await client
        .from('auctions')
        .update({
          payment_status: 'paid',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderData.auctionCheckout.auctionId);
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

  // Calculate escrow fee (2.5% with minimum of ₦50)
  calculateEscrowFee(amount: number): number {
    return Math.max(50, Math.round(amount * 0.025));
  }

  // Calculate shipping cost
  private calculateShipping(subtotal: number, items: any[]): number {
    // Free shipping for orders over ₦10,000
    if (subtotal >= 10000) {
      return 0;
    }

    // Base shipping rate of ₦500
    return 500;
  }

  // Calculate tax (7.5% VAT)
  private calculateTax(subtotal: number): number {
    return Math.round(subtotal * 0.075);
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
  private async processWalletPayment(userId: string, orderId: string, amount: number, client: any) {
    // Deduct from wallet
    const { error: deductError } = await client
      .from('wallets')
      .update({
        available_balance: client.raw(`available_balance - ${amount}`),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    if (deductError) {
      console.error('Wallet deduction error:', deductError);
      throw new HttpException('Payment processing failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Create transaction record
    const { error: transactionError } = await client
      .from('wallet_transactions')
      .insert({
        user_id: userId,
        type: 'debit',
        amount: amount,
        description: `Payment for order ${orderId}`,
        reference: orderId,
        status: 'completed',
        created_at: new Date().toISOString(),
      });

    if (transactionError) {
      console.error('Transaction record error:', transactionError);
      // Note: We don't throw here as the payment already went through
    }

    // Update order status
    await client
      .from('orders')
      .update({
        status: 'confirmed',
        payment_status: 'paid',
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);
  }
}