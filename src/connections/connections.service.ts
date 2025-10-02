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

@Injectable()
export class ConnectionsService {
  private supabase;

  constructor(private configService: ConfigService) {
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
      throw new ConflictException('Connection already exists');
    }

    // Check if target user exists
    const { data: targetUser, error: userError } = await client
      .from('user_profiles')
      .select('id, username, avatar_url')
      .eq('id', dto.addresseeId)
      .single();

    if (userError || !targetUser) {
      throw new NotFoundException('Target user not found');
    }

    // Create connection
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
      throw new Error(`Failed to create connection: ${error.message}`);
    }

    // Get requester info for response
    const { data: requesterUser } = await client
      .from('user_profiles')
      .select('id, username, avatar_url')
      .eq('id', requesterId)
      .single();

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

    return {
      id: data.id,
      requesterId: data.requester_id,
      addresseeId: data.addressee_id,
      status: data.status,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async getMyConnections(userId: string): Promise<ConnectionResponseDto[]> {
    const { data, error } = await this.supabase
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

  async getPendingRequests(userId: string): Promise<ConnectionResponseDto[]> {
    const { data, error } = await this.supabase
      .from('user_connections')
      .select(`
        *,
        requester:requester_id(id, username, bio, avatar_url, is_seller, is_rider)
      `)
      .eq('addressee_id', userId)
      .eq('status', ConnectionStatus.PENDING)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch pending requests: ${error.message}`);
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
    }));
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

  async getClientRelationships(userId: string): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('client_relationships')
      .select(`
        *,
        provider:provider_id(id, username, bio, avatar_url, is_seller, is_rider),
        client:client_id(id, username, bio, avatar_url, is_seller, is_rider)
      `)
      .or(`provider_id.eq.${userId},client_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch client relationships: ${error.message}`);
    }

    return data.map(rel => ({
      id: rel.id,
      providerId: rel.provider_id,
      clientId: rel.client_id,
      relationshipType: rel.relationship_type,
      totalOrders: rel.total_orders,
      totalSpent: rel.total_spent,
      createdAt: rel.created_at,
      provider: rel.provider ? {
        id: rel.provider.id,
        username: rel.provider.username,
        bio: rel.provider.bio,
        avatarUrl: rel.provider.avatar_url,
        isSeller: rel.provider.is_seller,
        isRider: rel.provider.is_rider,
      } : null,
      client: rel.client ? {
        id: rel.client.id,
        username: rel.client.username,
        bio: rel.client.bio,
        avatarUrl: rel.client.avatar_url,
        isSeller: rel.client.is_seller,
        isRider: rel.client.is_rider,
      } : null,
    }));
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
}