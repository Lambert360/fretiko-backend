import { Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { ConfigService } from '@nestjs/config';
import {
  CreateConnectionDto,
  UpdateConnectionDto,
  ConnectionResponseDto,
  UserStatsDto,
  CreateClientRelationshipDto
} from './dto/connection.dto';
import { ConnectionStatus, UserConnection, ClientRelationship } from './entities/user-connection.entity';
import { NotificationHelperService } from '../notifications/notification-helper.service';

@Injectable()
export class ConnectionsService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
  ) {
    // Use base client - methods will use user-authenticated client when userToken is provided
    this.supabase = createSupabaseClient(this.configService);
  }

  async getUserStats(userId: string): Promise<UserStatsDto> {
    const { data, error } = await this.supabase
      .from('user_stats')
      .select('plugs_count, clients_count, connection_requests_count')
      .eq('id', userId)
      .single();

    if (error) {
      // If no stats found, return zeros (new user)
      if (error.code === 'PGRST116') {
        return {
          plugsCount: 0,
          clientsCount: 0,
          connectionRequestsCount: 0,
        };
      }
      throw new Error(`Failed to fetch user stats: ${error.message}`);
    }

    return {
      plugsCount: data.plugs_count || 0,
      clientsCount: data.clients_count || 0,
      connectionRequestsCount: data.connection_requests_count || 0,
    };
  }

  async createConnection(requesterId: string, dto: CreateConnectionDto, userToken?: string): Promise<ConnectionResponseDto> {
    console.log(`🔌 Creating connection request from ${requesterId} to ${dto.addresseeId}`);

    // Create user-authenticated client for RLS compliance
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    // Prevent self-connection
    if (requesterId === dto.addresseeId) {
      throw new ConflictException('Cannot connect to yourself');
    }

    // Check if connection already exists
    const { data: existing } = await client
      .from('user_connections')
      .select('*')
      .or(`and(requester_id.eq.${requesterId},addressee_id.eq.${dto.addresseeId}),and(requester_id.eq.${dto.addresseeId},addressee_id.eq.${requesterId})`)
      .single();

    if (existing) {
      console.log(`❌ Connection already exists:`, existing);
      throw new ConflictException('Connection already exists');
    }

    // Check if target user exists
    const { data: targetUser, error: userError } = await client
      .from('user_profiles')
      .select('id, username, avatar_url')
      .eq('id', dto.addresseeId)
      .single();

    if (userError || !targetUser) {
      console.log(`❌ Target user not found: ${dto.addresseeId}`);
      throw new NotFoundException('Target user not found');
    }

    // Create connection
    console.log(`📝 Inserting connection with status: ${ConnectionStatus.PENDING}`);
    const { data, error } = await client
      .from('user_connections')
      .insert({
        requester_id: requesterId,
        addressee_id: dto.addresseeId,
        status: ConnectionStatus.PENDING,
      })
      .select('*')
      .single();

    if (error) {
      console.log(`❌ Failed to create connection:`, error);
      throw new Error(`Failed to create connection: ${error.message}`);
    }

    console.log(`✅ Connection created successfully:`, data);

    // Get requester info for response
    const { data: requesterUser } = await client
      .from('user_profiles')
      .select('id, username, avatar_url')
      .eq('id', requesterId)
      .single();

    // Send notification to addressee about new connection request
    try {
      console.log(`📬 Sending connection request notification to ${dto.addresseeId}`);
      await this.notificationHelper.notifyConnectionRequest(dto.addresseeId, {
        id: requesterId,
        username: requesterUser?.username || 'Someone',
        avatar_url: requesterUser?.avatar_url,
        connection_request_id: data.id,
      });
      console.log(`✅ Notification sent successfully`);
    } catch (notificationError) {
      console.error('⚠️ Error sending connection request notification:', notificationError);
      // Don't throw error - connection was still created successfully
    }

    return {
      id: data.id,
      requesterId: data.requester_id,
      addresseeId: data.addressee_id,
      status: data.status,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      requester: requesterUser ? {
        id: requesterUser.id,
        username: requesterUser.username,
        avatarUrl: requesterUser.avatar_url,
      } : undefined,
      addressee: {
        id: targetUser.id,
        username: targetUser.username,
        avatarUrl: targetUser.avatar_url,
      },
    };
  }

  async updateConnection(userId: string, connectionId: string, dto: UpdateConnectionDto, userToken?: string): Promise<ConnectionResponseDto> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    // Get the connection first
    const { data: connection, error: fetchError } = await client
      .from('user_connections')
      .select('*')
      .eq('id', connectionId)
      .single();

    if (fetchError || !connection) {
      throw new NotFoundException('Connection not found');
    }

    // Only the addressee can accept/reject connections
    if (connection.addressee_id !== userId) {
      throw new ForbiddenException('Only the connection recipient can update this connection');
    }

    // Update connection
    const { data, error } = await client
      .from('user_connections')
      .update({ status: dto.status })
      .eq('id', connectionId)
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to update connection: ${error.message}`);
    }

    // If connection was accepted, send notification
    if (dto.status === ConnectionStatus.ACCEPTED) {
      try {
        // Get accepter's username and avatar for notification
        const { data: accepterProfile } = await client
          .from('user_profiles')
          .select('username, avatar_url')
          .eq('id', connection.addressee_id)
          .single();

        // Send notification to requester using helper method
        await this.notificationHelper.notifyConnectionAccepted(
          connection.requester_id,
          {
            id: connection.addressee_id,
            username: accepterProfile?.username || 'Someone',
            avatar_url: accepterProfile?.avatar_url,
          }
        );

        console.log(`✅ Connection accepted: Sent notification`);
      } catch (notificationError) {
        console.error('⚠️ Error sending notification:', notificationError);
        // Don't throw error - connection was still updated successfully
      }
    }

    return {
      id: data.id,
      requesterId: data.requester_id,
      addresseeId: data.addressee_id,
      status: data.status,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async getMyConnections(userId: string, userToken?: string): Promise<ConnectionResponseDto[]> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data, error } = await client
      .from('user_connections')
      .select(`
        *,
        requester:requester_id(id, username, bio, avatar_url, is_seller, is_rider),
        addressee:addressee_id(id, username, bio, avatar_url, is_seller, is_rider)
      `)
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      .eq('status', ConnectionStatus.ACCEPTED)
      .order('updated_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch connections: ${error.message}`);
    }

    return data.map(conn => ({
      id: conn.id,
      requesterId: conn.requester_id,
      addresseeId: conn.addressee_id,
      status: conn.status,
      createdAt: conn.created_at,
      updatedAt: conn.updated_at,
      requester: conn.requester ? {
        id: conn.requester.id,
        username: conn.requester.username,
        bio: conn.requester.bio,
        avatarUrl: conn.requester.avatar_url,
        isSeller: conn.requester.is_seller,
        isRider: conn.requester.is_rider,
      } : null,
      addressee: conn.addressee ? {
        id: conn.addressee.id,
        username: conn.addressee.username,
        bio: conn.addressee.bio,
        avatarUrl: conn.addressee.avatar_url,
        isSeller: conn.addressee.is_seller,
        isRider: conn.addressee.is_rider,
      } : null,
    }));
  }

  async getPendingRequests(userId: string, userToken?: string): Promise<ConnectionResponseDto[]> {
    console.log(`📥 Getting pending requests for user: ${userId}`);

    // Use user-authenticated client to respect RLS (industry standard)
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    console.log(`🔑 Using ${userToken ? 'user-authenticated' : 'base'} Supabase client`);

    // First, let's see ALL connections for debugging
    const { data: allConnections } = await client
      .from('user_connections')
      .select('*')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);

    console.log(`🔍 Total connections for user (all statuses): ${allConnections?.length || 0}`);
    if (allConnections && allConnections.length > 0) {
      console.log('All connections:', allConnections.map(c => ({
        id: c.id,
        requester: c.requester_id,
        addressee: c.addressee_id,
        status: c.status
      })));
    }

    const { data, error } = await client
      .from('user_connections')
      .select(`
        *,
        requester:requester_id(id, username, bio, avatar_url, is_seller, is_rider)
      `)
      .eq('addressee_id', userId)
      .eq('status', ConnectionStatus.PENDING)
      .order('created_at', { ascending: false});

    if (error) {
      console.error(`❌ Error fetching pending requests: ${error.message}`);
      throw new Error(`Failed to fetch pending requests: ${error.message}`);
    }

    console.log(`✅ Found ${data?.length || 0} pending requests where user is addressee`);
    console.log('Pending requests data:', JSON.stringify(data, null, 2));

    const result = data.map(conn => ({
      id: conn.id,
      requesterId: conn.requester_id,
      addresseeId: conn.addressee_id,
      status: conn.status,
      createdAt: conn.created_at,
      updatedAt: conn.updated_at,
      requester: conn.requester ? {
        id: conn.requester.id,
        username: conn.requester.username,
        bio: conn.requester.bio,
        avatarUrl: conn.requester.avatar_url,
        isSeller: conn.requester.is_seller,
        isRider: conn.requester.is_rider,
      } : null,
    }));

    console.log('✅ Mapped pending requests for frontend:', JSON.stringify(result, null, 2));
    return result;
  }

  async createClientRelationship(providerId: string, dto: CreateClientRelationshipDto): Promise<void> {
    // Check if relationship already exists
    const { data: existing } = await this.supabase
      .from('client_relationships')
      .select('*')
      .eq('provider_id', providerId)
      .eq('client_id', dto.clientId)
      .single();

    if (existing) {
      // Update existing relationship
      await this.supabase
        .from('client_relationships')
        .update({
          relationship_type: dto.relationshipType || existing.relationship_type,
          total_orders: (existing.total_orders || 0) + (dto.totalOrders || 1),
          total_spent: (existing.total_spent || 0) + (dto.totalSpent || 0),
          last_interaction: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      // Create new relationship
      const { error } = await this.supabase
        .from('client_relationships')
        .insert({
          provider_id: providerId,
          client_id: dto.clientId,
          relationship_type: dto.relationshipType || 'customer',
          total_orders: dto.totalOrders || 1,
          total_spent: dto.totalSpent || 0,
        });

      if (error) {
        throw new Error(`Failed to create client relationship: ${error.message}`);
      }
    }
  }

  async getClientRelationships(userId: string, userToken?: string): Promise<any[]> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get all users who plugged to current user (social followers)
    // These are users where current user is the addressee
    const { data: connections, error: connError } = await client
      .from('user_connections')
      .select(`
        *,
        requester:requester_id(id, username, bio, avatar_url, is_seller, is_rider)
      `)
      .eq('addressee_id', userId)
      .eq('status', 'accepted')
      .order('updated_at', { ascending: false });

    if (connError) {
      throw new Error(`Failed to fetch connections: ${connError.message}`);
    }

    // Get all business relationships (people who bought from current user)
    const { data: businessRelations, error: bizError } = await this.supabase
      .from('client_relationships')
      .select('*')
      .eq('provider_id', userId);

    if (bizError) {
      console.error('Error fetching business relationships:', bizError);
    }

    // Create a map of business metrics by client ID
    const businessMetricsMap = new Map();
    if (businessRelations) {
      businessRelations.forEach(rel => {
        businessMetricsMap.set(rel.client_id, {
          relationshipType: rel.relationship_type,
          totalOrders: rel.total_orders,
          totalSpent: rel.total_spent,
          lastInteraction: rel.last_interaction,
          createdAt: rel.created_at,
        });
      });
    }

    // Map connections to client list with business metrics where available
    const clientsFromConnections = connections.map(conn => {
      const clientId = conn.requester_id;
      const businessMetrics = businessMetricsMap.get(clientId);

      return {
        id: conn.id,
        providerId: userId,
        clientId: clientId,
        relationshipType: businessMetrics?.relationshipType || 'follower',
        totalOrders: businessMetrics?.totalOrders || 0,
        totalSpent: businessMetrics?.totalSpent || 0,
        lastInteraction: businessMetrics?.lastInteraction || conn.updated_at,
        createdAt: businessMetrics?.createdAt || conn.created_at,
        client: conn.requester ? {
          id: conn.requester.id,
          username: conn.requester.username,
          bio: conn.requester.bio,
          avatarUrl: conn.requester.avatar_url,
          isSeller: conn.requester.is_seller,
          isRider: conn.requester.is_rider,
        } : null,
      };
    });

    // Find business clients who are NOT connected (bought but not following)
    const connectedClientIds = new Set(connections.map(c => c.requester_id));
    const unconnectedBusinessClients: any[] = [];

    if (businessRelations) {
      for (const rel of businessRelations) {
        if (!connectedClientIds.has(rel.client_id)) {
          // This person bought from us but is not connected
          // Fetch their profile
          const { data: clientProfile } = await client
            .from('user_profiles')
            .select('id, username, bio, avatar_url, is_seller, is_rider')
            .eq('id', rel.client_id)
            .single();

          if (clientProfile) {
            unconnectedBusinessClients.push({
              id: rel.id,
              providerId: rel.provider_id,
              clientId: rel.client_id,
              relationshipType: rel.relationship_type,
              totalOrders: rel.total_orders,
              totalSpent: rel.total_spent,
              lastInteraction: rel.last_interaction,
              createdAt: rel.created_at,
              client: {
                id: clientProfile.id,
                username: clientProfile.username,
                bio: clientProfile.bio,
                avatarUrl: clientProfile.avatar_url,
                isSeller: clientProfile.is_seller,
                isRider: clientProfile.is_rider,
              },
            });
          }
        }
      }
    }

    // Combine and sort by last interaction
    const allClients = [...clientsFromConnections, ...unconnectedBusinessClients];
    allClients.sort((a, b) => {
      const dateA = new Date(a.lastInteraction || a.createdAt);
      const dateB = new Date(b.lastInteraction || b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });

    return allClients;
  }

  async deleteConnection(userId: string, connectionId: string, userToken?: string): Promise<void> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    // Get the connection first to verify ownership
    const { data: connection, error: fetchError } = await client
      .from('user_connections')
      .select('*')
      .eq('id', connectionId)
      .single();

    if (fetchError || !connection) {
      throw new NotFoundException('Connection not found');
    }

    // Only requester or addressee can delete
    if (connection.requester_id !== userId && connection.addressee_id !== userId) {
      throw new ForbiddenException('You can only delete your own connections');
    }

    const { error } = await client
      .from('user_connections')
      .delete()
      .eq('id', connectionId);

    if (error) {
      throw new Error(`Failed to delete connection: ${error.message}`);
    }
  }

  async getConnectionStatus(currentUserId: string, targetUserId: string, userToken?: string): Promise<{ status: string; connectionId?: string }> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    // Check if there's a connection between the two users
    const { data, error } = await client
      .from('user_connections')
      .select('*')
      .or(`and(requester_id.eq.${currentUserId},addressee_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},addressee_id.eq.${currentUserId})`)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 means no rows found
      throw new Error(`Failed to check connection status: ${error.message}`);
    }

    if (!data) {
      return { status: 'none' };
    }

    return {
      status: data.status,
      connectionId: data.id,
    };
  }

  /**
   * Accept all pending connection requests for a user
   */
  async acceptAllConnectionRequests(userId: string, userToken?: string): Promise<{ accepted: number; failed: number }> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get all pending requests for this user
    const { data: pendingConnections, error: fetchError } = await client
      .from('user_connections')
      .select('*')
      .eq('addressee_id', userId)
      .eq('status', ConnectionStatus.PENDING);

    if (fetchError) {
      throw new Error(`Failed to fetch pending requests: ${fetchError.message}`);
    }

    if (!pendingConnections || pendingConnections.length === 0) {
      return { accepted: 0, failed: 0 };
    }

    let accepted = 0;
    let failed = 0;

    // Accept each connection individually to trigger notifications and client relationships
    for (const connection of pendingConnections) {
      try {
        await this.updateConnection(
          userId,
          connection.id,
          { status: ConnectionStatus.ACCEPTED },
          userToken
        );
        accepted++;
      } catch (error) {
        console.error(`Failed to accept connection ${connection.id}:`, error);
        failed++;
      }
    }

    console.log(`✅ Accepted ${accepted} connection requests, ${failed} failed`);

    return { accepted, failed };
  }

  /**
   * Get relationship details between current user and target user
   * Includes connection info, business metrics, and recent orders
   */
  async getRelationshipDetails(currentUserId: string, targetUserId: string, userToken?: string): Promise<any> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Get connection status
    const connectionStatus = await this.getConnectionStatus(currentUserId, targetUserId, userToken);

    // Get user profile info
    const { data: targetProfile } = await client
      .from('user_profiles')
      .select('id, username, bio, avatar_url, is_seller, is_rider')
      .eq('id', targetUserId)
      .single();

    // Determine relationship type
    let relationshipType: 'plug' | 'client' | 'none' = 'none';
    let businessMetrics: any = null;
    let recentOrders: any[] = [];

    // Check if target is current user's client (they bought from me)
    const { data: clientRelation } = await this.supabase
      .from('client_relationships')
      .select('*')
      .eq('provider_id', currentUserId)
      .eq('client_id', targetUserId)
      .single();

    if (clientRelation) {
      relationshipType = 'client';
      businessMetrics = {
        totalOrders: clientRelation.total_orders,
        totalSpent: clientRelation.total_spent,
        relationshipStatus: clientRelation.relationship_type,
        lastOrderDate: clientRelation.last_interaction,
      };

      // Get recent orders
      const { data: orders } = await this.supabase
        .from('orders')
        .select('id, order_number, total, status, order_date, order_items(id, name, image, price, quantity)')
        .eq('buyer_id', targetUserId)
        .eq('seller_id', currentUserId)
        .order('order_date', { ascending: false })
        .limit(10);

      recentOrders = orders || [];
    } else {
      // Check if current user is target's client (I bought from them)
      const { data: reverseRelation } = await this.supabase
        .from('client_relationships')
        .select('*')
        .eq('provider_id', targetUserId)
        .eq('client_id', currentUserId)
        .single();

      if (reverseRelation) {
        relationshipType = 'plug';
        businessMetrics = {
          totalOrders: reverseRelation.total_orders,
          totalSpent: reverseRelation.total_spent,
          relationshipStatus: reverseRelation.relationship_type,
          lastOrderDate: reverseRelation.last_interaction,
        };

        // Get recent orders I made with them
        const { data: orders } = await this.supabase
          .from('orders')
          .select('id, order_number, total, status, order_date, order_items(id, name, image, price, quantity)')
          .eq('buyer_id', currentUserId)
          .eq('seller_id', targetUserId)
          .order('order_date', { ascending: false })
          .limit(10);

        recentOrders = orders || [];
      }
    }

    // Get connection date if connected
    let connectedSince = null;
    if (connectionStatus.connectionId) {
      const { data: connection } = await client
        .from('user_connections')
        .select('created_at, updated_at')
        .eq('id', connectionStatus.connectionId)
        .single();

      connectedSince = connection?.updated_at || connection?.created_at;
    }

    return {
      targetUser: targetProfile,
      connectionInfo: {
        status: connectionStatus.status,
        connectionId: connectionStatus.connectionId,
        connectedSince,
      },
      relationshipType,
      businessMetrics,
      recentOrders: recentOrders.map(order => ({
        id: order.id,
        orderNumber: order.order_number,
        total: order.total,
        status: order.status,
        date: order.order_date,
        items: order.order_items || [],
      })),
    };
  }

  /**
   * Get categorized connections for Plugs or Clients tab
   * Returns connections separated into categories
   */
  async getCategorizedConnections(userId: string, type: 'plugs' | 'clients', userToken?: string): Promise<any> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    if (type === 'plugs') {
      // For Plugs tab: Following + Patronage

      // Category 1: Following (social connections where I'm the requester)
      const { data: following } = await client
        .from('user_connections')
        .select(`
          *,
          addressee:addressee_id(id, username, bio, avatar_url, is_seller, is_rider)
        `)
        .eq('requester_id', userId)
        .eq('status', 'accepted')
        .order('updated_at', { ascending: false });

      // Category 2: Patronage (people I bought from)
      const { data: patronage } = await this.supabase
        .from('client_relationships')
        .select('*')
        .eq('client_id', userId); // I am the customer

      // Get user profiles for patronage
      const patronageUserIds = patronage?.map(p => p.provider_id) || [];
      let patronageUsers: any[] = [];
      if (patronageUserIds.length > 0) {
        const { data: users } = await client
          .from('user_profiles')
          .select('id, username, bio, avatar_url, is_seller, is_rider')
          .in('id', patronageUserIds);
        patronageUsers = users || [];
      }

      return {
        following: following?.map(conn => ({
          id: conn.id,
          user: conn.addressee,
          connectedAt: conn.updated_at,
        })) || [],
        patronage: patronage?.map(rel => ({
          id: rel.id,
          user: patronageUsers.find(u => u.id === rel.provider_id),
          totalOrders: rel.total_orders,
          totalSpent: rel.total_spent,
          lastPurchase: rel.last_interaction,
        })) || [],
      };
    } else {
      // For Clients tab: Followers + Patronage

      // Category 1: Followers (social connections where I'm the addressee)
      const { data: followers } = await client
        .from('user_connections')
        .select(`
          *,
          requester:requester_id(id, username, bio, avatar_url, is_seller, is_rider)
        `)
        .eq('addressee_id', userId)
        .eq('status', 'accepted')
        .order('updated_at', { ascending: false });

      // Category 2: Patronage (people who bought from me)
      const { data: patronage } = await this.supabase
        .from('client_relationships')
        .select('*')
        .eq('provider_id', userId); // I am the provider

      // Get user profiles for patronage
      const patronageUserIds = patronage?.map(p => p.client_id) || [];
      let patronageUsers: any[] = [];
      if (patronageUserIds.length > 0) {
        const { data: users } = await client
          .from('user_profiles')
          .select('id, username, bio, avatar_url, is_seller, is_rider')
          .in('id', patronageUserIds);
        patronageUsers = users || [];
      }

      return {
        followers: followers?.map(conn => ({
          id: conn.id,
          user: conn.requester,
          connectedAt: conn.updated_at,
        })) || [],
        patronage: patronage?.map(rel => ({
          id: rel.id,
          user: patronageUsers.find(u => u.id === rel.client_id),
          totalOrders: rel.total_orders,
          totalSpent: rel.total_spent,
          lastPurchase: rel.last_interaction,
        })) || [],
      };
    }
  }
}