import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class CartService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async getCartItems(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('cart_items')
      .select(`
        *,
        products (
          name,
          price,
          images,
          quantity,
          user_id,
          user_profiles (
            username
          ),
          product_categories (
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

    // Transform data to match frontend expectations
    return data?.map(item => ({
      id: item.id,
      productId: item.product_id,
      productName: item.products?.name || 'Unknown Product',
      productImage: item.products?.images?.[0] || item.products?.primary_image_url || 'https://via.placeholder.com/150',
      price: item.price_at_add,
      originalPrice: item.products?.price || null, // Show original price from products table
      quantity: item.quantity,
      maxQuantity: item.products?.quantity || 999, // Use 'quantity' not 'max_quantity'
      sellerId: item.products?.user_id,
      sellerName: item.products?.user_profiles?.username || 'Unknown Seller',
      category: item.products?.product_categories?.name || 'Uncategorized',
      createdAt: item.created_at,
    })) || [];
  }

  async getCartSummary(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('cart_items')
      .select('quantity, price_at_add')
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to fetch cart summary: ${error.message}`);
    }

    const itemsCount = data?.length || 0;
    const subtotal = data?.reduce((sum, item) => sum + (item.price_at_add * item.quantity), 0) || 0;
    
    // Calculate shipping, tax, and discounts
    const shipping = subtotal > 50000 ? 0 : 2500; // Free shipping over ₦50,000
    const tax = subtotal * 0.075; // 7.5% VAT
    const discount = 0; // Add discount logic as needed
    const total = subtotal + shipping + tax - discount;

    return {
      itemsCount,
      subtotal,
      discount,
      shipping,
      tax,
      total,
    };
  }

  async getCartCount(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { count, error } = await client
      .from('cart_items')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to fetch cart count: ${error.message}`);
    }

    return { count: count || 0 };
  }

  async addToCart(userId: string, cartData: { productId: string; quantity: number; price: number }, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Check if product exists and get its info
    const { data: product, error: productError } = await client
      .from('products')
      .select('id, name, quantity, price')
      .eq('id', cartData.productId)
      .eq('status', 'active')
      .single();

    if (productError || !product) {
      throw new NotFoundException('Product not found or not available');
    }

    // Check if item already exists in cart
    const { data: existingItem } = await client
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

      const { error: updateError } = await client
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

      const { error: insertError } = await client
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
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than 0');
    }

    // Verify the cart item belongs to the user
    const { data: cartItem, error: fetchError } = await client
      .from('cart_items')
      .select(`
        *,
        products (
          quantity
        )
      `)
      .eq('id', itemId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !cartItem) {
      throw new NotFoundException('Cart item not found');
    }

    // Check stock availability
    if (quantity > cartItem.products.quantity) {
      throw new BadRequestException(`Only ${cartItem.products.quantity} items available in stock`);
    }

    const { error: updateError } = await client
      .from('cart_items')
      .update({ quantity })
      .eq('id', itemId);

    if (updateError) {
      throw new Error(`Failed to update cart item quantity: ${updateError.message}`);
    }

    return { message: 'Cart item quantity updated' };
  }

  async removeItem(userId: string, itemId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { error } = await client
      .from('cart_items')
      .delete()
      .eq('id', itemId)
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to remove cart item: ${error.message}`);
    }

    return { message: 'Cart item removed' };
  }

  async clearCart(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { error } = await client
      .from('cart_items')
      .delete()
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to clear cart: ${error.message}`);
    }

    return { message: 'Cart cleared' };
  }

  async validateCart(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data: cartItems, error } = await client
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
}