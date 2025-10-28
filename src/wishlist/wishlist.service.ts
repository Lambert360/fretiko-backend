import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType, NotificationPriority } from '../notifications/dto/notification.dto';
import { ChatService } from '../chat/chat.service';

@Injectable()
export class WishlistService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationsService: NotificationsService,
    @Inject(forwardRef(() => ChatService))
    private chatService: ChatService,
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
    // Filter out items with deleted products (null products field)
    return data
      ?.filter(item => item.products !== null)
      .map(item => ({
        id: item.id,
        productId: item.product_id,
        productName: item.products?.name || 'Unknown Product',
        productImage: item.products?.images?.[0] || item.products?.primary_image_url || 'https://via.placeholder.com/150',
        price: item.products?.price || 0,
        sellerId: item.products?.user_id,
        sellerName: item.products?.user_profiles?.username || 'Unknown Seller',
        category: item.products?.product_categories?.name || 'Uncategorized',
        createdAt: item.created_at,
        isAvailable: item.products?.status === 'active',
        productDeleted: item.products === null
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

    // 🎁 Auto-create chat message with wishlist card
    let chatMessageData: any = null;
    try {
      // Get owner's profile for username
      const { data: ownerProfile } = await client
        .from('user_profiles')
        .select('username')
        .eq('id', ownerId)
        .single();

      const ownerName = ownerProfile?.username || 'Unknown User';

      // Get recipient's profile for reference
      const { data: recipientProfile } = await client
        .from('user_profiles')
        .select('username')
        .eq('id', friendId)
        .single();

      const recipientName = recipientProfile?.username || 'Unknown User';

      // Get preview items for the card
      const previewItems = await this.getWishlistPreviewItems(ownerId, selectedItemIds, 3, userToken);

      const itemCount = selectedItemIds?.length || wishlistCount || 0;

      // Find or create conversation between owner and friend
      const conversation = await this.chatService.findOrCreateConversation(
        ownerId,
        [friendId],
        'friend',
        userToken
      );

      // Create wishlist message with data (includes both owner and recipient)
      const wishlistData = {
        shareId: data.id,
        shareType: data.share_type,
        itemCount,
        ownerName,
        ownerId,
        recipientName,
        recipientId: friendId,
        previewItems,
        canAddItems: data.share_type === 'view_and_add',
        sharedAt: new Date(),
      };

      const messageContent = `💖 ${ownerName} shared ${itemCount} item${itemCount > 1 ? 's' : ''} from their wishlist with you!`;

      const chatMessage = await this.chatService.sendMessage(ownerId, {
        conversationId: conversation.id,
        messageType: 'wishlist' as any,
        content: messageContent,
        metadata: { wishlistData },
        broadcastToAll: false, // 🎁 Sender adds optimistically, don't broadcast back to them
      }, userToken);

      chatMessageData = {
        messageId: chatMessage.id,
        conversationId: conversation.id,
        wishlistData,
      };

      console.log('✅ Wishlist chat message created:', chatMessage.id);
    } catch (messageError) {
      // Log error but don't fail the whole share operation
      console.error('⚠️ Failed to create wishlist chat message:', messageError);
      console.error('Share was successful, but message creation failed');
    }

    return {
      message: 'Wishlist shared successfully',
      shareId: data.id,
      shareType: data.share_type,
      canAddItems: data.share_type === 'view_and_add',
      sharedItemsCount: selectedItemIds?.length || 0,
      chatMessage: chatMessageData, // Include chat message data in response
    };
  }

  /**
   * Get wishlist preview items for chat message display
   * Returns first N items with product details
   */
  private async getWishlistPreviewItems(
    ownerId: string,
    selectedItemIds?: string[],
    limit: number = 3,
    userToken?: string
  ): Promise<Array<{ id: string; name: string; price: number; image: string }>> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      let query = client
        .from('wishlist')
        .select(`
          id,
          product_id,
          products (
            id,
            name,
            price,
            primary_image_url,
            images,
            status
          )
        `)
        .eq('user_id', ownerId)
        .eq('products.status', 'active')
        .limit(limit);

      // If selective sharing, only get selected items
      if (selectedItemIds && selectedItemIds.length > 0) {
        query = query.in('id', selectedItemIds);
      }

      const { data: wishlistItems, error } = await query;

      if (error) {
        console.error('Error fetching wishlist preview items:', error);
        return [];
      }

      if (!wishlistItems || wishlistItems.length === 0) {
        return [];
      }

      // Map to preview format
      return wishlistItems
        .filter(item => item.products) // Filter out items with deleted products
        .map(item => ({
          id: item.products.id,
          name: item.products.name,
          price: item.products.price,
          image: item.products.primary_image_url ||
                 (item.products.images && item.products.images.length > 0 ? item.products.images[0] : ''),
        }))
        .filter(item => item.image); // Only include items with images
    } catch (error) {
      console.error('Exception getting wishlist preview items:', error);
      return [];
    }
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
    console.log('💖 Getting shared wishlist - Viewer:', viewerId, 'Owner:', ownerId);
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get the share record
    const { data: share, error: shareError } = await client
      .from('wishlist_shares')
      .select('id, share_type, expires_at')
      .eq('owner_id', ownerId)
      .eq('shared_with_id', viewerId)
      .eq('is_active', true)
      .single();

    if (shareError || !share) {
      throw new Error('No active wishlist share found');
    }

    // Check if share has expired
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      throw new Error('This wishlist share has expired');
    }

    // Check if there are any specifically shared items
    const { data: sharedItemsCheck, error: checkError } = await client
      .from('shared_wishlist_items')
      .select('wishlist_item_id')
      .eq('wishlist_share_id', share.id)
      .limit(1);

    if (checkError) {
      console.error('Shared items check error:', checkError);
      throw new Error(`Failed to check shared items: ${checkError.message}`);
    }

    let data;

    if (sharedItemsCheck && sharedItemsCheck.length > 0) {
      // Selective sharing: Get only specifically shared items
      console.log('📌 Selective sharing detected - fetching from shared_wishlist_items_with_details');
      const { data: selectiveData, error: selectiveError } = await client
        .from('shared_wishlist_items_with_details')
        .select('*')
        .eq('wishlist_share_id', share.id)
        .eq('product_status', 'active');

      if (selectiveError) {
        console.error('Selective shared items query error:', selectiveError);
        throw new Error(`Failed to fetch shared wishlist items: ${selectiveError.message}`);
      }

      console.log(`✅ Found ${selectiveData?.length || 0} selective items`);
      data = selectiveData;
    } else {
      // Full wishlist sharing: Get all wishlist items from owner
      const { data: fullData, error: fullError } = await client
        .from('wishlist')
        .select(`
          id,
          product_id,
          notes,
          priority,
          created_at,
          added_by_friend_id,
          products (
            id,
            name,
            price,
            primary_image_url,
            images,
            status,
            user_id
          )
        `)
        .eq('user_id', ownerId)
        .order('created_at', { ascending: false });

      if (fullError) {
        console.error('Full wishlist query error:', fullError);
        throw new Error(`Failed to fetch wishlist items: ${fullError.message}`);
      }

      console.log(`📦 Raw wishlist data: ${fullData?.length || 0} items (before filtering)`);
      
      // Filter out items with inactive/deleted products
      const activeItems = fullData?.filter(item => {
        const hasProduct = item.products !== null;
        const isActive = item.products?.status === 'active';
        console.log(`   Item ${item.id}: hasProduct=${hasProduct}, isActive=${isActive}, addedBy=${item.added_by_friend_id || 'owner'}`);
        return hasProduct && isActive;
      }) || [];

      console.log(`✅ After filtering: ${activeItems.length} active items`);

      // Get collaborator usernames if items were added by friends
      const collaboratorIds = activeItems
        ?.filter(item => item.added_by_friend_id)
        .map(item => item.added_by_friend_id) || [];

      let collaboratorProfiles = {};
      if (collaboratorIds.length > 0) {
        const { data: profiles } = await client
          .from('user_profiles')
          .select('id, username')
          .in('id', collaboratorIds);

        if (profiles) {
          collaboratorProfiles = profiles.reduce((acc, profile) => {
            acc[profile.id] = profile.username;
            return acc;
          }, {} as Record<string, string>);
        }
      }

      // Transform to match the expected format
      data = activeItems?.map(item => ({
        wishlist_item_id: item.id,
        product_id: item.product_id,
        product_name: item.products?.name,
        product_price: item.products?.price,
        product_image: item.products?.primary_image_url || item.products?.images?.[0],
        product_status: item.products?.status,
        seller_id: item.products?.user_id,
        notes: item.notes,
        priority: item.priority,
        created_at: item.created_at,
        added_by_friend_id: item.added_by_friend_id,
        added_by_friend_name: item.added_by_friend_id ? collaboratorProfiles[item.added_by_friend_id] : null,
      }));
    }

    // Transform to match frontend expectations
    const transformedData = data?.map(item => ({
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
      canAddItems: share.share_type === 'view_and_add',
      addedByFriend: item.added_by_friend_name || null,
      collaborationNote: item.notes || null, // Use notes as collaboration note
    })) || [];
    
    console.log('✅ Returning wishlist items:', transformedData?.length || 0, 'items');
    console.log('📋 First 3 items:', transformedData?.slice(0, 3).map(i => ({ 
      wishlistId: i.id, 
      productId: i.productId, 
      name: i.productName,
      addedBy: i.addedByFriend 
    })));
    
    return transformedData;
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

    // Get users the current user is connected with (following/followers)
    const { data: connections, error: connectionsError } = await client
      .from('connections')
      .select('follower_id, following_id')
      .or(`follower_id.eq.${userId},following_id.eq.${userId}`)
      .eq('status', 'accepted');

    if (connectionsError) {
      console.error('Connections query error:', connectionsError);
    }

    // Extract connected user IDs
    const connectedUserIds = new Set<string>();
    connections?.forEach(conn => {
      if (conn.follower_id === userId) {
        connectedUserIds.add(conn.following_id);
      } else {
        connectedUserIds.add(conn.follower_id);
      }
    });

    // Get users with active chats
    const { data: chats, error: chatsError } = await client
      .from('chats')
      .select('user1_id, user2_id')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .neq('status', 'deleted');

    if (chatsError) {
      console.error('Chats query error:', chatsError);
    }

    // Extract chatting user IDs
    chats?.forEach(chat => {
      if (chat.user1_id === userId) {
        connectedUserIds.add(chat.user2_id);
      } else {
        connectedUserIds.add(chat.user1_id);
      }
    });

    // If no connections or chats, return empty array
    if (connectedUserIds.size === 0) {
      return [];
    }

    // Build query to get connected/chatting users
    let query = client
      .from('user_profiles')
      .select('id, username, avatar_url')
      .in('id', Array.from(connectedUserIds));

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
      source: 'connected'
    })) || [];
  }

  // ============================================
  // GIFT FUNCTIONALITY
  // ============================================

  /**
   * Create gift order (with automatic order and payment processing)
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
          id,
          name,
          price,
          status,
          quantity,
          primary_image_url,
          images,
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

    if (wishlistItem.products?.stock_quantity !== undefined && wishlistItem.products?.stock_quantity < 1) {
      throw new Error('The wishlist item product is out of stock');
    }

    // Verify both users exist
    const { data: giverUser, error: giverError } = await client
      .from('user_profiles')
      .select('id, username')
      .eq('id', giftGiverId)
      .single();

    const { data: recipientUser, error: recipientError } = await client
      .from('user_profiles')
      .select('id, username, delivery_address')
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

    // Check giver's wallet balance
    const { data: giverWallet, error: walletError } = await client
      .from('wallets')
      .select('available_balance')
      .eq('user_id', giftGiverId)
      .single();

    if (walletError || !giverWallet) {
      throw new Error('Gift giver wallet not found');
    }

    // Calculate costs (using same logic as regular checkout)
    const subtotal = wishlistItem.products.price;
    const tax = Math.round(subtotal * 0.075); // 7.5% VAT
    // Escrow fee - Currently FREE (0%)
    const escrowRate = 0; // 0% = FREE (change to 0.025 for 2.5%)
    const minimumEscrowFee = 0; // ₣0 minimum (change to 50 for ₣50 minimum)
    const escrowFee = Math.max(minimumEscrowFee, Math.round((subtotal + tax) * escrowRate));
    const shipping = subtotal >= 10000 ? 0 : 500; // Free shipping over ₣10,000
    const total = subtotal + tax + escrowFee + shipping;

    if (giverWallet.available_balance < total) {
      throw new Error(`Insufficient wallet balance. Need ₣${total.toFixed(2)}, available: ₣${giverWallet.available_balance.toFixed(2)}`);
    }

    // Get recipient's default delivery address
    const { data: deliveryAddress } = await client
      .from('delivery_addresses')
      .select('*')
      .eq('user_id', giftRecipientId)
      .eq('is_default', true)
      .single();

    if (!deliveryAddress) {
      throw new Error('Recipient does not have a default delivery address set');
    }

    // Generate order number
    const orderNumber = `GIFT-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    // Create the order first
    const { data: createdOrder, error: orderError } = await client
      .from('orders')
      .insert({
        user_id: giftRecipientId, // Order belongs to recipient
        order_number: orderNumber,
        status: 'confirmed', // Will be set to confirmed after payment
        payment_method: 'wallet',
        use_escrow: true, // Gifts always use escrow
        subtotal: subtotal,
        shipping_cost: shipping,
        tax_amount: tax,
        escrow_fee: escrowFee,
        total_amount: total,
        rider_id: null, // Will be assigned later
        delivery_type: 'delivery',
        delivery_address: {
          fullName: deliveryAddress.full_name,
          phone: deliveryAddress.phone,
          address: deliveryAddress.address,
          city: deliveryAddress.city,
          state: deliveryAddress.state,
          postalCode: deliveryAddress.postal_code,
        },
        delivery_instructions: giftMessage ? `Gift from ${giverUser.username}: ${giftMessage}` : `Gift from ${giverUser.username}`,
        estimated_delivery: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
        order_source: 'gift',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (orderError || !createdOrder) {
      console.error('Order creation error:', orderError);
      throw new Error(`Failed to create gift order: ${orderError?.message || 'Unknown error'}`);
    }

    // Create order item
    const { error: orderItemError } = await client
      .from('order_items')
      .insert({
        order_id: createdOrder.id,
        product_id: wishlistItem.product_id,
        product_name: wishlistItem.products.name,
        quantity: 1,
        unit_price: wishlistItem.products.price,
        total_price: wishlistItem.products.price,
        seller_id: wishlistItem.products.seller_id,
        created_at: new Date().toISOString(),
      });

    if (orderItemError) {
      console.error('Order item creation error:', orderItemError);
      // Rollback order
      await client.from('orders').delete().eq('id', createdOrder.id);
      throw new Error(`Failed to create order item: ${orderItemError.message}`);
    }

    // Process wallet payment from gift giver
    const { error: walletDeductError } = await client
      .from('wallets')
      .update({
        available_balance: client.raw(`available_balance - ${total}`),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', giftGiverId);

    if (walletDeductError) {
      console.error('Wallet deduction error:', walletDeductError);
      // Rollback order and items
      await client.from('order_items').delete().eq('order_id', createdOrder.id);
      await client.from('orders').delete().eq('id', createdOrder.id);
      throw new Error('Payment processing failed');
    }

    // Create transaction record for gift giver
    await client
      .from('wallet_transactions')
      .insert({
        user_id: giftGiverId,
        type: 'debit',
        amount: total,
        description: `Gift purchase: ${wishlistItem.products.name} for ${recipientUser.username}`,
        reference: createdOrder.id,
        status: 'completed',
        created_at: new Date().toISOString(),
      });

    // Update order payment status
    await client
      .from('orders')
      .update({
        payment_status: 'paid',
        updated_at: new Date().toISOString(),
      })
      .eq('id', createdOrder.id);

    // Update product stock
    await client
      .from('products')
      .update({
        quantity: client.raw(`quantity - 1`),
        updated_at: new Date().toISOString(),
      })
      .eq('id', wishlistItem.product_id);

    // Create gift order record
    const { data: giftOrder, error: giftError } = await client
      .from('gift_orders')
      .insert({
        order_id: createdOrder.id,
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

    if (giftError) {
      console.error('Gift order record creation error:', giftError);
      // Order is already created and paid, so we log but don't throw
      console.warn('⚠️ Gift order created but gift_orders record failed. Order ID:', createdOrder.id);
    }

    // Send notification to gift recipient (if not a surprise)
    if (!isSurprise) {
      try {
        // Check recipient notification preferences
        const { data: notifPrefs } = await client
          .from('notification_settings')
          .select('order_notifications')
          .eq('user_id', giftRecipientId)
          .single();

        // Only send if user has order notifications enabled (default: true)
        const shouldSendNotification = !notifPrefs || notifPrefs.order_notifications !== false;

        if (shouldSendNotification) {
          await this.notificationsService.createNotification({
            user_id: giftRecipientId,
            type: NotificationType.ORDER,
            title: '🎁 You Received a Gift!',
            message: `${giverUser.username} sent you ${wishlistItem.products?.name} as a gift!`,
            priority: NotificationPriority.HIGH,
            data: {
              gift_order_id: giftOrder?.id,
              gift_giver_id: giftGiverId,
              gift_giver_username: giverUser.username,
              product_id: wishlistItem.product_id,
              product_name: wishlistItem.products?.name,
              wishlist_item_id: wishlistItemId,
              order_id: createdOrder.id,
              gift_message: giftMessage,
              is_surprise: isSurprise,
            },
            badge: 'gift'
          });
          console.log('💖 Gift notification sent to recipient:', giftRecipientId);
        } else {
          console.log('ℹ️ Gift notification skipped (user preference):', giftRecipientId);
        }
      } catch (notifError) {
        console.error('Error sending gift notification:', notifError);
        // Don't fail the gift order if notification fails
      }
    }

    return {
      message: 'Gift purchase successful!',
      giftOrderId: giftOrder?.id,
      orderId: createdOrder.id,
      orderNumber: createdOrder.order_number,
      recipientName: recipientUser.username,
      productName: wishlistItem.products?.name,
      totalAmount: total,
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
   * Add item to shared wishlist (for collaborators)
   */
  async addToSharedWishlist(
    collaboratorId: string,
    ownerId: string,
    itemData: {
      productId: string;
      productName: string;
      productImage: string;
      price: number;
      collaborationNote?: string;
    },
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    console.log('💖 Adding item to shared wishlist:', {
      collaboratorId,
      ownerId,
      productId: itemData.productId
    });

    // Check if collaborator has permission to add items
    const { data: share, error: shareError } = await client
      .from('wishlist_shares')
      .select('id, share_type')
      .eq('owner_id', ownerId)
      .eq('shared_with_id', collaboratorId)
      .eq('is_active', true)
      .single();

    if (shareError || !share) {
      throw new Error('You do not have permission to add items to this wishlist');
    }

    if (share.share_type !== 'view_and_add') {
      throw new Error('You can only view this wishlist, not add items');
    }

    // Check if product exists and is active
    const { data: product, error: productError } = await client
      .from('products')
      .select('id, name, price, status')
      .eq('id', itemData.productId)
      .eq('status', 'active')
      .single();

    if (productError || !product) {
      throw new Error('Product not found or no longer available');
    }

    // Check if item already exists in owner's wishlist
    const { data: existingItem } = await client
      .from('wishlist')
      .select('id')
      .eq('user_id', ownerId)
      .eq('product_id', itemData.productId)
      .single();

    if (existingItem) {
      throw new Error('This item is already in the wishlist');
    }

    // Add item to owner's wishlist with collaborator info
    const { data: newItem, error: addError } = await client
      .from('wishlist')
      .insert({
        user_id: ownerId,
        product_id: itemData.productId,
        notes: itemData.collaborationNote || `Added by collaborator`,
        added_by_friend_id: collaboratorId
      })
      .select()
      .single();

    if (addError) {
      console.error('❌ Error adding to shared wishlist:', addError);
      throw new Error('Failed to add item to wishlist');
    }

    console.log('✅ Item added to wishlist:', newItem.id);

    // Check if this is a selective share - if so, add to shared_wishlist_items
    const { data: sharedItemsCheck } = await client
      .from('shared_wishlist_items')
      .select('wishlist_item_id')
      .eq('wishlist_share_id', share.id)
      .limit(1);

    if (sharedItemsCheck && sharedItemsCheck.length > 0) {
      // This is a selective share - add the new item to shared_wishlist_items
      console.log('📌 Selective share detected - adding item to shared_wishlist_items');
      console.log('🔑 Using user token for RLS check. Share ID:', share.id, 'Item ID:', newItem.id);
      
      // Use the user's client (with their auth token) so RLS can check auth.uid()
      const { error: shareItemError } = await client
        .from('shared_wishlist_items')
        .insert({
          wishlist_share_id: share.id,
          wishlist_item_id: newItem.id,
        });

      if (shareItemError) {
        console.error('⚠️ Failed to add item to shared_wishlist_items:', shareItemError);
        console.error('   Share type:', share.share_type);
        console.error('   Collaborator ID:', collaboratorId);
        console.error('   Owner ID:', ownerId);
        // Don't fail the whole operation
      } else {
        console.log('✅ Item added to shared_wishlist_items');
      }
    } else {
      console.log('📋 Full wishlist share - no need to add to shared_wishlist_items');
    }

    // Get collaborator's username for display
    const { data: collaboratorProfile } = await client
      .from('user_profiles')
      .select('username')
      .eq('id', collaboratorId)
      .single();

    console.log('👤 Collaborator profile:', collaboratorProfile?.username);

    // Send notification to wishlist owner
    try {
      await this.notificationsService.createNotification({
        user_id: ownerId,
        type: NotificationType.SOCIAL,
        title: 'New Item Added to Your Wishlist',
        message: `${collaboratorProfile?.username || 'Someone'} added "${itemData.productName}" to your wishlist`,
        data: {
          collaboratorId,
          collaboratorName: collaboratorProfile?.username,
          productId: itemData.productId,
          productName: itemData.productName,
          wishlistItemId: newItem.id
        }
      });
      console.log('📬 Notification sent to owner');
    } catch (notifError) {
      console.error('⚠️ Failed to send notification (non-fatal):', notifError);
      // Don't fail the whole operation if notification fails
    }

    console.log('🎉 Returning success response');

    return {
      message: 'Item successfully added to wishlist',
      item: {
        id: newItem.id,
        productId: itemData.productId,
        productName: itemData.productName,
        productImage: itemData.productImage,
        price: itemData.price,
        addedByFriend: collaboratorProfile?.username,
        collaborationNote: itemData.collaborationNote
      }
    };
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

    console.log('🎁 Checking gift purchase for wishlist item:', wishlistItemId);

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
          status
        ),
        user_profiles!wishlist_user_id_fkey (
          username
        )
      `)
      .eq('id', wishlistItemId)
      .single();

    console.log('🔍 Wishlist item query result:', { found: !!wishlistItem, error: wishlistError });
    
    if (wishlistError || !wishlistItem) {
      console.log('❌ Wishlist item NOT FOUND:', wishlistItemId, 'Error:', wishlistError?.message);
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
        reason: 'This item has vanished from the marketplace! 🕳️ The seller might have removed it or it could be temporarily unavailable.'
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
        reason: 'Someone already got this gift! 🎁 This item has already been purchased as a gift. Check if there are other items in the wishlist you can gift instead.'
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

  /**
   * Multi-step gift purchase validation
   */
  async validateGiftPurchase(
    giftGiverId: string,
    items: Array<{ wishlistItemId: string; quantity?: number }>,
    userToken?: string
  ) {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    
    const validationResults: Array<{
      wishlistItemId: string;
      valid: boolean;
      reason?: string;
      price?: number;
      quantity?: number;
    }> = [];
    let totalPrice = 0;
    const availableItems: Array<{
      id?: any;
      name?: any;
      price: number;
      sellerId?: any;
      quantity: number;
    }> = [];

    for (const item of items) {
      try {
        // Step 1: Check if item can be purchased
        const canPurchase = await this.canPurchaseAsGift(giftGiverId, item.wishlistItemId, userToken);
        
        if (!canPurchase.canPurchase) {
          validationResults.push({
            wishlistItemId: item.wishlistItemId,
            valid: false,
            reason: canPurchase.reason
          });
          continue;
        }

        // Step 2: Check stock availability
        if (!canPurchase.productInfo) {
          validationResults.push({
            wishlistItemId: item.wishlistItemId,
            valid: false,
            reason: 'Product information not found! 🤔 This item may have been removed.'
          });
          continue;
        }

        const { data: product } = await client
          .from('products')
          .select('stock_quantity, price')
          .eq('id', canPurchase.productInfo.id)
          .single();

        if (product && product.stock_quantity !== null && product.stock_quantity < (item.quantity || 1)) {
          validationResults.push({
            wishlistItemId: item.wishlistItemId,
            valid: false,
            reason: `Only ${product.stock_quantity} available in stock! 📦 The seller doesn't have enough of this item.`
          });
          continue;
        }

        // Step 3: Calculate price
        const itemPrice = (product?.price || canPurchase.productInfo.price) * (item.quantity || 1);
        totalPrice += itemPrice;

        validationResults.push({
          wishlistItemId: item.wishlistItemId,
          valid: true,
          price: itemPrice,
          quantity: item.quantity || 1
        });

        availableItems.push({
          ...canPurchase.productInfo,
          quantity: item.quantity || 1,
          price: itemPrice
        });

      } catch (error) {
        validationResults.push({
          wishlistItemId: item.wishlistItemId,
          valid: false,
          reason: `Oops! Something went wrong checking this item. 🤔 Please try again or contact support.`
        });
      }
    }

    return {
      valid: validationResults.every(r => r.valid),
      totalPrice,
      availableItems,
      validationResults,
      summary: {
        totalItems: items.length,
        validItems: validationResults.filter(r => r.valid).length,
        invalidItems: validationResults.filter(r => !r.valid).length
      }
    };
  }
}