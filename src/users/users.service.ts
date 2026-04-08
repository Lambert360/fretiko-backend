import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { UpdateProfileDto, UserProfileResponse, PublicProfileResponse } from '../shared/dto/user-profile.dto';

@Injectable()
export class UsersService {
  private supabase;
  private serviceSupabase; // Service role client for operations that need to bypass RLS

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
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

  /**
   * Get current user's warnings
   */
  async getMyWarnings(userId: string) {
    // First, get warnings without the problematic relationship
    const { data: warnings, error } = await this.supabase
      .from('user_warnings')
      .select(`
        id,
        severity,
        reason,
        related_content_id,
        related_content_type,
        created_at,
        warned_by
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch warnings: ${error.message}`);
    }

    // If no warnings or no staff references, return as-is
    if (!warnings || warnings.length === 0) {
      return [];
    }

    // Get unique staff IDs from warnings
    const staffIds = [...new Set(warnings
      .filter(w => w.warned_by)
      .map(w => w.warned_by)
    )];

    // Fetch staff information separately to avoid RLS recursion
    let staffMap: { [key: string]: any } = {};
    if (staffIds.length > 0) {
      const { data: staffData, error: staffError } = await this.supabase
        .from('staff_accounts')
        .select('id, full_name, email')
        .in('id', staffIds);

      if (!staffError && staffData) {
        staffMap = staffData.reduce((acc, staff) => {
          acc[staff.id] = staff;
          return acc;
        }, {});
      }
    }

    // Combine warnings with staff information
    return warnings.map((warning: any) => ({
      id: warning.id,
      severity: warning.severity,
      reason: warning.reason,
      relatedContentId: warning.related_content_id,
      relatedContentType: warning.related_content_type,
      createdAt: warning.created_at,
      warnedBy: warning.warned_by && staffMap[warning.warned_by]
        ? {
            id: staffMap[warning.warned_by].id,
            fullName: staffMap[warning.warned_by].full_name,
            email: staffMap[warning.warned_by].email,
          }
        : null,
    }));
  }

  /**
   * Get account status (warnings, suspension, ban)
   */
  async getAccountStatus(userId: string) {
    // Get warnings
    const { data: warnings, error: warningsError } = await this.supabase
      .from('user_warnings')
      .select('severity, created_at')
      .eq('user_id', userId);

    if (warningsError) {
      throw new Error(`Failed to fetch warning stats: ${warningsError.message}`);
    }

    const totalWarnings = warnings?.length || 0;
    const highCount = warnings?.filter((w) => w.severity === 'high').length || 0;
    const mediumCount = warnings?.filter((w) => w.severity === 'medium').length || 0;
    const lowCount = warnings?.filter((w) => w.severity === 'low').length || 0;

    const lastWarning = warnings && warnings.length > 0
      ? warnings.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
      : null;

    // Get user profile for suspension/ban status
    const { data: user, error: userError } = await this.supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (userError) {
      throw new Error(`Failed to fetch user profile: ${userError.message}`);
    }

    const isSuspended = user?.preferences?.isSuspended === true;
    const isDeleted = user?.preferences?.isDeleted === true;
    const accountStatus = isDeleted ? 'deleted' : isSuspended ? 'suspended' : 'active';

    return {
      accountStatus,
      warnings: {
        total: totalWarnings,
        high: highCount,
        medium: mediumCount,
        low: lowCount,
        lastWarningAt: lastWarning?.created_at || null,
      },
      suspension: isSuspended
        ? {
            isSuspended: true,
            suspendedAt: user?.preferences?.suspendedAt || null,
            suspendedBy: user?.preferences?.suspendedBy || null,
            suspensionReason: user?.preferences?.suspensionReason || null,
          }
        : {
            isSuspended: false,
          },
      deletion: isDeleted
        ? {
            isDeleted: true,
            deletedAt: user?.preferences?.deletedAt || null,
            deletedBy: user?.preferences?.deletedBy || null,
          }
        : {
            isDeleted: false,
          },
    };
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

  /**
   * Submit a suspension appeal
   */
  async submitAppeal(userId: string, appealReason: string, authenticatedUserId?: string): Promise<{ message: string; appealId: string }> {
    // Security: Ensure userId matches authenticated user (prevent users from appealing for others)
    if (authenticatedUserId && userId !== authenticatedUserId) {
      throw new ForbiddenException('You can only submit appeals for your own account');
    }

    // Input validation: Sanitize and validate appeal reason
    const sanitizedReason = appealReason.trim();
    if (!sanitizedReason || sanitizedReason.length < 10) {
      throw new BadRequestException('Appeal reason must be at least 10 characters long');
    }
    if (sanitizedReason.length > 5000) {
      throw new BadRequestException('Appeal reason must be less than 5000 characters');
    }

    // Use service role client to bypass RLS and avoid infinite recursion
    // Check if user is suspended
    const { data: user, error: userError } = await this.serviceSupabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      throw new NotFoundException('User not found');
    }

    const preferences = user.preferences || {};
    if (!preferences.isSuspended) {
      throw new BadRequestException('You can only appeal if your account is suspended');
    }

    // Check if user already has a pending appeal (use service client to avoid RLS recursion)
    const { data: existingAppeal } = await this.serviceSupabase
      .from('suspension_appeals')
      .select('id, status')
      .eq('user_id', userId)
      .in('status', ['pending', 'under_review'])
      .maybeSingle();

    if (existingAppeal) {
      throw new Error('You already have a pending appeal. Please wait for it to be reviewed.');
    }

    // Create appeal using service role client to bypass RLS
    // This prevents infinite recursion in RLS policies
    const { data: appeal, error: appealError } = await this.serviceSupabase
      .from('suspension_appeals')
      .insert({
        user_id: userId,
        suspension_reason: preferences.suspensionReason || null,
        appeal_reason: sanitizedReason, // Use sanitized reason
        status: 'pending',
      })
      .select('id')
      .single();

    if (appealError || !appeal) {
      throw new Error(`Failed to submit appeal: ${appealError?.message || 'Unknown error'}`);
    }

    return {
      message: 'Appeal submitted successfully. We will review it and get back to you.',
      appealId: appeal.id,
    };
  }

  /**
   * Get user's appeals
   * Uses service role client to bypass RLS and avoid infinite recursion
   */
  async getMyAppeals(userId: string, authenticatedUserId?: string): Promise<any[]> {
    // Security: Ensure userId matches authenticated user (prevent users from accessing others' appeals)
    if (authenticatedUserId && userId !== authenticatedUserId) {
      throw new ForbiddenException('You can only view your own appeals');
    }

    const { data: appeals, error } = await this.serviceSupabase
      .from('suspension_appeals')
      .select(`
        id,
        suspension_reason,
        appeal_reason,
        status,
        reviewed_by,
        reviewed_at,
        review_notes,
        created_at,
        updated_at,
        reviewed_by_staff:staff_accounts!reviewed_by(full_name, email)
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch appeals: ${error.message}`);
    }

    return appeals || [];
  }

  /**
   * Get appeal status for current user
   * Uses service role client to bypass RLS and avoid infinite recursion
   */
  async getAppealStatus(userId: string, authenticatedUserId?: string): Promise<{ hasPendingAppeal: boolean; latestAppeal: any | null }> {
    // Security: Ensure userId matches authenticated user (prevent users from accessing others' appeal status)
    if (authenticatedUserId && userId !== authenticatedUserId) {
      throw new ForbiddenException('You can only view your own appeal status');
    }

    const { data: appeals, error } = await this.serviceSupabase
      .from('suspension_appeals')
      .select('id, status, created_at, reviewed_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      throw new Error(`Failed to fetch appeal status: ${error.message}`);
    }

    const latestAppeal = appeals && appeals.length > 0 ? appeals[0] : null;
    const hasPendingAppeal = latestAppeal && ['pending', 'under_review'].includes(latestAppeal.status);

    return {
      hasPendingAppeal,
      latestAppeal,
    };
  }
}