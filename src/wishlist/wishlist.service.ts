import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { NotificationType, NotificationPriority } from '../notifications/dto/notification.dto';
import { ChatService } from '../chat/chat.service';
import { EscrowService } from '../escrow/escrow.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletTransactionType } from '../wallet/constants/transaction-types';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';

@Injectable()
export class WishlistService {
  private supabase;
  private serviceSupabase;
  private readonly PLATFORM_COMMISSION_RATE: number;

  constructor(
    private configService: ConfigService,
    private clientManager: SupabaseClientManager,
    private notificationsService: NotificationsService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => ChatService))
    private chatService: ChatService,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
    private walletService: WalletService,
    private realtimeGateway: RealtimeGateway,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.serviceSupabase = this.clientManager.getServiceClient();
    this.PLATFORM_COMMISSION_RATE = parseFloat(
      this.configService.get<string>('PLATFORM_COMMISSION_RATE', '0.1')
    );
  }

  async getWishlistItems(userId: string, userToken?: string) {
    const { data, error } = await this.serviceSupabase
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
    console.log('💖 Adding to wishlist for user:', userId, wishlistData);

    // Check if product exists
    const { data: product, error: productError } = await this.serviceSupabase
      .from('products')
      .select('id, name')
      .eq('id', wishlistData.productId)
      .eq('status', 'active')
      .single();

    if (productError || !product) {
      throw new NotFoundException('Product not found or not available');
    }

    // Check if item already exists in wishlist
    const { data: existingItem } = await this.serviceSupabase
      .from('wishlist')
      .select('id')
      .eq('user_id', userId)
      .eq('product_id', wishlistData.productId)
      .single();

    if (existingItem) {
      return { message: 'Item already in wishlist' };
    }

    // Add new item to wishlist
    const { error: insertError } = await this.serviceSupabase
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
    console.log('💖 Removing from wishlist for user:', userId, 'productId:', productId);

    const { error } = await this.serviceSupabase
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

  async removePurchasedItems(userId: string, wishlistItemIds: string[], userToken?: string) {
    if (!wishlistItemIds || wishlistItemIds.length === 0) {
      console.log('💖 No wishlist item IDs provided for removal');
      return { message: 'No items to remove', removedCount: 0 };
    }

    console.log('💖 Removing purchased wishlist items for user:', userId, 'itemIds:', wishlistItemIds);

    // Delete wishlist items by their IDs (wishlist.id, not product_id)
    const { data, error } = await this.serviceSupabase
      .from('wishlist')
      .delete()
      .eq('user_id', userId)
      .in('id', wishlistItemIds)
      .select('id');

    if (error) {
      console.error('Wishlist remove purchased items error:', error);
      throw new Error(`Failed to remove purchased items from wishlist: ${error.message}`);
    }

    const removedCount = data?.length || 0;
    console.log(`✅ Removed ${removedCount} items from wishlist`);

    return { message: 'Purchased items removed from wishlist', removedCount };
  }

  async clearWishlist(userId: string, userToken?: string) {
    const { error } = await this.serviceSupabase
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
    const { count, error } = await this.serviceSupabase
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
    const { data, error } = await this.serviceSupabase
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

      // 🔥 NEW: Calculate purchase status for shared items
      const purchaseStatus = await this.calculateWishlistPurchaseStatus(
        ownerId,
        selectedItemIds,
        userToken
      );

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
        sharedAt: new Date().toISOString(), // 🔥 FIX: Convert to ISO string for proper serialization
        purchaseStatus, // 🔥 NEW: Include purchase status
      };

      console.log('✅ Wishlist data created with purchaseStatus:', {
        itemCount,
        purchaseStatus,
        overallStatus: purchaseStatus?.overallStatus,
        itemsPurchased: purchaseStatus?.itemsPurchased,
        totalItems: purchaseStatus?.totalItems,
      });

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
   * Calculate purchase status for wishlist items
   * Returns status including items purchased, processing, and completed
   */
  private async calculateWishlistPurchaseStatus(
    ownerId: string,
    selectedItemIds?: string[],
    userToken?: string
  ): Promise<{
    itemsPurchased: number;
    itemsProcessing: number;
    itemsCompleted: number;
    totalItems: number;
    overallStatus: 'none' | 'processing' | 'completed';
  }> {
    const serviceClient = createServiceSupabaseClient(this.configService);

    try {
      // Get all wishlist items for this owner
      let wishlistItemIds: string[] = [];
      
      if (selectedItemIds && selectedItemIds.length > 0) {
        // Use selected items if provided (selective sharing)
        wishlistItemIds = selectedItemIds;
      } else {
        // Get all wishlist items for the owner
        const { data: allItems } = await serviceClient
          .from('wishlist')
          .select('id')
          .eq('user_id', ownerId);
        
        wishlistItemIds = (allItems || []).map(item => item.id);
      }

      if (wishlistItemIds.length === 0) {
        return {
          itemsPurchased: 0,
          itemsProcessing: 0,
          itemsCompleted: 0,
          totalItems: 0,
          overallStatus: 'none',
        };
      }

      // Get gift orders for these wishlist items
      const { data: giftOrders } = await serviceClient
        .from('gift_orders')
        .select(`
          wishlist_item_id,
          orders!inner (
            id,
            status
          )
        `)
        .in('wishlist_item_id', wishlistItemIds);

      // Count items by status
      let processingCount = 0;
      let completedCount = 0;

      if (giftOrders && giftOrders.length > 0) {
        giftOrders.forEach((giftOrder: any) => {
          const orderStatus = (giftOrder.orders as any)?.status;
          if (orderStatus === 'completed' || orderStatus === 'delivered') {
            completedCount++;
          } else if (orderStatus && orderStatus !== 'cancelled') {
            processingCount++;
          }
        });
      }

      const itemsPurchased = processingCount + completedCount;
      const totalItems = wishlistItemIds.length;

      // Determine overall status
      let overallStatus: 'none' | 'processing' | 'completed' = 'none';
      if (completedCount === totalItems && totalItems > 0) {
        overallStatus = 'completed';
      } else if (itemsPurchased > 0) {
        overallStatus = 'processing';
      }

      return {
        itemsPurchased,
        itemsProcessing: processingCount,
        itemsCompleted: completedCount,
        totalItems,
        overallStatus,
      };
    } catch (error) {
      console.error('⚠️ Error calculating wishlist purchase status (non-critical):', error);
      // Return default status on error
      return {
        itemsPurchased: 0,
        itemsProcessing: 0,
        itemsCompleted: 0,
        totalItems: selectedItemIds?.length || 0,
        overallStatus: 'none',
      };
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
      // Transform selective data to match the expected format structure
      data = selectiveData?.map((item: any) => ({
        wishlist_item_id: item.wishlist_item_id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_price: item.product_price,
        product_image: item.product_image,
        product_status: item.product_status,
        seller_id: item.seller_id,
        notes: item.notes,
        priority: item.priority,
        created_at: item.created_at,
        added_by_friend_id: item.added_by_friend_id,
        added_by_friend_name: item.added_by_friend_name || null,
      })) || [];
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

    // 🔥 NEW: Get gift order statuses for all wishlist items (use service client to bypass RLS)
    const wishlistItemIds = data?.map(item => item.wishlist_item_id) || [];
    let giftOrderMap = new Map();

    if (wishlistItemIds.length > 0) {
      const serviceClient = createServiceSupabaseClient(this.configService);
      const { data: giftOrders, error: giftOrdersError } = await serviceClient
        .from('gift_orders')
        .select(`
          wishlist_item_id,
          status,
          order_id,
          orders!inner (
            order_number,
            status
          )
        `)
        .in('wishlist_item_id', wishlistItemIds);

      if (giftOrders && !giftOrdersError) {
        giftOrders.forEach((go: any) => {
          giftOrderMap.set(go.wishlist_item_id, {
            status: go.status,
            orderId: go.order_id,
            orderNumber: go.orders?.order_number || null,
            orderStatus: go.orders?.status || null,
          });
        });
      } else if (giftOrdersError) {
        console.error('⚠️ Error fetching gift orders for shared wishlist:', giftOrdersError);
        // Continue without gift order status - non-critical
      }
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
      giftOrderStatus: giftOrderMap.get(item.wishlist_item_id) || null,
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
    deliveryAddress: {
      fullName: string;
      phone: string;
      address: string;
      city: string;
      state: string;
      postalCode: string;
    },
    giftMessage?: string,
    isSurprise: boolean = false,
    selectedRider?: {
      riderId: string;
      riderName?: string;
      vehicleType?: string;
      deliveryPrice?: number;
      estimatedArrival?: number;
    },
    userToken?: string
  ) {
    // 🔥 FIX: Use service role client for initial lookup to bypass RLS
    // This is a backend operation and we need to find the wishlist item regardless of RLS
    const serviceClient = createServiceSupabaseClient(this.configService);
    
    // Use user client for user-specific operations (respects RLS for creating orders, etc.)
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Input validation
    if (!giftGiverId || !giftRecipientId || !wishlistItemId) {
      throw new Error('Gift giver ID, recipient ID, and wishlist item ID are required');
    }

    // 🔥 SECURITY: Validate delivery address is provided by gift giver (for privacy reasons)
    if (!deliveryAddress || !deliveryAddress.fullName || !deliveryAddress.address || !deliveryAddress.city || !deliveryAddress.phone) {
      throw new Error('Delivery address is required. Please provide the recipient\'s delivery address including full name, phone, address, and city.');
    }

    console.log('🔍 Looking up wishlist item with service role client:', wishlistItemId);

    // 🔥 FIX: First find the wishlist item using service role client to bypass RLS
    // Query without nested relation first to ensure we get the wishlist item even if product has issues
    const { data: wishlistItem, error: wishlistError } = await serviceClient
      .from('wishlist')
      .select(`
        id,
        user_id,
        product_id
      `)
      .eq('id', wishlistItemId)
      .maybeSingle(); // 🔥 FIX: Use maybeSingle() instead of single() for better error handling

    if (wishlistError) {
      console.error('❌ Wishlist item query error:', wishlistError);
      throw new Error(`Failed to query wishlist item: ${wishlistError.message}`);
    }

    if (!wishlistItem) {
      console.error('❌ Wishlist item not found:', wishlistItemId);
      throw new Error('Wishlist item not found');
    }

    // 🔥 FIX: Fetch product separately to avoid issues with nested relations
    const { data: product, error: productError } = await serviceClient
      .from('products')
      .select(`
        id,
        name,
        price,
        status,
        quantity,
        primary_image_url,
        images,
        user_id
      `)
      .eq('id', wishlistItem.product_id)
      .maybeSingle();

    if (productError) {
      console.error('❌ Product query error:', productError);
      throw new Error(`Failed to query product: ${productError.message}`);
    }

    if (!product) {
      throw new Error('The wishlist item product no longer exists');
    }

    // 🔥 FIX: Map user_id to seller_id for compatibility
    const productWithSellerId = {
      ...product,
      seller_id: product.user_id
    };

    // Attach product to wishlist item for compatibility with existing code
    (wishlistItem as any).products = productWithSellerId;

    console.log('✅ Wishlist item found:', { 
      id: wishlistItem.id, 
      userId: wishlistItem.user_id, 
      productId: wishlistItem.product_id,
      productStatus: (wishlistItem as any).products?.status 
    });

    // 🔥 FIX: Use the actual owner from the wishlist item as the recipient
    const actualRecipientId = wishlistItem.user_id;

    // 🔥 FIX: Validate that the wishlist item doesn't belong to the giver
    if (actualRecipientId === giftGiverId) {
      throw new Error('Cannot purchase gifts for yourself');
    }

    // 🔥 FIX: Optional validation - warn if passed recipient ID doesn't match (but use actual recipient)
    if (giftRecipientId !== actualRecipientId) {
      console.warn(`⚠️ Recipient ID mismatch: Passed ${giftRecipientId}, but wishlist item belongs to ${actualRecipientId}. Using actual owner as recipient.`);
    }

    if ((wishlistItem as any).products?.status !== 'active') {
      throw new Error('The wishlist item product is no longer available');
    }

    if ((wishlistItem as any).products?.quantity !== undefined && (wishlistItem as any).products?.quantity < 1) {
      throw new Error('The wishlist item product is out of stock');
    }

    // Verify both users exist (use service client to bypass RLS for backend verification)
    const { data: giverUser, error: giverError } = await serviceClient
      .from('user_profiles')
      .select('id, username')
      .eq('id', giftGiverId)
      .maybeSingle();

    const { data: recipientUser, error: recipientError } = await serviceClient
      .from('user_profiles')
      .select('id, username')
      .eq('id', actualRecipientId)
      .maybeSingle();

    if (giverError) {
      console.error('❌ Error looking up gift giver:', giverError);
      throw new Error(`Failed to lookup gift giver: ${giverError.message}`);
    }

    if (!giverUser) {
      console.error('❌ Gift giver not found:', giftGiverId);
      throw new Error('Gift giver not found');
    }

    if (recipientError) {
      console.error('❌ Error looking up recipient:', recipientError);
      throw new Error(`Failed to lookup recipient: ${recipientError.message}`);
    }

    if (!recipientUser) {
      console.error('❌ Recipient not found:', actualRecipientId);
      throw new Error('Gift recipient not found');
    }

    // 🔥 FIX: Check if gift order already exists for this wishlist item (use service client to bypass RLS)
    // Note: This check happens early, but we'll also check right before creating gift_orders record
    // to prevent race conditions. The final check will use the order_id to ensure atomicity.
    const { data: existingGift, error: existingGiftError } = await serviceClient
      .from('gift_orders')
      .select('id, status')
      .eq('wishlist_item_id', wishlistItemId)
      .maybeSingle();

    if (existingGiftError && existingGiftError.code !== 'PGRST116') {
      throw new Error(`Failed to check existing gift order: ${existingGiftError.message}`);
    }

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

    // 🔥 FIX: Gift purchases - buyer pays item price + delivery fee (if rider selected)
    // Platform fee is deducted from vendor during escrow release, not from buyer
    const itemPrice = (wishlistItem as any).products.price;
    const platformFee = itemPrice * 0.02; // 2% platform commission (deducted from vendor during escrow release)
    
    // Calculate delivery fee and rider info based on selected rider
    let deliveryFee = 0;
    let riderId: string | null = null;
    let deliveryType: 'delivery' | 'pickup' = 'delivery';
    
    if (selectedRider) {
      if (selectedRider.riderId === 'pickup') {
        // Self pickup - no delivery fee, no rider
        deliveryFee = 0;
        riderId = null;
        deliveryType = 'pickup';
      } else if (selectedRider.deliveryPrice) {
        // Rider selected - include delivery fee
        deliveryFee = selectedRider.deliveryPrice;
        riderId = selectedRider.riderId;
        deliveryType = 'delivery';
      }
    }
    
    const total = itemPrice + deliveryFee;

    if (giverWallet.available_balance < total) {
      throw new Error(`Insufficient wallet balance. Need ₣${total.toFixed(2)}, available: ₣${giverWallet.available_balance.toFixed(2)}`);
    }

    // 🔥 SECURITY: Delivery address is provided by gift giver (not fetched from recipient for privacy)
    // The address provided here will be used directly for order delivery
    // Future enhancement: We could optionally verify server-side (using serviceClient) that the recipient
    // has this address in their account, but this should not expose the address to the gift giver

    // Generate order number
    const orderNumber = `GIFT-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    // Get vendor_id from product
    const vendorId = (wishlistItem as any).products.seller_id;

    // Create the order with correct schema
    const { data: createdOrder, error: orderError } = await client
      .from('orders')
      .insert({
        buyer_id: giftGiverId, // Gift giver is the buyer
        vendor_id: vendorId, // Product seller is the vendor
        order_number: orderNumber,
        status: 'pending', // 🔥 FIX: Start as pending (will be confirmed when vendor accepts)
        escrow_enabled: true, // Gifts always use escrow
        total_amount: total, // Item price + delivery fee (if rider selected)
        delivery_fee: deliveryFee, // Delivery fee if rider selected, 0 for pickup
        platform_fee: platformFee, // 2% platform commission (deducted from vendor during escrow release)
        rider_id: riderId, // Rider ID if selected, null for pickup or if not selected
        delivery_type: deliveryType, // 'delivery' if rider selected, 'pickup' for self-pickup
        delivery_address: {
          fullName: deliveryAddress.fullName,
          phone: deliveryAddress.phone,
          address: deliveryAddress.address,
          city: deliveryAddress.city,
          state: deliveryAddress.state,
          postalCode: deliveryAddress.postalCode,
        },
        delivery_instructions: giftMessage ? `Gift from ${giverUser.username}: ${giftMessage}` : `Gift from ${giverUser.username}`,
        estimated_delivery: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
        source: 'wishlist', // Use 'wishlist' as source
        metadata: {
          gift_giver_id: giftGiverId,
          gift_recipient_id: actualRecipientId,
          wishlist_item_id: wishlistItemId,
          gift_message: giftMessage,
          is_surprise: isSurprise,
          rider_info: selectedRider ? {
            riderId: selectedRider.riderId,
            riderName: selectedRider.riderName,
            vehicleType: selectedRider.vehicleType,
            deliveryPrice: selectedRider.deliveryPrice,
            estimatedArrival: selectedRider.estimatedArrival,
          } : null,
        },
      })
      .select()
      .single();

    if (orderError || !createdOrder) {
      console.error('Order creation error:', orderError);
      throw new Error(`Failed to create gift order: ${orderError?.message || 'Unknown error'}`);
    }

    // 🔥 FIX: Validate order ID is a valid UUID before using it as reference_id
    if (!createdOrder.id || typeof createdOrder.id !== 'string') {
      console.error('Invalid order ID:', createdOrder);
      throw new Error('Order was created but ID is missing or invalid');
    }

    // Validate UUID format (basic check)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(createdOrder.id)) {
      console.error('Order ID is not a valid UUID:', createdOrder.id);
      throw new Error(`Order ID is not a valid UUID: ${createdOrder.id}`);
    }

    console.log('✅ Order created successfully:', { orderId: createdOrder.id, orderNumber: createdOrder.order_number });

    // Create order item
    const { error: orderItemError } = await client
      .from('order_items')
      .insert({
        order_id: createdOrder.id,
        product_id: wishlistItem.product_id,
        product_name: (wishlistItem as any).products.name,
        quantity: 1,
        unit_price: (wishlistItem as any).products.price,
        total_price: (wishlistItem as any).products.price,
        product_metadata: {
          gift_giver: giverUser.username,
          gift_recipient: recipientUser.username,
          gift_message: giftMessage,
          is_surprise: isSurprise,
        },
      });

    if (orderItemError) {
      console.error('Order item creation error:', orderItemError);
      // Rollback order
      await client.from('orders').delete().eq('id', createdOrder.id);
      throw new Error(`Failed to create order item: ${orderItemError.message}`);
    }

    // 🔥 FIX: Update stock BEFORE payment to prevent race conditions and ensure rollback capability
    // If stock update fails, we can rollback before payment is processed
    // Use service client for product queries to bypass RLS
    let stockUpdated = false;
    try {
      const { data: currentProduct } = await serviceClient
        .from('products')
        .select('quantity')
        .eq('id', wishlistItem.product_id)
        .maybeSingle();

      if (currentProduct) {
        const currentStock = currentProduct.quantity;

        if (currentStock !== null && currentStock < 1) {
          // Rollback order and items
          await client.from('order_items').delete().eq('order_id', createdOrder.id);
          await client.from('orders').delete().eq('id', createdOrder.id);
          throw new Error('Product is out of stock');
        }

        // Decrement stock atomically using database constraint
        const newStock = Math.max(0, currentStock - 1);
        
        // Update stock (use service client for product updates)
        const { error: stockUpdateError } = await serviceClient
          .from('products')
          .update({
            quantity: newStock,
            updated_at: new Date().toISOString(),
          })
          .eq('id', wishlistItem.product_id)
          .gte('quantity', 1); // Ensure stock is at least 1 before decrementing (prevents negative)

        if (stockUpdateError) {
          console.error('Stock update error:', stockUpdateError);
          // Rollback order and items
          await client.from('order_items').delete().eq('order_id', createdOrder.id);
          await client.from('orders').delete().eq('id', createdOrder.id);
          throw new Error('Failed to update product stock. Item may be out of stock.');
        }

        stockUpdated = true;
        console.log(`✅ Stock updated for product ${wishlistItem.product_id}: ${currentStock} -> ${newStock}`);
      }
    } catch (stockError: any) {
      // Rollback order and items if stock update fails
      await client.from('order_items').delete().eq('order_id', createdOrder.id);
      await client.from('orders').delete().eq('id', createdOrder.id);
      throw stockError;
    }

    // 🔥 FIX: Use process_wallet_transaction helper for proper escrow handling (consistent with other flows)
    // Note: createdOrder.id is already validated as a valid UUID above, so we can use it directly
    console.log('💳 Processing wallet transaction:', {
      userId: giftGiverId,
      amount: total,
      orderId: createdOrder.id,
      orderNumber: createdOrder.order_number,
    });
    
    const walletResult = await this.walletService.processWalletTransaction(
      giftGiverId,
      WalletTransactionType.PURCHASE_HOLD, // Moves money to escrow
      total,
      `Gift purchase: ${(wishlistItem as any).products.name} for ${recipientUser.username}`,
      createdOrder.id, // Already validated as valid UUID above
      'order',
    );

    if (!walletResult.success) {
      console.error('Wallet transaction error:', walletResult.error);
      // Rollback order, items, and stock
      await client.from('order_items').delete().eq('order_id', createdOrder.id);
      await client.from('orders').delete().eq('id', createdOrder.id);
      
      // 🔥 FIX: Rollback stock if it was updated (use service client)
      if (stockUpdated) {
        try {
          const { data: currentProduct } = await serviceClient
            .from('products')
            .select('quantity')
            .eq('id', wishlistItem.product_id)
            .maybeSingle();
          
          if (currentProduct) {
            const currentStock = currentProduct.quantity;
            
            await serviceClient
              .from('products')
              .update({
                quantity: currentStock !== null ? currentStock + 1 : 1,
                updated_at: new Date().toISOString(),
              })
              .eq('id', wishlistItem.product_id);
            console.log(`✅ Stock rolled back for product ${wishlistItem.product_id}`);
          }
        } catch (rollbackError) {
          console.error('⚠️ Failed to rollback stock (non-critical):', rollbackError);
        }
      }
      
      throw new Error('Payment processing failed');
    }

    console.log(`✅ Wallet payment processed via RPC:`, {
      transactionId: walletResult.transactionId,
      success: walletResult.success,
    });

    // 🔥 FIX: Create escrow for the order - platform fee deducted from vendor, not added to buyer total
    // Make escrow creation critical - if it fails, we need to rollback payment
    let escrowCreated = false;
    try {
      // Calculate rider commission (10% of rider earnings)
      const riderCommission = riderId && deliveryFee > 0
        ? deliveryFee * this.PLATFORM_COMMISSION_RATE
        : 0;

      const escrowBreakdown = {
        totalAmount: total, // Buyer paid item price + delivery fee (if rider selected)
        vendorAmount: itemPrice - platformFee, // Vendor receives item price minus platform fee
        riderAmount: deliveryFee - riderCommission, // Rider gets delivery fee minus platform commission
        platformAmount: platformFee + riderCommission, // Platform gets vendor commission + rider commission
      };
      await this.escrowService.createEscrow(createdOrder.id, escrowBreakdown);
      escrowCreated = true;
      console.log(`✅ Escrow created for wishlist gift order ${createdOrder.id}`);
      
      // ✅ GENERATE HANDOFF PINS (3-digit) for gift orders
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
        .eq('id', createdOrder.id);
      
      console.log(`✅ Generated handoff PINs for gift order ${createdOrder.id}`);
      
      // ✅ SEND PINs VIA NOTIFICATIONS
      try {
        // Get vendor name for notifications
        const { data: vendorProfile } = await client
          .from('user_profiles')
          .select('username')
          .eq('id', vendorId)
          .single();
        
        // Handle PIN notifications based on delivery type
        if (deliveryType === 'pickup') {
          // Self-pickup: Send deliveryPin to BOTH vendor and recipient
          // Recipient provides deliveryPin to vendor for handoff verification
          
          // Send deliveryPin to vendor (for verification)
          await this.notificationHelper.notifyVendorSelfPickupPin(vendorId, {
            id: createdOrder.id,
            orderNumber: createdOrder.order_number,
            deliveryPin: deliveryPin,
            buyerName: recipientUser.username,
          });
          
          // Send deliveryPin to recipient (they need it to pick up)
          await this.notificationHelper.notifyBuyerSelfPickupPin(actualRecipientId, {
            id: createdOrder.id,
            orderNumber: createdOrder.order_number,
            deliveryPin: deliveryPin,
            vendorName: vendorProfile?.username || 'Vendor',
          });
          
          console.log(`✅ Sent self-pickup PIN to vendor and recipient for gift order ${createdOrder.id}`);
        } else if (riderId) {
          // Regular delivery with rider: Send pickup PIN to rider, delivery PIN to recipient
          
          // Send pickup PIN to rider
          await this.notificationHelper.notifyRiderPickupPin(riderId, {
            id: createdOrder.id,
            orderNumber: createdOrder.order_number,
            pickupPin: pickupPin,
            vendorName: vendorProfile?.username || 'Vendor',
          });
          
          // Send delivery PIN to recipient
          await this.notificationHelper.notifyBuyerDeliveryPin(actualRecipientId, {
            id: createdOrder.id,
            orderNumber: createdOrder.order_number,
            deliveryPin: deliveryPin,
          });
          
          console.log(`✅ Sent pickup PIN to rider and delivery PIN to recipient for gift order ${createdOrder.id}`);
        } else {
          // Delivery type but no rider (edge case) - send delivery PIN to recipient
          await this.notificationHelper.notifyBuyerDeliveryPin(actualRecipientId, {
            id: createdOrder.id,
            orderNumber: createdOrder.order_number,
            deliveryPin: deliveryPin,
          });
        }
      } catch (pinNotifyError) {
        console.error('Failed to send PIN notifications (non-critical):', pinNotifyError);
        // Don't fail the order creation if PIN notifications fail
      }
    } catch (escrowError) {
      console.error('Failed to create escrow for wishlist order:', escrowError);
      // 🔥 FIX: If escrow creation fails, we need to refund the payment
      // Payment is in escrow via RPC, so we need to refund it
      try {
        // Try to find escrow record (may not exist if RPC didn't create one in escrows table)
        const { data: escrowRecord, error: escrowRecordError } = await client
          .from('escrows')
          .select('id, status')
          .eq('order_id', createdOrder.id)
          .maybeSingle();

        if (escrowRecordError && escrowRecordError.code !== 'PGRST116') {
          console.error('⚠️ Error checking escrow record:', escrowRecordError);
        }

        if (escrowRecord && escrowRecord.status === 'held') {
          // Refund via escrow service
          await this.escrowService.refundEscrow(escrowRecord.id, 'Escrow creation failed');
          console.log(`✅ Escrow refunded due to creation failure`);
        } else {
          // No escrow record exists - refund via wallet RPC
          // The RPC moved money to escrow in wallet, so we need to refund it via RPC
          try {
            const refundResult = await this.walletService.processWalletTransaction(
              giftGiverId,
              WalletTransactionType.ESCROW_REFUND,
              total,
              `Refund: Escrow creation failed for order ${createdOrder.id}`,
              createdOrder.id,
              'order',
            );

            if (!refundResult.success) {
              console.error('⚠️ Failed to refund via wallet:', refundResult.error);
            } else {
              console.log(`✅ Payment refunded via wallet RPC`);
            }
          } catch (rpcError) {
            console.error('⚠️ Failed to refund via wallet RPC:', rpcError);
          }
        }
      } catch (refundError) {
        console.error('⚠️ Failed to refund escrow after creation failure:', refundError);
      }

      // Rollback order, items, and stock
      await client.from('order_items').delete().eq('order_id', createdOrder.id);
      await client.from('orders').delete().eq('id', createdOrder.id);
      
      // Rollback stock (use service client)
      if (stockUpdated) {
        try {
          const { data: currentProduct } = await serviceClient
            .from('products')
            .select('quantity')
            .eq('id', wishlistItem.product_id)
            .maybeSingle();
          
          if (currentProduct) {
            const currentStock = currentProduct.quantity;
            
            await serviceClient
              .from('products')
              .update({
                quantity: currentStock !== null ? currentStock + 1 : 1,
                updated_at: new Date().toISOString(),
              })
              .eq('id', wishlistItem.product_id);
          }
        } catch (rollbackError) {
          console.error('⚠️ Failed to rollback stock after escrow failure:', rollbackError);
        }
      }

      throw new Error('Failed to create escrow. Payment has been refunded.');
    }

    // 🔥 FIX: Order status stays 'pending' (already set above) - no need to update here
    // Status will change to 'confirmed' when vendor accepts the order

    // 🔥 FIX: Check for duplicate gift order again right before creating gift_orders record (use service client)
    // This prevents race conditions where two requests pass the initial check
    const { data: duplicateCheck, error: duplicateCheckError } = await serviceClient
      .from('gift_orders')
      .select('id')
      .eq('wishlist_item_id', wishlistItemId)
      .maybeSingle();

    if (duplicateCheckError && duplicateCheckError.code !== 'PGRST116') {
      console.error('⚠️ Error checking for duplicate gift order:', duplicateCheckError);
      // Continue - this is a non-critical check, but log the error
    }

    if (duplicateCheck) {
      // Rollback everything - order, items, stock, escrow, payment
      console.error('⚠️ Duplicate gift order detected right before creation. Rolling back...');
      
      // Refund escrow
      try {
        const { data: escrowRecord, error: escrowRecordError } = await client
          .from('escrows')
          .select('id, status')
          .eq('order_id', createdOrder.id)
          .maybeSingle();

        if (escrowRecordError && escrowRecordError.code !== 'PGRST116') {
          console.error('⚠️ Error checking escrow record for duplicate:', escrowRecordError);
        }

        if (escrowRecord && escrowRecord.status === 'held') {
          await this.escrowService.refundEscrow(escrowRecord.id, 'Duplicate gift order detected');
          console.log(`✅ Escrow refunded for duplicate gift order`);
        } else {
          // No escrow record exists - refund via wallet helper
          try {
            const refundResult = await this.walletService.processWalletTransaction(
              giftGiverId,
              WalletTransactionType.ESCROW_REFUND,
              total,
              `Refund: Duplicate gift order detected for order ${createdOrder.id}`,
              createdOrder.id,
              'order',
            );

            if (!refundResult.success) {
              console.error('⚠️ Failed to refund via wallet for duplicate:', refundResult.error);
            } else {
              console.log(`✅ Payment refunded via wallet for duplicate`);
            }
          } catch (rpcError) {
            console.error('⚠️ Failed to refund via wallet RPC for duplicate:', rpcError);
          }
        }
      } catch (refundError) {
        console.error('⚠️ Failed to refund escrow for duplicate:', refundError);
      }

      // Delete order and items
      await client.from('order_items').delete().eq('order_id', createdOrder.id);
      await client.from('orders').delete().eq('id', createdOrder.id);
      
      // Rollback stock (use service client)
      if (stockUpdated) {
        try {
          const { data: currentProduct } = await serviceClient
            .from('products')
            .select('quantity')
            .eq('id', wishlistItem.product_id)
            .maybeSingle();
          
          if (currentProduct) {
            const currentStock = currentProduct.quantity;
            
            await serviceClient
              .from('products')
              .update({
                quantity: currentStock !== null ? currentStock + 1 : 1,
                updated_at: new Date().toISOString(),
              })
              .eq('id', wishlistItem.product_id);
          }
        } catch (rollbackError) {
          console.error('⚠️ Failed to rollback stock for duplicate:', rollbackError);
        }
      }

      throw new Error('A gift order already exists for this wishlist item');
    }

    // Create gift order record
    const { data: giftOrder, error: giftError } = await client
      .from('gift_orders')
      .insert({
        order_id: createdOrder.id,
        gift_giver_id: giftGiverId,
        gift_recipient_id: actualRecipientId,
        wishlist_item_id: wishlistItemId,
        gift_message: giftMessage,
        is_surprise: isSurprise,
        status: 'pending' // 🔥 FIX: Align with orders.status - order is pending vendor acceptance
      })
      .select(`
        *,
        giver:user_profiles!gift_giver_id (username),
        recipient:user_profiles!gift_recipient_id (username)
      `)
      .single();

    if (giftError) {
      console.error('Gift order record creation error:', giftError);
      // 🔥 FIX: If gift_orders record creation fails, we should NOT remove wishlist item
      // The order exists but gift_orders record doesn't - this is a data inconsistency
      // We'll log it but continue - the order is still valid
      console.warn('⚠️ Gift order created but gift_orders record failed. Order ID:', createdOrder.id);
      // Don't throw - order is valid, just missing gift_orders record
      // Note: Wishlist item cleanup will be skipped if giftOrder is null
    }

    // Send notification to gift recipient (if not a surprise)
    if (!isSurprise) {
      try {
        // Check recipient notification preferences
        const { data: notifPrefs } = await client
          .from('notification_settings')
          .select('order_notifications')
          .eq('user_id', actualRecipientId)
          .single();

        // Only send if user has order notifications enabled (default: true)
        const shouldSendNotification = !notifPrefs || notifPrefs.order_notifications !== false;

        if (shouldSendNotification) {
          await this.notificationsService.createNotification({
            user_id: actualRecipientId,
            type: NotificationType.ORDER,
            title: '🎁 You Received a Gift!',
            message: `${giverUser.username} sent you ${(wishlistItem as any).products?.name} as a gift!`,
            priority: NotificationPriority.HIGH,
            data: {
              gift_order_id: giftOrder?.id,
              gift_giver_id: giftGiverId,
              gift_giver_username: giverUser.username,
              product_id: wishlistItem.product_id,
              product_name: (wishlistItem as any).products?.name,
              wishlist_item_id: wishlistItemId,
              order_id: createdOrder.id,
              gift_message: giftMessage,
              is_surprise: isSurprise,
            },
            badge: 'gift'
          });
          console.log('💖 Gift notification sent to recipient:', actualRecipientId);
        } else {
          console.log('ℹ️ Gift notification skipped (user preference):', actualRecipientId);
        }
      } catch (notifError) {
        console.error('Error sending gift notification:', notifError);
        // Don't fail the gift order if notification fails
      }
    }

    // 🔥 FIX: Remove purchased wishlist item ONLY if gift_orders record was created successfully
    // This prevents orphaned orders (order exists but no gift_orders record)
    if (giftOrder && giftOrder.id) {
      try {
        await this.removePurchasedItems(actualRecipientId, [wishlistItemId], userToken);
        console.log(`✅ Removed purchased wishlist item ${wishlistItemId} from recipient's wishlist`);
      } catch (cleanupError) {
        console.error('⚠️ Failed to remove wishlist item after gift purchase (non-critical):', cleanupError);
        // Don't fail the gift order if cleanup fails
      }
    } else {
      console.warn('⚠️ Skipping wishlist item cleanup - gift_orders record was not created');
    }

    // 🔥 NEW: Emit WebSocket event for real-time wishlist updates
    if (giftOrder && giftOrder.id && createdOrder) {
      try {
        await this.realtimeGateway.notifyWishlistGiftOrderCreated({
          wishlistItemId: wishlistItemId,
          wishlistOwnerId: actualRecipientId,
          giftGiverId: giftGiverId,
          orderId: createdOrder.id,
          orderNumber: createdOrder.order_number,
          orderStatus: createdOrder.status || 'pending',
          productName: (wishlistItem as any).products?.name || 'Unknown Product',
        });
        console.log(`✅ WebSocket event emitted for wishlist gift order: ${createdOrder.order_number}`);
      } catch (wsError) {
        console.error('⚠️ Failed to emit WebSocket event for wishlist gift order (non-critical):', wsError);
        // Don't fail the gift order if WebSocket emission fails
      }
    }

    return {
      message: 'Gift purchase successful!',
      giftOrderId: giftOrder?.id,
      orderId: createdOrder.id,
      orderNumber: createdOrder.order_number,
      recipientName: recipientUser.username,
      productName: (wishlistItem as any).products?.name,
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
      wishlistItemId?: string;
      productImage?: string;
    }> = [];

    // 🔥 FIX: Track cumulative quantities per product for stock validation
    const productQuantities: Record<string, number> = {};

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
          .select('quantity, price, primary_image_url, images')
          .eq('id', canPurchase.productInfo.id)
          .maybeSingle();

        // 🔥 FIX: Check cumulative quantity for same product across multiple wishlist items
        const requestedQuantity = item.quantity || 1;
        const productId = canPurchase.productInfo.id;
        const currentRequestedTotal = (productQuantities[productId] || 0) + requestedQuantity;

        if (product && product.quantity !== null && product.quantity < currentRequestedTotal) {
          validationResults.push({
            wishlistItemId: item.wishlistItemId,
            valid: false,
            reason: `Only ${product.quantity} available in stock, but ${currentRequestedTotal} requested across selected items! 📦 The seller doesn't have enough of this item.`
          });
          continue;
        }

        // Track cumulative quantity for this product
        productQuantities[productId] = currentRequestedTotal;

        // 🔥 FIX: Step 3: Calculate price (item price only - no tax, no fees for gift purchases)
        // Use the price from the product query (most recent) to ensure accuracy
        const itemPrice = (product?.price || canPurchase.productInfo.price) * (item.quantity || 1);
        totalPrice += itemPrice;
        
        // Store the validated price in the result for use during purchase
        // This ensures the price used during purchase matches the validated price

        validationResults.push({
          wishlistItemId: item.wishlistItemId,
          valid: true,
          price: itemPrice,
          quantity: item.quantity || 1
        });

        availableItems.push({
          ...canPurchase.productInfo,
          wishlistItemId: item.wishlistItemId, // 🔥 FIX: Include wishlistItemId
          quantity: item.quantity || 1,
          price: itemPrice,
          productImage: product?.primary_image_url || (product?.images && product.images.length > 0 ? product.images[0] : null) || null // 🔥 FIX: Include productImage
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