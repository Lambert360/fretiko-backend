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