import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class WishlistService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async getWishlistItems(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('wishlist')
      .select(`
        *,
        products (
          name,
          price,
          images,
          primary_image_url,
          status,
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
      console.error('Wishlist items query error:', error);
      throw new Error(`Failed to fetch wishlist items: ${error.message}`);
    }

    console.log('💖 Wishlist items query result:', {
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
      price: item.products?.price || 0,
      sellerId: item.products?.user_id,
      sellerName: item.products?.user_profiles?.username || 'Unknown Seller',
      category: item.products?.product_categories?.name || 'Uncategorized',
      createdAt: item.created_at,
      isAvailable: item.products?.status === 'active'
    })) || [];
  }

  async addToWishlist(userId: string, wishlistData: { productId: string; productName: string; productImage: string; price: number }, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    console.log('💖 Adding to wishlist for user:', userId, wishlistData);

    // Check if product exists
    const { data: product, error: productError } = await client
      .from('products')
      .select('id, name')
      .eq('id', wishlistData.productId)
      .eq('status', 'active')
      .single();

    if (productError || !product) {
      throw new NotFoundException('Product not found or not available');
    }

    // Check if item already exists in wishlist
    const { data: existingItem } = await client
      .from('wishlist')
      .select('id')
      .eq('user_id', userId)
      .eq('product_id', wishlistData.productId)
      .single();

    if (existingItem) {
      return { message: 'Item already in wishlist' };
    }

    // Add new item to wishlist
    const { error: insertError } = await client
      .from('wishlist')
      .insert({
        user_id: userId,
        product_id: wishlistData.productId,
      });

    if (insertError) {
      console.error('Wishlist insert error:', insertError);
      throw new Error(`Failed to add item to wishlist: ${insertError.message}`);
    }

    return { message: 'Item added to wishlist' };
  }

  async removeFromWishlist(userId: string, productId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    console.log('💖 Removing from wishlist for user:', userId, 'productId:', productId);

    const { error } = await client
      .from('wishlist')
      .delete()
      .eq('user_id', userId)
      .eq('product_id', productId);

    if (error) {
      console.error('Wishlist remove error:', error);
      throw new Error(`Failed to remove item from wishlist: ${error.message}`);
    }

    return { message: 'Item removed from wishlist' };
  }

  async clearWishlist(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { error } = await client
      .from('wishlist')
      .delete()
      .eq('user_id', userId);

    if (error) {
      console.error('Wishlist clear error:', error);
      throw new Error(`Failed to clear wishlist: ${error.message}`);
    }

    return { message: 'Wishlist cleared' };
  }

  async getWishlistCount(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { count, error } = await client
      .from('wishlist')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (error) {
      console.error('Wishlist count error:', error);
      throw new Error(`Failed to fetch wishlist count: ${error.message}`);
    }

    return { count: count || 0 };
  }

  async checkIsInWishlist(userId: string, productId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('wishlist')
      .select('id')
      .eq('user_id', userId)
      .eq('product_id', productId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Wishlist check error:', error);
      throw new Error(`Failed to check wishlist status: ${error.message}`);
    }

    return { isInWishlist: !!data };
  }

  // ============================================
  // WISHLIST SHARING FUNCTIONALITY
  // ============================================

  /**
   * Share wishlist with a friend
   */
  async shareWishlistWithFriend(
    ownerId: string, 
    friendId: string, 
    shareType: 'view_only' | 'view_and_add' = 'view_and_add',
    shareMessage?: string,
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Input validation
    if (!ownerId || !friendId) {
      throw new Error('Owner ID and Friend ID are required');
    }

    if (ownerId === friendId) {
      throw new Error('Cannot share wishlist with yourself');
    }

    // Verify friendship exists
    const { data: connection } = await client
      .from('user_connections')
      .select('id')
      .or(`and(requester_id.eq.${ownerId},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${ownerId})`)
      .eq('status', 'accepted')
      .single();

    if (!connection) {
      throw new Error('You can only share wishlists with connected friends');
    }

    // Check if user has wishlist items to share
    const { count: wishlistCount } = await client
      .from('wishlist')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', ownerId);

    if (wishlistCount === 0) {
      throw new Error('Cannot share an empty wishlist');
    }

    // Create or update share
    const { data, error } = await client
      .from('wishlist_shares')
      .upsert({
        owner_id: ownerId,
        shared_with_id: friendId,
        share_type: shareType,
        share_message: shareMessage,
        is_active: true,
        updated_at: new Date().toISOString()
      }, { 
        onConflict: 'owner_id,shared_with_id',
        ignoreDuplicates: false 
      })
      .select()
      .single();

    if (error) {
      console.error('Wishlist share error:', error);
      throw new Error(`Failed to share wishlist: ${error.message}`);
    }

    return { 
      message: 'Wishlist shared successfully', 
      shareId: data.id,
      shareType: data.share_type,
      canAddItems: data.share_type === 'view_and_add'
    };
  }

  /**
   * Get wishlists shared with user
   */
  async getSharedWishlists(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('shared_wishlists')
      .select('*')
      .eq('shared_with_id', userId)
      .eq('is_active', true)
      .order('shared_at', { ascending: false });

    if (error) {
      console.error('Shared wishlists query error:', error);
      throw new Error(`Failed to fetch shared wishlists: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Get wishlist with collaboration info (for owners and friends)
   */
  async getWishlistWithCollaborators(userId: string, wishlistOwnerId?: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    const targetUserId = wishlistOwnerId || userId; // If viewing friend's wishlist

    const { data, error } = await client
      .from('wishlist_with_collaborators')
      .select('*')
      .eq('user_id', targetUserId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Collaborative wishlist query error:', error);
      throw new Error(`Failed to fetch wishlist: ${error.message}`);
    }

    return data?.map(item => ({
      id: item.id,
      productId: item.product_id,
      productName: item.product_name || 'Unknown Product',
      productImage: item.product_image || 'https://via.placeholder.com/150',
      price: item.product_price || 0,
      notes: item.notes,
      priority: item.priority,
      addedByFriend: item.added_by_friend_name || null,
      collaborationNote: item.collaboration_note,
      createdAt: item.created_at,
      isAvailable: true
    })) || [];
  }

  /**
   * Add item to friend's wishlist (with collaboration tracking)
   */
  async addToFriendWishlist(
    friendUserId: string, 
    productData: { productId: string; productName: string; productImage: string; price: number },
    addedByFriendId: string,
    note?: string,
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Input validation
    if (!friendUserId || !addedByFriendId || !productData?.productId) {
      throw new Error('Friend user ID, added by friend ID, and product ID are required');
    }

    if (friendUserId === addedByFriendId) {
      throw new Error('Cannot add items to your own wishlist through friend collaboration');
    }

    // Verify sharing permission exists
    const { data: sharePermission } = await client
      .from('wishlist_shares')
      .select('share_type, owner_id, shared_with_id')
      .eq('owner_id', friendUserId)
      .eq('shared_with_id', addedByFriendId)
      .eq('is_active', true)
      .single();

    if (!sharePermission) {
      throw new Error('No active wishlist sharing found. Please ask your friend to share their wishlist with you first');
    }

    if (sharePermission.share_type !== 'view_and_add') {
      throw new Error('You only have view-only access to this wishlist. Cannot add items');
    }

    // Check if product exists and is active
    const { data: product, error: productError } = await client
      .from('products')
      .select('id, name, status, user_id')
      .eq('id', productData.productId)
      .single();

    if (productError || !product) {
      throw new NotFoundException('Product not found');
    }

    if (product.status !== 'active') {
      throw new Error('This product is no longer available');
    }

    // Prevent adding own products to friend's wishlist
    if (product.user_id === addedByFriendId) {
      throw new Error('Cannot add your own products to a friend\'s wishlist');
    }

    // Check if item already exists in wishlist
    const { data: existingItem } = await client
      .from('wishlist')
      .select('id, added_by_friend_id')
      .eq('user_id', friendUserId)
      .eq('product_id', productData.productId)
      .single();

    if (existingItem) {
      const addedByText = existingItem.added_by_friend_id 
        ? 'by a friend' 
        : 'by the wishlist owner';
      return { 
        message: `Item already in wishlist (added ${addedByText})`,
        alreadyExists: true
      };
    }

    // Add item to wishlist with collaboration tracking
    const { data, error: insertError } = await client
      .from('wishlist')
      .insert({
        user_id: friendUserId,
        product_id: productData.productId,
        added_by_friend_id: addedByFriendId,
        notes: note
      })
      .select()
      .single();

    if (insertError) {
      console.error('Friend wishlist insert error:', insertError);
      throw new Error(`Failed to add item to friend's wishlist: ${insertError.message}`);
    }

    return { 
      message: 'Item added to friend\'s wishlist successfully', 
      wishlistItemId: data.id,
      collaborationNote: note
    };
  }

  /**
   * Stop sharing wishlist with friend
   */
  async stopSharingWishlist(ownerId: string, friendId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { error } = await client
      .from('wishlist_shares')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('owner_id', ownerId)
      .eq('shared_with_id', friendId);

    if (error) {
      console.error('Stop sharing error:', error);
      throw new Error(`Failed to stop sharing wishlist: ${error.message}`);
    }

    return { message: 'Wishlist sharing stopped' };
  }

  /**
   * Get friends who can be shared with (connected friends)
   */
  async getShareableFriends(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('user_connections')
      .select(`
        id,
        requester_id,
        addressee_id,
        requester:user_profiles!requester_id (
          id, username, avatar_url
        ),
        addressee:user_profiles!addressee_id (
          id, username, avatar_url
        )
      `)
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      .eq('status', 'accepted');

    if (error) {
      console.error('Friends query error:', error);
      throw new Error(`Failed to fetch friends: ${error.message}`);
    }

    // Transform to get friend info (not current user)
    return data?.map(conn => {
      const friend = conn.requester_id === userId ? conn.addressee : conn.requester;
      return {
        id: friend.id,
        username: friend.username,
        fullName: friend.username, // Using username as fullName since full_name doesn't exist
        avatarUrl: friend.avatar_url
      };
    }) || [];
  }

  // ============================================
  // GIFT FUNCTIONALITY
  // ============================================

  /**
   * Mark wishlist item as gift order
   */
  async createGiftOrder(
    giftGiverId: string,
    giftRecipientId: string,
    orderId: string,
    wishlistItemId: string,
    giftMessage?: string,
    isSurprise: boolean = false,
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Input validation
    if (!giftGiverId || !giftRecipientId || !orderId || !wishlistItemId) {
      throw new Error('Gift giver ID, recipient ID, order ID, and wishlist item ID are required');
    }

    if (giftGiverId === giftRecipientId) {
      throw new Error('Cannot create gift order for yourself');
    }

    // Verify the order exists and belongs to the gift giver
    const { data: order, error: orderError } = await client
      .from('orders')
      .select('id, user_id, status, total_amount')
      .eq('id', orderId)
      .eq('user_id', giftGiverId)
      .single();

    if (orderError || !order) {
      throw new Error('Order not found or does not belong to you');
    }

    if (order.status !== 'paid' && order.status !== 'completed') {
      throw new Error('Order must be paid before creating gift record');
    }

    // Verify the wishlist item exists and belongs to the recipient
    const { data: wishlistItem, error: wishlistError } = await client
      .from('wishlist')
      .select(`
        id, 
        user_id, 
        product_id,
        products (
          name, 
          price, 
          status,
          user_id as seller_id
        )
      `)
      .eq('id', wishlistItemId)
      .eq('user_id', giftRecipientId)
      .single();

    if (wishlistError || !wishlistItem) {
      throw new Error('Wishlist item not found or does not belong to recipient');
    }

    if (wishlistItem.products?.status !== 'active') {
      throw new Error('The wishlist item product is no longer available');
    }

    // Verify friendship or sharing permission exists
    const { data: permission } = await client
      .from('wishlist_shares')
      .select('share_type')
      .eq('owner_id', giftRecipientId)
      .eq('shared_with_id', giftGiverId)
      .eq('is_active', true)
      .single();

    const { data: friendship } = await client
      .from('user_connections')
      .select('id')
      .or(`and(requester_id.eq.${giftGiverId},addressee_id.eq.${giftRecipientId}),and(requester_id.eq.${giftRecipientId},addressee_id.eq.${giftGiverId})`)
      .eq('status', 'accepted')
      .single();

    if (!permission && !friendship) {
      throw new Error('You must be friends with the recipient or have access to their shared wishlist to create a gift');
    }

    // Check if gift order already exists for this wishlist item
    const { data: existingGift } = await client
      .from('gift_orders')
      .select('id, status')
      .eq('wishlist_item_id', wishlistItemId)
      .single();

    if (existingGift) {
      throw new Error('A gift order already exists for this wishlist item');
    }

    // Create gift order
    const { data, error } = await client
      .from('gift_orders')
      .insert({
        order_id: orderId,
        gift_giver_id: giftGiverId,
        gift_recipient_id: giftRecipientId,
        wishlist_item_id: wishlistItemId,
        gift_message: giftMessage,
        is_surprise: isSurprise,
        status: 'paid'
      })
      .select(`
        *,
        giver:user_profiles!gift_giver_id (username),
        recipient:user_profiles!gift_recipient_id (username)
      `)
      .single();

    if (error) {
      console.error('Gift order creation error:', error);
      throw new Error(`Failed to create gift order: ${error.message}`);
    }

    return { 
      message: 'Gift order created successfully', 
      giftOrderId: data.id,
      recipientName: data.recipient?.username,
      productName: wishlistItem.products?.name,
      totalAmount: order.total_amount,
      isSurprise: isSurprise
    };
  }

  /**
   * Get gifts received by user
   */
  async getReceivedGifts(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('gift_orders')
      .select(`
        *,
        giver:user_profiles!gift_giver_id (
          username, avatar_url
        ),
        order:orders (
          order_number, status, total_amount
        )
      `)
      .eq('gift_recipient_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Received gifts query error:', error);
      throw new Error(`Failed to fetch received gifts: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Get gifts given by user
   */
  async getGivenGifts(userId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('gift_orders')
      .select(`
        *,
        recipient:user_profiles!gift_recipient_id (
          username, avatar_url
        ),
        order:orders (
          order_number, status, total_amount
        )
      `)
      .eq('gift_giver_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Given gifts query error:', error);
      throw new Error(`Failed to fetch given gifts: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Check if a wishlist item can be purchased as a gift
   */
  async canPurchaseAsGift(
    giftGiverId: string,
    wishlistItemId: string,
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get wishlist item with product and owner info
    const { data: wishlistItem, error: wishlistError } = await client
      .from('wishlist')
      .select(`
        id, 
        user_id, 
        product_id,
        products (
          id,
          name, 
          price, 
          status,
          user_id as seller_id
        ),
        user_profiles (
          username
        )
      `)
      .eq('id', wishlistItemId)
      .single();

    if (wishlistError || !wishlistItem) {
      return {
        canPurchase: false,
        reason: 'Wishlist item not found'
      };
    }

    // Cannot gift to yourself
    if (wishlistItem.user_id === giftGiverId) {
      return {
        canPurchase: false,
        reason: 'Cannot purchase gifts for yourself'
      };
    }

    // Product must be active
    if (wishlistItem.products?.status !== 'active') {
      return {
        canPurchase: false,
        reason: 'Product is no longer available'
      };
    }

    // Check if already gifted
    const { data: existingGift } = await client
      .from('gift_orders')
      .select('id, status')
      .eq('wishlist_item_id', wishlistItemId)
      .single();

    if (existingGift) {
      return {
        canPurchase: false,
        reason: 'This item has already been gifted'
      };
    }

    // Check friendship or sharing permission
    const { data: permission } = await client
      .from('wishlist_shares')
      .select('share_type')
      .eq('owner_id', wishlistItem.user_id)
      .eq('shared_with_id', giftGiverId)
      .eq('is_active', true)
      .single();

    const { data: friendship } = await client
      .from('user_connections')
      .select('id')
      .or(`and(requester_id.eq.${giftGiverId},addressee_id.eq.${wishlistItem.user_id}),and(requester_id.eq.${wishlistItem.user_id},addressee_id.eq.${giftGiverId})`)
      .eq('status', 'accepted')
      .single();

    if (!permission && !friendship) {
      return {
        canPurchase: false,
        reason: 'You must be connected with the recipient or have access to their shared wishlist'
      };
    }

    return {
      canPurchase: true,
      productInfo: {
        id: wishlistItem.products?.id,
        name: wishlistItem.products?.name,
        price: wishlistItem.products?.price,
        sellerId: wishlistItem.products?.seller_id
      },
      recipientInfo: {
        id: wishlistItem.user_id,
        username: wishlistItem.user_profiles?.username,
        fullName: wishlistItem.user_profiles?.username
      }
    };
  }
}