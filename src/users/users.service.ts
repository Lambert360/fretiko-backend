import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { UpdateProfileDto, UserProfileResponse, PublicProfileResponse } from '../shared/dto/user-profile.dto';

@Injectable()
export class UsersService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async getProfile(userId: string): Promise<UserProfileResponse> {
    const { data, error } = await this.supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new NotFoundException('User profile not found');
      }
      throw new Error(`Database error: ${error.message}`);
    }

    return this.mapToProfileResponse(data);
  }

  async getPublicProfile(userId: string): Promise<PublicProfileResponse> {
    const { data, error } = await this.supabase
      .from('user_profiles')
      .select('id, username, bio, avatar_url, bg_pic_url, location, is_seller, is_rider, created_at')
      .eq('id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new NotFoundException('User profile not found');
      }
      throw new Error(`Database error: ${error.message}`);
    }

    return {
      id: data.id,
      username: data.username,
      bio: data.bio,
      avatarUrl: data.avatar_url,
      bgPicUrl: data.bg_pic_url,
      location: data.location,
      isSeller: data.is_seller,
      isRider: data.is_rider,
      createdAt: data.created_at,
    };
  }

  async updateProfile(userId: string, updateData: UpdateProfileDto, userToken?: string): Promise<UserProfileResponse> {
    // Create user-authenticated client - let Supabase handle all auth logic
    let client;
    if (userToken) {
      console.log('Creating user-authenticated client with token');
      client = createUserSupabaseClient(this.configService, userToken);
      
      // Verify the client can access user info
      const { data: { user: sessionUser }, error: userError } = await client.auth.getUser();
      if (userError) {
        console.error('Failed to verify user with token:', userError);
      }
      console.log('User client verification:', !!sessionUser, 'userId:', sessionUser?.id);
    } else {
      console.log('Using service role client');
      client = this.supabase; // Fallback to service role
    }
    // First check if profile exists
    const { data: profileCheck } = await client
      .from('user_profiles')
      .select('id, username')
      .eq('id', userId);
      
    console.log('Profile check for user', userId, ':', profileCheck);
    
    if (!profileCheck || profileCheck.length === 0) {
      throw new NotFoundException('User profile not found. Please try creating your profile first.');
    }
    
    if (profileCheck.length > 1) {
      throw new Error('Multiple profiles found for user. Please contact support.');
    }

    // Check if username is taken (if username is being updated)
    if (updateData.username && updateData.username !== profileCheck[0].username) {
      const { data: existingUser } = await client
        .from('user_profiles')
        .select('id')
        .eq('username', updateData.username)
        .neq('id', userId)
        .single();

      if (existingUser) {
        throw new ConflictException('Username is already taken');
      }
    }

    // Prepare update data with snake_case for database
    const dbUpdateData: any = {};
    if (updateData.username !== undefined) dbUpdateData.username = updateData.username;
    if (updateData.bio !== undefined) dbUpdateData.bio = updateData.bio;
    if (updateData.location !== undefined) dbUpdateData.location = updateData.location;
    if (updateData.phone !== undefined) dbUpdateData.phone = updateData.phone;
    if (updateData.dateOfBirth !== undefined) dbUpdateData.date_of_birth = updateData.dateOfBirth;
    if (updateData.gender !== undefined) dbUpdateData.gender = updateData.gender;
    if (updateData.isSeller !== undefined) dbUpdateData.is_seller = updateData.isSeller;
    // Include is_rider if it's being updated (can be true or false)
    if (updateData.isRider !== undefined) dbUpdateData.is_rider = updateData.isRider;
    if (updateData.avatarUrl !== undefined) dbUpdateData.avatar_url = updateData.avatarUrl;
    if (updateData.bgPicUrl !== undefined) dbUpdateData.bg_pic_url = updateData.bgPicUrl;
    if (updateData.preferences !== undefined) dbUpdateData.preferences = updateData.preferences;
    
    console.log('Updating profile with data:', dbUpdateData);

    // Use user-specific client for proper RLS context
    const { data, error } = await client
      .from('user_profiles')
      .update(dbUpdateData)
      .eq('id', userId)
      .select();

    console.log('Update result - data:', data, 'error:', error);

    if (error) {
      console.error('Profile update error:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    if (!data || data.length === 0) {
      console.error('No rows were updated for userId:', userId);
      throw new NotFoundException('User profile not found. Please try creating your profile first.');
    }

    if (data.length > 1) {
      console.error('Multiple profiles updated for userId:', userId);
      throw new Error('Multiple profiles found for user. Please contact support.');
    }

    return this.mapToProfileResponse(data[0]);
  }

  async uploadAvatar(userId: string, file: Buffer, fileName: string, userToken?: string): Promise<string> {
    // Create user-authenticated client for storage operations
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    
    try {
      // Create unique filename
      const fileExt = fileName.split('.').pop();
      const uniqueFileName = `${userId}/${Date.now()}.${fileExt}`;

      // Upload to Supabase Storage
      const { data, error } = await client.storage
        .from('avatars')
        .upload(uniqueFileName, file, {
          contentType: `image/${fileExt}`,
          upsert: true, // Replace if exists
        });

      if (error) {
        throw new BadRequestException(`Upload failed: ${error.message}`);
      }

      // Get public URL
      const { data: urlData } = client.storage
        .from('avatars')
        .getPublicUrl(uniqueFileName);

      const avatarUrl = urlData.publicUrl;

      // Update user profile with new avatar URL using user-authenticated client
      await client
        .from('user_profiles')
        .update({ avatar_url: avatarUrl })
        .eq('id', userId);

      return avatarUrl;
    } catch (error) {
      throw new BadRequestException(`Avatar upload failed: ${error.message}`);
    }
  }

  async uploadBackground(userId: string, file: Buffer, fileName: string, userToken?: string): Promise<string> {
    // Create user-authenticated client for storage operations
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    
    try {
      // Create unique filename
      const fileExt = fileName.split('.').pop();
      const uniqueFileName = `${userId}/${Date.now()}.${fileExt}`;

      // Upload to Supabase Storage - using 'backgrounds' bucket
      const { data, error } = await client.storage
        .from('backgrounds')
        .upload(uniqueFileName, file, {
          contentType: `image/${fileExt}`,
          upsert: true, // Replace if exists
        });

      if (error) {
        throw new BadRequestException(`Background upload failed: ${error.message}`);
      }

      // Get public URL
      const { data: urlData } = client.storage
        .from('backgrounds')
        .getPublicUrl(uniqueFileName);

      const bgPicUrl = urlData.publicUrl;

      // Update user profile with new background URL using user-authenticated client
      await client
        .from('user_profiles')
        .update({ bg_pic_url: bgPicUrl })
        .eq('id', userId);

      return bgPicUrl;
    } catch (error) {
      throw new BadRequestException(`Background upload failed: ${error.message}`);
    }
  }

  async searchUsers(query: string, limit: number = 20): Promise<PublicProfileResponse[]> {
    const { data, error } = await this.supabase
      .from('user_profiles')
      .select('id, username, bio, avatar_url, location, is_seller, created_at')
      .or(`username.ilike.%${query}%,bio.ilike.%${query}%`)
      .limit(limit)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    return data.map(user => ({
      id: user.id,
      username: user.username,
      bio: user.bio,
      avatarUrl: user.avatar_url,
      location: user.location,
      isSeller: user.is_seller,
      createdAt: user.created_at,
    }));
  }

  async deleteAccount(userId: string, userToken?: string): Promise<{ message: string; deletedData: any }> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;
    
    console.log('🗑️ Starting account deletion for user:', userId);
    
    try {
      // Get user profile first to log what we're deleting
      const { data: profile } = await client
        .from('user_profiles')
        .select('username, is_seller, is_rider')
        .eq('id', userId)
        .single();
      
      console.log('📋 Deleting account for:', profile?.username || 'Unknown user');
      
      const deletedData = {
        profile: profile,
        timestamp: new Date().toISOString(),
        userId: userId
      };
      
      // Start transaction-like deletion process
      // Note: Supabase doesn't have explicit transactions, so we'll do this step by step
      
      // 1. Delete user's products and related data
      console.log('🗑️ Deleting user products...');
      const { error: productsError } = await client
        .from('products')
        .delete()
        .eq('user_id', userId);
      
      if (productsError) {
        console.error('Error deleting products:', productsError);
        throw new Error(`Failed to delete products: ${productsError.message}`);
      }
      
      // 2. Delete user's wishlist items
      console.log('🗑️ Deleting wishlist items...');
      const { error: wishlistError } = await client
        .from('wishlist')
        .delete()
        .eq('user_id', userId);
      
      if (wishlistError) {
        console.error('Error deleting wishlist:', wishlistError);
        throw new Error(`Failed to delete wishlist: ${wishlistError.message}`);
      }
      
      // 3. Delete user's cart items
      console.log('🗑️ Deleting cart items...');
      const { error: cartError } = await client
        .from('cart')
        .delete()
        .eq('user_id', userId);
      
      if (cartError) {
        console.error('Error deleting cart:', cartError);
        throw new Error(`Failed to delete cart: ${cartError.message}`);
      }
      
      // 4. Delete user's orders
      console.log('🗑️ Deleting orders...');
      const { error: ordersError } = await client
        .from('orders')
        .delete()
        .eq('user_id', userId);
      
      if (ordersError) {
        console.error('Error deleting orders:', ordersError);
        throw new Error(`Failed to delete orders: ${ordersError.message}`);
      }
      
      // 5. Delete user's connections
      console.log('🗑️ Deleting connections...');
      const { error: connectionsError } = await client
        .from('connections')
        .delete()
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      
      if (connectionsError) {
        console.error('Error deleting connections:', connectionsError);
        throw new Error(`Failed to delete connections: ${connectionsError.message}`);
      }
      
      // 6. Delete user's chat messages
      console.log('🗑️ Deleting chat messages...');
      const { error: messagesError } = await client
        .from('chat_messages')
        .delete()
        .eq('sender_id', userId);
      
      if (messagesError) {
        console.error('Error deleting messages:', messagesError);
        throw new Error(`Failed to delete messages: ${messagesError.message}`);
      }
      
      // 7. Delete user's notifications
      console.log('🗑️ Deleting notifications...');
      const { error: notificationsError } = await client
        .from('notifications')
        .delete()
        .eq('user_id', userId);
      
      if (notificationsError) {
        console.error('Error deleting notifications:', notificationsError);
        throw new Error(`Failed to delete notifications: ${notificationsError.message}`);
      }
      
      // 8. Delete user's wallet transactions
      console.log('🗑️ Deleting wallet transactions...');
      const { error: walletError } = await client
        .from('wallet_transactions')
        .delete()
        .eq('user_id', userId);
      
      if (walletError) {
        console.error('Error deleting wallet transactions:', walletError);
        throw new Error(`Failed to delete wallet transactions: ${walletError.message}`);
      }
      
      // 9. Delete user's wallet
      console.log('🗑️ Deleting wallet...');
      const { error: walletDeleteError } = await client
        .from('wallet')
        .delete()
        .eq('user_id', userId);
      
      if (walletDeleteError) {
        console.error('Error deleting wallet:', walletDeleteError);
        throw new Error(`Failed to delete wallet: ${walletDeleteError.message}`);
      }
      
      // 10. Delete user's profile (this should be last)
      console.log('🗑️ Deleting user profile...');
      const { error: profileError } = await client
        .from('user_profiles')
        .delete()
        .eq('id', userId);
      
      if (profileError) {
        console.error('Error deleting profile:', profileError);
        throw new Error(`Failed to delete profile: ${profileError.message}`);
      }
      
      // 11. Finally, delete the auth user from Supabase Auth
      console.log('🗑️ Deleting auth user...');
      const { error: authError } = await client.auth.admin.deleteUser(userId);
      
      if (authError) {
        console.error('Error deleting auth user:', authError);
        // Don't throw here as the profile is already deleted
        console.warn('Auth user deletion failed, but profile data is deleted');
      }
      
      console.log('✅ Account deletion completed successfully');
      
      return {
        message: 'Account and all associated data have been permanently deleted',
        deletedData: deletedData
      };
      
    } catch (error: any) {
      console.error('❌ Account deletion failed:', error);
      throw new Error(`Account deletion failed: ${error.message}`);
    }
  }

  private mapToProfileResponse(data: any): UserProfileResponse {
    return {
      id: data.id,
      username: data.username,
      bio: data.bio,
      avatarUrl: data.avatar_url,
      bgPicUrl: data.bg_pic_url,
      location: data.location,
      phone: data.phone,
      dateOfBirth: data.date_of_birth,
      preferences: data.preferences || {},
      isSeller: data.is_seller,
      isRider: data.is_rider,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
}