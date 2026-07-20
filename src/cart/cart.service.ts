import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient, createSupabaseClient } from '../shared/supabase.client';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';

@Injectable()
export class CartService {
  private supabase;
  private serviceSupabase;

  constructor(
    private configService: ConfigService,
    private clientManager: SupabaseClientManager,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.serviceSupabase = this.clientManager.getServiceClient();
  }

  async getCartItems(userId: string, userToken?: string) {
    const { data, error } = await this.serviceSupabase
      .from('cart_items')
      .select(`
        *,
        products (
          name,
          price,
          images,
          quantity,
          location,
          user_id,
          user_profiles (
            username,
            location
          ),
          product_categories (
            name
          )
        ),
        services (
          name,
          base_price,
          images,
          location,
          user_id,
          user_profiles (
            username,
            location
          ),
          service_categories (
            name
          )
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Cart items query error:', error);
      throw new Error(`Failed to fetch cart items: ${error.message}`);
    }

    console.log('📱 Cart items query result:', {
      count: data?.length || 0,
      firstItem: data?.[0] || null,
      userId
    });

    // Helpers for location parsing and interstate detection
    const parseItemLocation = (location?: string | null): { state?: string; country?: string; city?: string } | null => {
      if (!location || typeof location !== 'string') return null;
      const parts = location.split(',').map(p => p.trim());
      if (parts.length >= 3) return { city: parts[0], state: parts[1], country: parts[2] };
      if (parts.length === 2) return { state: parts[0], country: parts[1] };
      if (parts.length === 1) return { state: parts[0] };
      return null;
    };

    const detectInterstate = (
      sellerLocation: { state?: string; country?: string; city?: string } | null | undefined,
      buyerState?: string,
      buyerCountry?: string,
    ) => {
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
    };

    // Fetch buyer's default delivery address for interstate detection
    const { data: buyerDefaultAddress } = await this.serviceSupabase
      .from('delivery_addresses')
      .select('state, country')
      .eq('user_id', userId)
      .eq('is_default', true)
      .maybeSingle();

    const buyerState = buyerDefaultAddress?.state || undefined;
    const buyerCountry = buyerDefaultAddress?.country || undefined;

    // Transform data to match frontend expectations
    return (data || []).map(item => {
      const isService = !!item.service_id;

      const productLoc = isService
        ? parseItemLocation(item.services?.location) || item.services?.user_profiles?.location
        : parseItemLocation(item.products?.location) || item.products?.user_profiles?.location;
      const { isOutOfState, isOutOfCountry } = detectInterstate(productLoc, buyerState, buyerCountry);

      if (isService) {
        // Service item
        return {
          id: item.id,
          serviceId: item.service_id,
          productName: item.services?.name || 'Unknown Service',
          productImage: item.services?.images?.[0] || 'https://via.placeholder.com/150',
          price: item.price_at_add,
          originalPrice: item.services?.base_price || null,
          quantity: item.quantity,
          maxQuantity: 1,
          sellerId: item.services?.user_id,
          sellerName: item.services?.user_profiles?.username || 'Unknown Provider',
          category: item.services?.service_categories?.name || 'Services',
          sellerLocation: productLoc,
          isOutOfState,
          isOutOfCountry,
          serviceDate: item.scheduled_date,
          serviceTime: item.scheduled_time,
          serviceNotes: item.service_notes,
          createdAt: item.created_at,
        };
      } else {
        // Product item
        return {
          id: item.id,
          productId: item.product_id,
          productName: item.products?.name || 'Unknown Product',
          productImage: item.products?.images?.[0] || item.products?.primary_image_url || 'https://via.placeholder.com/150',
          price: item.price_at_add,
          originalPrice: item.products?.price || null,
          quantity: item.quantity,
          maxQuantity: item.products?.quantity || 999,
          sellerId: item.products?.user_id,
          sellerName: item.products?.user_profiles?.username || 'Unknown Seller',
          category: item.products?.product_categories?.name || 'Uncategorized',
          sellerLocation: productLoc,
          isOutOfState,
          isOutOfCountry,
          createdAt: item.created_at,
        };
      }
    });
  }

  async getCartSummary(userId: string, userToken?: string) {
    const { data, error } = await this.serviceSupabase
      .from('cart_items')
      .select('quantity, price_at_add')
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to fetch cart summary: ${error.message}`);
    }

    const itemsCount = data?.length || 0;
    const subtotal = data?.reduce((sum, item) => sum + (item.price_at_add * item.quantity), 0) || 0;
    
    // Cart summary only shows items and subtotal
    // Shipping, tax, and final calculations happen at checkout
    const discount = 0; // Add discount logic as needed
    const total = subtotal - discount; // Cart total = subtotal - discount (no shipping/tax yet)

    return {
      itemsCount,
      subtotal,
      discount,
      shipping: 0, // Not calculated in cart - calculated at checkout
      tax: 0,      // Not calculated in cart - calculated at checkout
      total,
    };
  }

  async getCartCount(userId: string, userToken?: string) {
    const { count, error } = await this.serviceSupabase
      .from('cart_items')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to fetch cart count: ${error.message}`);
    }

    return { count: count || 0 };
  }

  async addToCart(userId: string, cartData: { productId: string; quantity: number; price: number }, userToken?: string) {
    // Check if product exists and get its info
    const { data: product, error: productError } = await this.serviceSupabase
      .from('products')
      .select('id, name, quantity, price')
      .eq('id', cartData.productId)
      .eq('status', 'active')
      .single();

    if (productError || !product) {
      throw new NotFoundException('Product not found or not available');
    }

    // Check if item already exists in cart
    const { data: existingItem } = await this.serviceSupabase
      .from('cart_items')
      .select('id, quantity')
      .eq('user_id', userId)
      .eq('product_id', cartData.productId)
      .single();

    if (existingItem) {
      // Update existing item quantity
      const newQuantity = existingItem.quantity + cartData.quantity;
      
      if (newQuantity > product.quantity) {
        throw new BadRequestException(`Only ${product.quantity} items available in stock`);
      }

      const { error: updateError } = await this.serviceSupabase
        .from('cart_items')
        .update({ 
          quantity: newQuantity,
          price_at_add: cartData.price || product.price // Update price in case it changed
        })
        .eq('id', existingItem.id);

      if (updateError) {
        throw new Error(`Failed to update cart item: ${updateError.message}`);
      }

      return { message: 'Cart item quantity updated' };
    } else {
      // Add new item to cart
      if (cartData.quantity > product.quantity) {
        throw new BadRequestException(`Only ${product.quantity} items available in stock`);
      }

      const { error: insertError } = await this.serviceSupabase
        .from('cart_items')
        .insert({
          user_id: userId,
          product_id: cartData.productId,
          quantity: cartData.quantity,
          price_at_add: cartData.price || product.price,
        });

      if (insertError) {
        throw new Error(`Failed to add item to cart: ${insertError.message}`);
      }

      return { message: 'Item added to cart' };
    }
  }

  async updateQuantity(userId: string, itemId: string, quantity: number, userToken?: string) {
    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than 0');
    }

    const { error: updateError } = await this.serviceSupabase
      .from('cart_items')
      .update({ quantity })
      .eq('id', itemId);

    if (updateError) {
      throw new Error(`Failed to update cart item quantity: ${updateError.message}`);
    }

    return { message: 'Cart item quantity updated' };
  }

  async removeItem(userId: string, itemId: string, userToken?: string) {
    const { error } = await this.serviceSupabase
      .from('cart_items')
      .delete()
      .eq('id', itemId);

    if (error) {
      throw new Error(`Failed to remove cart item: ${error.message}`);
    }

    return { message: 'Cart item removed' };
  }

  async clearCart(userId: string, userToken?: string) {
    const { error } = await this.serviceSupabase
      .from('cart_items')
      .delete()
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to clear cart: ${error.message}`);
    }

    return { message: 'Cart cleared' };
  }

  async validateCart(userId: string, userToken?: string) {
    const { data: cartItems, error } = await this.serviceSupabase
      .from('cart_items')
      .select(`
        *,
        products (
          name,
          quantity,
          status
        )
      `)
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to validate cart: ${error.message}`);
    }

    const errors: string[] = [];
    const unavailableItems: string[] = [];

    cartItems?.forEach(item => {
      const product = item.products;
      
      // Check if product is still active
      if (product.status !== 'active') {
        errors.push(`${product.name} is no longer available`);
        unavailableItems.push(item.id);
      }
      
      // Check stock availability
      if (item.quantity > product.quantity) {
        errors.push(`Only ${product.quantity} units of ${product.name} available (you have ${item.quantity} in cart)`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      unavailableItems,
    };
  }

  async addServiceToCart(userId: string, serviceData: {
    serviceId: string;
    scheduledDate?: string;
    scheduledTime?: string;
    notes?: string;
  }, userToken?: string) {
    // Check if service exists and get its info
    const { data: service, error: serviceError } = await this.serviceSupabase
      .from('services')
      .select('id, name, base_price, status')
      .eq('id', serviceData.serviceId)
      .eq('status', 'active')
      .single();

    if (serviceError || !service) {
      throw new NotFoundException('Service not found or not available');
    }

    // Check if service already exists in cart
    const { data: existingItem } = await this.serviceSupabase
      .from('cart_items')
      .select('id')
      .eq('user_id', userId)
      .eq('service_id', serviceData.serviceId)
      .single();

    if (existingItem) {
      throw new BadRequestException('This service is already in your cart');
    }

    // Add service to cart
    const { error: insertError } = await this.serviceSupabase
      .from('cart_items')
      .insert({
        user_id: userId,
        service_id: serviceData.serviceId,
        quantity: 1, // Services are typically quantity 1
        price_at_add: service.base_price,
        scheduled_date: serviceData.scheduledDate || null,
        scheduled_time: serviceData.scheduledTime || null,
        service_notes: serviceData.notes || null,
      });

    if (insertError) {
      throw new Error(`Failed to add service to cart: ${insertError.message}`);
    }

    return { message: 'Service added to cart' };
  }
}