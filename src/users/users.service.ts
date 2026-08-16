import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { UpdateProfileDto, UserProfileResponse, PublicProfileResponse } from '../shared/dto/user-profile.dto';
import * as crypto from 'crypto';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';
import { EmbeddingService } from '../ai/core/embedding.service';

@Injectable()
export class UsersService {
  private supabase;
  private serviceSupabase; // Service role client for operations that need to bypass RLS
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private configService: ConfigService,
    private clientManager: SupabaseClientManager,
    private embeddingService: EmbeddingService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
    this.serviceSupabase = this.clientManager.getServiceClient();
  }

  async getProfile(userId: string): Promise<UserProfileResponse> {
    // SECURITY: Use service role to check if profile exists, but create with proper auth context
    const { data, error } = await this.serviceSupabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // SECURITY: Don't auto-create profiles in getProfile - this is a read operation
        // Let updateProfile handle profile creation with proper authentication
        console.log('Profile not found for user', userId, '- user needs to create profile');
        throw new NotFoundException('User profile not found. Please complete your profile setup.');
      }
      throw new Error(`Database error: ${error.message}`);
    }

    return this.mapToProfileResponse(data);
  }

  async getPublicProfile(userId: string): Promise<PublicProfileResponse> {
    // SECURITY: Use service role for public profile access (no sensitive data)
    const { data, error } = await this.serviceSupabase
      .from('user_profiles')
      .select('id, username, bio, avatar_url, bg_pic_url, location, is_seller, is_rider, created_at, display_name')
      .eq('id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // SECURITY: Don't auto-create profiles in public read operations
        // This prevents unauthorized profile creation
        console.log('Public profile not found for user', userId);
        throw new NotFoundException('User profile not found');
      }
      throw new Error(`Database error: ${error.message}`);
    }

    return {
      id: data.id,
      username: data.username || data.display_name || 'Unknown',
      bio: data.bio,
      avatarUrl: data.avatar_url,
      bgPicUrl: data.bg_pic_url,
      location: data.location,
      isSeller: data.is_seller,
      isRider: data.is_rider,
      createdAt: data.created_at,
    };
  }

  async getPublicProfileByUsername(username: string): Promise<PublicProfileResponse> {
    // SECURITY: Use service role for public profile access (no sensitive data)
    const { data, error } = await this.serviceSupabase
      .from('user_profiles')
      .select('id, username, bio, avatar_url, bg_pic_url, location, is_seller, is_rider, created_at, display_name')
      .ilike('username', username)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // SECURITY: Don't auto-create profiles in public read operations
        // This prevents unauthorized profile creation
        console.log('Public profile not found for username', username);
        throw new NotFoundException('User profile not found');
      }
      throw new Error(`Database error: ${error.message}`);
    }

    return {
      id: data.id,
      username: data.username || data.display_name || 'Unknown',
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
    console.log('🔐 Using serviceSupabase for profile operations (bypasses RLS)');
    
    // Check if profile exists for logging purposes
    const { data: profileCheck } = await this.serviceSupabase
      .from('user_profiles')
      .select('id, username')
      .eq('id', userId);
      
    console.log('Profile check for user', userId, ':', profileCheck);
    
    // If profile doesn't exist, we'll create it with upsert
    if (!profileCheck || profileCheck.length === 0) {
      console.log('Profile not found, will create new profile with upsert');
    } else if (profileCheck.length > 1) {
      throw new Error('Multiple profiles found for user. Please contact support.');
    }

    // SECURITY: Only allow profile creation for authenticated users with valid tokens
    // Check if this is a new profile creation
    const isNewProfile = !profileCheck || profileCheck.length === 0;
    
    if (isNewProfile) {
      // SECURITY: Verify user has valid authentication context
      if (!userToken) {
        console.error('SECURITY: Attempted to create profile without authentication token');
        throw new UnauthorizedException('Authentication required to create profile');
      }
      
      // SECURITY: Verify the token belongs to the user trying to create the profile
      // Use user-authenticated client only for token validation
      const tempClient = createUserSupabaseClient(this.configService, userToken);
      const { data: { user: tokenUser }, error: tokenError } = await tempClient.auth.getUser();
      if (tokenError || !tokenUser || tokenUser.id !== userId) {
        console.error('SECURITY: Token validation failed for profile creation', { 
          userId, 
          hasError: !!tokenError,
          hasUser: !!tokenUser,
          userIdMatch: tokenUser?.id === userId 
        });
        throw new UnauthorizedException('Invalid authentication token');
      }
      
      console.log('SECURITY: Creating new profile for authenticated user', userId);
    }
    
    // Normalize username to lowercase before any checks or writes
    if (updateData.username) {
      updateData.username = updateData.username.toLowerCase().trim();
    }

    // Check if username is taken (if username is being updated)
    // Only check if username is provided and different from existing (case-insensitive)
    const currentUsername = profileCheck?.[0]?.username?.toLowerCase() || '';
    if (updateData.username && (profileCheck?.length === 0 || updateData.username !== currentUsername)) {
      const { data: existingUser } = await this.serviceSupabase
        .from('user_profiles')
        .select('id')
        .ilike('username', updateData.username)
        .neq('id', userId)
        .single();

      if (existingUser) {
        throw new ConflictException('Username is already taken');
      }
    }

    // SECURITY: Use cryptographically secure random for usernames
    // EFFICIENCY: Generate random bytes once per call, not in loop
    const generateSecureUsername = () => {
      const timestamp = Date.now();
      const randomSuffix = crypto.randomBytes(4).toString('hex');
      return `user_${timestamp}_${randomSuffix}`;
    };
    
    // Prepare upsert data with snake_case for database
    const dbUpsertData: any = {
      id: userId, // Include ID for upsert
      user_role: 'citizen', // Default role for new profiles
      is_seller: false, // Default seller status
      is_rider: false, // Default rider status
      is_verified: false, // SECURITY: Don't auto-verify users
      email_confirmed: false, // SECURITY: Don't auto-confirm emails
      created_at: new Date().toISOString(), // For new profiles
      updated_at: new Date().toISOString(), // Always update this
    };
    
    // Add optional fields if provided
    if (updateData.username !== undefined) dbUpsertData.username = updateData.username;
    if (updateData.bio !== undefined) dbUpsertData.bio = updateData.bio;
    if (updateData.location !== undefined) dbUpsertData.location = updateData.location;
    if (updateData.phone !== undefined) dbUpsertData.phone = updateData.phone;
    if (updateData.dateOfBirth !== undefined) dbUpsertData.date_of_birth = updateData.dateOfBirth;
    if (updateData.gender !== undefined) dbUpsertData.gender = updateData.gender;
    if (updateData.isSeller !== undefined) dbUpsertData.is_seller = updateData.isSeller;
    if (updateData.isRider !== undefined) dbUpsertData.is_rider = updateData.isRider;
    if (updateData.avatarUrl !== undefined) dbUpsertData.avatar_url = updateData.avatarUrl;
    if (updateData.bgPicUrl !== undefined) dbUpsertData.bg_pic_url = updateData.bgPicUrl;
    if (updateData.preferences !== undefined) dbUpsertData.preferences = updateData.preferences;
    
    // Generate secure default username if not provided and creating new profile
    if (!updateData.username && isNewProfile) {
      dbUpsertData.username = generateSecureUsername();
    }
    
    // SECURITY: Don't log sensitive data in production
    if (process.env.NODE_ENV === 'development') {
      console.log('Upserting profile with data:', dbUpsertData);
    }

    // Use serviceSupabase to bypass RLS for database operations
    const { data, error } = await this.serviceSupabase
      .from('user_profiles')
      .upsert(dbUpsertData)
      .eq('id', userId)
      .select()
      .single();

    // SECURITY: Don't log sensitive data in production
    if (process.env.NODE_ENV === 'development') {
      console.log('Upsert result - data:', data, 'error:', error);
    }

    if (error) {
      console.error('Profile upsert error:', error);
      if (error.code === '23505' && error.message?.toLowerCase().includes('username')) {
        throw new ConflictException('Username is already taken');
      }
      throw new Error(`Database error: ${error.message}`);
    }

    if (!data) {
      console.error('No data returned from upsert for userId:', userId);
      // SCALABILITY: Add retry logic for transient failures
      throw new Error('Failed to create or update profile. Please try again.');
    }

    // SECURITY: Log successful profile creation for audit trail
    if (isNewProfile && process.env.NODE_ENV === 'production') {
      console.log('AUDIT: New profile created', { userId, timestamp: new Date().toISOString() });
    }

    // Generate embedding for vendor search if user is a seller (fire-and-forget)
    if (data.is_seller) {
      this.generateAndSaveVendorEmbedding(data.id, data).catch(err => {
        this.logger.warn(`Failed to generate embedding for vendor ${data.id}: ${err.message}`);
      });
    }

    return this.mapToProfileResponse(data);
  }

  async uploadAvatar(userId: string, file: Buffer, fileName: string, userToken?: string): Promise<string> {
    try {
      // Create unique filename
      const fileExt = fileName.split('.').pop();
      const uniqueFileName = `${userId}/${Date.now()}.${fileExt}`;

      // Upload to Supabase Storage
      const { data, error } = await this.serviceSupabase.storage
        .from('avatars')
        .upload(uniqueFileName, file, {
          contentType: `image/${fileExt}`,
          upsert: true, // Replace if exists
        });

      if (error) {
        throw new BadRequestException(`Upload failed: ${error.message}`);
      }

      // Get public URL
      const { data: urlData } = this.serviceSupabase.storage
        .from('avatars')
        .getPublicUrl(uniqueFileName);

      const avatarUrl = urlData.publicUrl;

      // Update user profile with new avatar URL using serviceSupabase
      await this.serviceSupabase
        .from('user_profiles')
        .update({ avatar_url: avatarUrl })
        .eq('id', userId);

      return avatarUrl;
    } catch (error) {
      throw new BadRequestException(`Avatar upload failed: ${error.message}`);
    }
  }

  async uploadBackground(userId: string, file: Buffer, fileName: string, userToken?: string): Promise<string> {
    try {
      // Create unique filename
      const fileExt = fileName.split('.').pop();
      const uniqueFileName = `${userId}/${Date.now()}.${fileExt}`;

      // Upload to Supabase Storage - using 'backgrounds' bucket
      const { data, error } = await this.serviceSupabase.storage
        .from('backgrounds')
        .upload(uniqueFileName, file, {
          contentType: `image/${fileExt}`,
          upsert: true, // Replace if exists
        });

      if (error) {
        throw new BadRequestException(`Background upload failed: ${error.message}`);
      }

      // Get public URL
      const { data: urlData } = this.serviceSupabase.storage
        .from('backgrounds')
        .getPublicUrl(uniqueFileName);

      const bgPicUrl = urlData.publicUrl;

      // Update user profile with new background URL using serviceSupabase
      await this.serviceSupabase
        .from('user_profiles')
        .update({ bg_pic_url: bgPicUrl })
        .eq('id', userId);

      return bgPicUrl;
    } catch (error) {
      throw new BadRequestException(`Background upload failed: ${error.message}`);
    }
  }

  async searchUsers(query: string, limit: number = 20): Promise<PublicProfileResponse[]> {
    const { data, error } = await this.serviceSupabase
      .from('user_profiles')
      .select('id, username, bio, avatar_url, location, is_seller, created_at, display_name')
      .or(`username.ilike.%${query}%,bio.ilike.%${query}%`)
      .not('id', 'in', '("00000000-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000003")')
      .limit(limit)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    return data.map(user => ({
      id: user.id,
      username: user.username || user.display_name || 'Unknown',
      bio: user.bio,
      avatarUrl: user.avatar_url,
      location: user.location,
      isSeller: user.is_seller,
      createdAt: user.created_at,
    }));
  }

  async deleteAccount(userId: string, userToken?: string): Promise<{ message: string; deletedData: any }> {
    console.log('🗑️ Starting account deletion for user:', userId);
    
    // ... (rest of the code remains the same)
    try {
      // Get user profile first to log what we're deleting
      const { data: profile } = await this.serviceSupabase
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
      const { error: productsError } = await this.serviceSupabase
        .from('products')
        .delete()
        .eq('user_id', userId);
      
      if (productsError) {
        console.error('Error deleting products:', productsError);
        throw new Error(`Failed to delete products: ${productsError.message}`);
      }
      
      // 2. Delete user's wishlist items
      console.log('🗑️ Deleting wishlist items...');
      const { error: wishlistError } = await this.serviceSupabase
        .from('wishlist')
        .delete()
        .eq('user_id', userId);
      
      if (wishlistError) {
        console.error('Error deleting wishlist:', wishlistError);
        throw new Error(`Failed to delete wishlist: ${wishlistError.message}`);
      }
      
      // 3. Delete user's cart items
      console.log('🗑️ Deleting cart items...');
      const { error: cartError } = await this.serviceSupabase
        .from('cart')
        .delete()
        .eq('user_id', userId);
      
      if (cartError) {
        console.error('Error deleting cart:', cartError);
        throw new Error(`Failed to delete cart: ${cartError.message}`);
      }
      
      // 4. Delete user's orders
      console.log('🗑️ Deleting orders...');
      const { error: ordersError } = await this.serviceSupabase
        .from('orders')
        .delete()
        .eq('user_id', userId);
      
      if (ordersError) {
        console.error('Error deleting orders:', ordersError);
        throw new Error(`Failed to delete orders: ${ordersError.message}`);
      }
      
      // 5. Delete user's connections
      console.log('🗑️ Deleting connections...');
      const { error: connectionsError } = await this.serviceSupabase
        .from('connections')
        .delete()
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      
      if (connectionsError) {
        console.error('Error deleting connections:', connectionsError);
        throw new Error(`Failed to delete connections: ${connectionsError.message}`);
      }
      
      // 6. Delete user's chat messages
      console.log('🗑️ Deleting chat messages...');
      const { error: messagesError } = await this.serviceSupabase
        .from('chat_messages')
        .delete()
        .eq('sender_id', userId);
      
      if (messagesError) {
        console.error('Error deleting messages:', messagesError);
        throw new Error(`Failed to delete messages: ${messagesError.message}`);
      }
      
      // 7. Delete user's notifications
      console.log('🗑️ Deleting notifications...');
      const { error: notificationsError } = await this.serviceSupabase
        .from('notifications')
        .delete()
        .eq('user_id', userId);
      
      if (notificationsError) {
        console.error('Error deleting notifications:', notificationsError);
        throw new Error(`Failed to delete notifications: ${notificationsError.message}`);
      }
      
      // 8. Delete user's wallet transactions
      console.log('🗑️ Deleting wallet transactions...');
      const { error: walletError } = await this.serviceSupabase
        .from('wallet_transactions')
        .delete()
        .eq('user_id', userId);
      
      if (walletError) {
        console.error('Error deleting wallet transactions:', walletError);
        throw new Error(`Failed to delete wallet transactions: ${walletError.message}`);
      }
      
      // 9. Delete user's wallet
      console.log('🗑️ Deleting wallet...');
      const { error: walletDeleteError } = await this.serviceSupabase
        .from('wallet')
        .delete()
        .eq('user_id', userId);
      
      if (walletDeleteError) {
        console.error('Error deleting wallet:', walletDeleteError);
        throw new Error(`Failed to delete wallet: ${walletDeleteError.message}`);
      }
      
      // 10. Delete user's profile (this should be last)
      console.log('🗑️ Deleting user profile...');
      const { error: profileError } = await this.serviceSupabase
        .from('user_profiles')
        .delete()
        .eq('id', userId);
      
      if (profileError) {
        console.error('Error deleting profile:', profileError);
        throw new Error(`Failed to delete profile: ${profileError.message}`);
      }
      
      // 11. Finally, delete the auth user from Supabase Auth
      console.log('🗑️ Deleting auth user...');
      const { error: authError } = await this.serviceSupabase.auth.admin.deleteUser(userId);
      
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
    const { data: warnings, error } = await this.serviceSupabase
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
      const { data: staffData, error: staffError } = await this.serviceSupabase
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
    const { data: warnings, error: warningsError } = await this.serviceSupabase
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
    const { data: user, error: userError } = await this.serviceSupabase
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

  private async generateAndSaveVendorEmbedding(vendorId: string, profileData: any): Promise<void> {
    const text = this.embeddingService.buildVendorText(profileData);
    const { embedding } = await this.embeddingService.embed(text);
    if (!embedding || embedding.length === 0) return;

    const { error } = await this.serviceSupabase
      .from('user_profiles')
      .update({
        embedding,
        embedding_text: text,
        embedding_updated_at: new Date().toISOString(),
      })
      .eq('id', vendorId);

    if (error) {
      this.logger.error(`Failed to save embedding for vendor ${vendorId}: ${error.message}`);
    } else {
      this.logger.debug(`Embedding generated for vendor ${vendorId}`);
    }
  }

  private mapToProfileResponse(data: any): UserProfileResponse {
    return {
      id: data.id,
      username: data.username || data.display_name || null,
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