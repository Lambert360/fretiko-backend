import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType, NotificationPriority } from '../notifications/dto/notification.dto';

@Injectable()
export class WishlistService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationsService: NotificationsService
  ) {
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
   * Helper method to check if two users have a relationship (connected or chatting)
   */
  private async checkUserRelationship(
    userId1: string,
    userId2: string,
    client: any
  ): Promise<boolean> {
    // Check for plugged connection (vendor/rider)
    const { data: connection } = await client
      .from('user_connections')
      .select('id')
      .or(`and(requester_id.eq.${userId1},addressee_id.eq.${userId2}),and(requester_id.eq.${userId2},addressee_id.eq.${userId1})`)
      .eq('status', 'accepted')
      .single();

    if (connection) {
      return true;
    }

    // Check for chat conversation
    const { data: user1Participations } = await client
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', userId1);

    if (user1Participations && user1Participations.length > 0) {
      const conversationIds = user1Participations.map(p => p.conversation_id);

      const { data: user2Participations } = await client
        .from('chat_participants')
        .select('conversation_id')
        .eq('user_id', userId2)
        .in('conversation_id', conversationIds);

      if (user2Participations && user2Participations.length > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Share wishlist with any verified user (selective items)
   */
  async shareWishlistWithFriend(
    ownerId: string,
    friendId: string,
    shareType: 'view_only' | 'view_and_add' = 'view_and_add',
    shareMessage?: string,
    selectedItemIds?: string[], // Array of wishlist item IDs to share
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

    // Verify the recipient user exists and is verified
    const { data: recipientUser, error: userError } = await client
      .from('user_profiles')
      .select('id, username')
      .eq('id', friendId)
      .single();

    if (userError || !recipientUser) {
      throw new Error('Recipient user not found or not verified');
    }

    // Check if user has wishlist items to share
    const { count: wishlistCount } = await client
      .from('wishlist')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', ownerId);

    if (wishlistCount === 0) {
      throw new Error('Cannot share an empty wishlist');
    }

    // Verify selected items belong to owner
    if (selectedItemIds && selectedItemIds.length > 0) {
      const { data: itemsCheck } = await client
        .from('wishlist')
        .select('id')
        .eq('user_id', ownerId)
        .in('id', selectedItemIds);

      if (!itemsCheck || itemsCheck.length !== selectedItemIds.length) {
        throw new Error('Some selected items do not belong to your wishlist');
      }
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

    // If selective sharing, add items to shared_wishlist_items table
    if (selectedItemIds && selectedItemIds.length > 0) {
      // First, delete existing shared items for this share (in case of re-share)
      await client
        .from('shared_wishlist_items')
        .delete()
        .eq('wishlist_share_id', data.id);

      // Insert selected items
      const sharedItems = selectedItemIds.map(itemId => ({
        wishlist_share_id: data.id,
        wishlist_item_id: itemId
      }));

      const { error: itemsError } = await client
        .from('shared_wishlist_items')
        .insert(sharedItems);

      if (itemsError) {
        console.error('Error sharing wishlist items:', itemsError);
        throw new Error(`Failed to share wishlist items: ${itemsError.message}`);
      }
    }

    return {
      message: 'Wishlist shared successfully',
      shareId: data.id,
      shareType: data.share_type,
      canAddItems: data.share_type === 'view_and_add',
      sharedItemsCount: selectedItemIds?.length || 0
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
   * Get shared wishlist items for a specific owner
   */
  async getSharedWishlistItems(viewerId: string, ownerId: string, userToken?: string) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get the share record
    const { data: share, error: shareError } = await client
      .from('wishlist_shares')
      .select('id, share_type')
      .eq('owner_id', ownerId)
      .eq('shared_with_id', viewerId)
      .eq('is_active', true)
      .single();

    if (shareError || !share) {
      throw new Error('No active wishlist share found');
    }

    // Get shared items using the view
    const { data, error } = await client
      .from('shared_wishlist_items_with_details')
      .select('*')
      .eq('wishlist_share_id', share.id)
      .eq('product_status', 'active'); // Only active products

    if (error) {
      console.error('Shared wishlist items query error:', error);
      throw new Error(`Failed to fetch shared wishlist items: ${error.message}`);
    }

    // Transform to match frontend expectations
    return data?.map(item => ({
      id: item.wishlist_item_id,
      productId: item.product_id,
      productName: item.product_name || 'Unknown Product',
      productImage: item.product_image || 'https://via.placeholder.com/150',
      price: item.product_price || 0,
      sellerId: item.seller_id,
      sellerName: 'Seller', // Can be enhanced with seller profile lookup
      notes: item.notes,
      priority: item.priority,
      createdAt: item.created_at,
      isAvailable: item.product_status === 'active',
      canAddItems: share.share_type === 'view_and_add'
    })) || [];
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
   * Search for users to share wishlist with (any verified user)
   * @param userId - Current user ID (to exclude from results)
   * @param searchQuery - Optional search query to filter users by username
   * @param limit - Optional limit for results (default: 20)
   */
  async getShareableFriends(userId: string, userToken?: string, searchQuery?: string, limit: number = 20) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Build query to get all users except current user
    let query = client
      .from('user_profiles')
      .select('id, username, avatar_url')
      .neq('id', userId);

    // Add search filter if provided
    if (searchQuery && searchQuery.trim()) {
      query = query.ilike('username', `%${searchQuery.trim()}%`);
    }

    // Add limit and order
    query = query
      .order('username', { ascending: true })
      .limit(limit);

    const { data: users, error } = await query;

    if (error) {
      console.error('Search users query error:', error);
      throw new Error(`Failed to search users: ${error.message}`);
    }

    // Transform to match expected format
    return users?.map(user => ({
      id: user.id,
      username: user.username,
      fullName: user.username,
      avatarUrl: user.avatar_url,
      source: 'search'
    })) || [];
  }

  // ============================================
  // GIFT FUNCTIONALITY
  // ============================================

  /**
   * Create gift order (with automatic order creation for gifts)
   */
  async createGiftOrder(
    giftGiverId: string,
    giftRecipientId: string,
    orderId: string | null,
    wishlistItemId: string,
    giftMessage?: string,
    isSurprise: boolean = false,
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Input validation
    if (!giftGiverId || !giftRecipientId || !wishlistItemId) {
      throw new Error('Gift giver ID, recipient ID, and wishlist item ID are required');
    }

    if (giftGiverId === giftRecipientId) {
      throw new Error('Cannot create gift order for yourself');
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

    // Verify both users exist
    const { data: giverUser, error: giverError } = await client
      .from('user_profiles')
      .select('id, username')
      .eq('id', giftGiverId)
      .single();

    const { data: recipientUser, error: recipientError } = await client
      .from('user_profiles')
      .select('id, username')
      .eq('id', giftRecipientId)
      .single();

    if (giverError || !giverUser || recipientError || !recipientUser) {
      throw new Error('Gift giver or recipient not found');
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

    // Send notification to gift recipient
    try {
      await this.notificationsService.createNotification({
        user_id: giftRecipientId,
        type: NotificationType.ORDER,
        title: '🎁 You Received a Gift!',
        message: `${giverUser.username} sent you ${wishlistItem.products?.name} as a gift!`,
        priority: NotificationPriority.HIGH,
        data: {
          gift_order_id: data.id,
          gift_giver_id: giftGiverId,
          gift_giver_username: giverUser.username,
          product_id: wishlistItem.product_id,
          product_name: wishlistItem.products?.name,
          wishlist_item_id: wishlistItemId,
          order_id: orderId,
          gift_message: giftMessage,
          is_surprise: isSurprise,
        },
        badge: 'gift'
      });
      console.log('💖 Gift notification sent to recipient:', giftRecipientId);
    } catch (notifError) {
      console.error('Error sending gift notification:', notifError);
      // Don't fail the gift order if notification fails
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

    // Verify gift giver exists
    const { data: giverUser, error: giverError } = await client
      .from('user_profiles')
      .select('id')
      .eq('id', giftGiverId)
      .single();

    if (giverError || !giverUser) {
      return {
        canPurchase: false,
        reason: 'Gift giver user not found'
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