import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import {
  CreateLivestreamDto,
  UpdateLivestreamDto,
  LivestreamResponseDto,
  LivestreamStatus,
} from './dto/chat.dto';

@Injectable()
export class LivestreamService {
  private supabase;
  private readonly logger = new Logger(LivestreamService.name);

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async createLivestream(userId: string, createLivestreamDto: CreateLivestreamDto, userToken?: string): Promise<LivestreamResponseDto> {
    this.logger.log(`Creating livestream for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user is participant in conversation
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', createLivestreamDto.conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new NotFoundException('Conversation not found or access denied');
      }

      // Create message for the livestream
      const { data: message, error: messageError } = await client
        .from('chat_messages')
        .insert({
          conversation_id: createLivestreamDto.conversationId,
          sender_id: userId,
          message_type: 'livestream',
          content: `🔴 Live: ${createLivestreamDto.title}`,
        })
        .select('id')
        .single();

      if (messageError) {
        this.logger.error('Failed to create livestream message:', messageError);
        throw new Error(`Database error: ${messageError.message}`);
      }

      // Create livestream record
      const { data: livestream, error: livestreamError } = await client
        .from('chat_livestreams')
        .insert({
          message_id: message.id,
          streamer_id: userId,
          conversation_id: createLivestreamDto.conversationId,
          title: createLivestreamDto.title,
          description: createLivestreamDto.description,
          status: createLivestreamDto.scheduledFor ? LivestreamStatus.SCHEDULED : LivestreamStatus.LIVE,
          thumbnail_url: createLivestreamDto.thumbnailUrl,
          scheduled_for: createLivestreamDto.scheduledFor,
          started_at: createLivestreamDto.scheduledFor ? null : new Date().toISOString(),
          metadata: createLivestreamDto.metadata || {},
        })
        .select(`
          id,
          message_id,
          streamer_id,
          conversation_id,
          title,
          description,
          status,
          thumbnail_url,
          stream_url,
          viewer_count,
          max_viewers,
          started_at,
          ended_at,
          scheduled_for,
          created_at,
          updated_at,
          metadata,
          user_profiles!inner (
            id,
            username,
            avatar_url
          )
        `)
        .single();

      if (livestreamError) {
        this.logger.error('Failed to create livestream:', livestreamError);
        // Cleanup message
        await client.from('chat_messages').delete().eq('id', message.id);
        throw new Error(`Database error: ${livestreamError.message}`);
      }

      // Generate stream URL (would integrate with streaming service like Agora, Twilio, etc.)
      const streamUrl = await this.generateStreamUrl(livestream.id);
      
      // Update livestream with stream URL
      await client
        .from('chat_livestreams')
        .update({ stream_url: streamUrl })
        .eq('id', livestream.id);

      livestream.stream_url = streamUrl;

      this.logger.log(`Livestream created successfully: ${livestream.id}`);
      return this.mapLivestreamResponse(livestream, false);
    } catch (error) {
      this.logger.error('Error creating livestream:', error);
      throw error;
    }
  }

  async getLivestream(userId: string, livestreamId: string, userToken?: string): Promise<LivestreamResponseDto> {
    this.logger.log(`Fetching livestream: ${livestreamId} for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: livestream, error } = await client
        .from('chat_livestreams')
        .select(`
          id,
          message_id,
          streamer_id,
          conversation_id,
          title,
          description,
          status,
          thumbnail_url,
          stream_url,
          viewer_count,
          max_viewers,
          started_at,
          ended_at,
          scheduled_for,
          created_at,
          updated_at,
          metadata,
          user_profiles!inner (
            id,
            username,
            avatar_url
          ),
          chat_conversations!inner (
            chat_participants!inner (
              user_id
            )
          )
        `)
        .eq('id', livestreamId)
        .single();

      if (error || !livestream) {
        throw new NotFoundException('Livestream not found');
      }

      // Check if user has access to the conversation
      const hasAccess = livestream.chat_conversations.chat_participants
        .some(p => p.user_id === userId);

      if (!hasAccess) {
        throw new NotFoundException('Access denied');
      }

      // Check if user is currently viewing
      const { data: viewer } = await client
        .from('livestream_viewers')
        .select('id')
        .eq('livestream_id', livestreamId)
        .eq('viewer_id', userId)
        .is('left_at', null)
        .single();

      return this.mapLivestreamResponse(livestream, !!viewer);
    } catch (error) {
      this.logger.error('Error fetching livestream:', error);
      throw error;
    }
  }

  async updateLivestream(userId: string, livestreamId: string, updateDto: UpdateLivestreamDto, userToken?: string): Promise<LivestreamResponseDto> {
    this.logger.log(`Updating livestream: ${livestreamId} by user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user owns the livestream
      const { data: livestream } = await client
        .from('chat_livestreams')
        .select('streamer_id, status')
        .eq('id', livestreamId)
        .single();

      if (!livestream) {
        throw new NotFoundException('Livestream not found');
      }

      if (livestream.streamer_id !== userId) {
        throw new BadRequestException('Access denied - you can only update your own livestreams');
      }

      // Prepare update data
      const updateData: any = {
        updated_at: new Date().toISOString(),
      };

      if (updateDto.status !== undefined) {
        updateData.status = updateDto.status;
        
        // Set timestamps based on status
        if (updateDto.status === LivestreamStatus.LIVE && livestream.status !== LivestreamStatus.LIVE) {
          updateData.started_at = new Date().toISOString();
        } else if (updateDto.status === LivestreamStatus.ENDED && livestream.status !== LivestreamStatus.ENDED) {
          updateData.ended_at = new Date().toISOString();
        }
      }

      if (updateDto.streamUrl !== undefined) {
        updateData.stream_url = updateDto.streamUrl;
      }

      if (updateDto.viewerCount !== undefined) {
        updateData.viewer_count = updateDto.viewerCount;
        // Update max viewers if current count exceeds it
        const { data: currentData } = await client
          .from('chat_livestreams')
          .select('max_viewers')
          .eq('id', livestreamId)
          .single();
        
        if (currentData && updateDto.viewerCount > currentData.max_viewers) {
          updateData.max_viewers = updateDto.viewerCount;
        }
      }

      if (updateDto.metadata !== undefined) {
        updateData.metadata = updateDto.metadata;
      }

      // Update livestream
      const { data: updatedLivestream, error } = await client
        .from('chat_livestreams')
        .update(updateData)
        .eq('id', livestreamId)
        .select(`
          id,
          message_id,
          streamer_id,
          conversation_id,
          title,
          description,
          status,
          thumbnail_url,
          stream_url,
          viewer_count,
          max_viewers,
          started_at,
          ended_at,
          scheduled_for,
          created_at,
          updated_at,
          metadata,
          user_profiles!inner (
            id,
            username,
            avatar_url
          )
        `)
        .single();

      if (error) {
        this.logger.error('Failed to update livestream:', error);
        throw new Error(`Database error: ${error.message}`);
      }

      this.logger.log(`Livestream updated successfully: ${livestreamId}`);
      return this.mapLivestreamResponse(updatedLivestream, false);
    } catch (error) {
      this.logger.error('Error updating livestream:', error);
      throw error;
    }
  }

  async joinLivestream(userId: string, livestreamId: string, userToken?: string): Promise<{ streamUrl: string; viewerCount: number }> {
    this.logger.log(`User ${userId} joining livestream: ${livestreamId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify livestream exists and user has access
      const { data: livestream, error: livestreamError } = await client
        .from('chat_livestreams')
        .select(`
          id,
          stream_url,
          viewer_count,
          status,
          chat_conversations!inner (
            chat_participants!inner (
              user_id
            )
          )
        `)
        .eq('id', livestreamId)
        .single();

      if (livestreamError || !livestream) {
        throw new NotFoundException('Livestream not found');
      }

      if (livestream.status !== LivestreamStatus.LIVE) {
        throw new BadRequestException('Livestream is not currently live');
      }

      // Check access
      const hasAccess = livestream.chat_conversations.chat_participants
        .some(p => p.user_id === userId);

      if (!hasAccess) {
        throw new BadRequestException('Access denied');
      }

      // Add viewer record (or update if already exists)
      const { error: viewerError } = await client
        .from('livestream_viewers')
        .upsert({
          livestream_id: livestreamId,
          viewer_id: userId,
          joined_at: new Date().toISOString(),
          left_at: null,
        });

      if (viewerError) {
        this.logger.error('Failed to add viewer:', viewerError);
      }

      // Update viewer count
      const newViewerCount = await this.updateViewerCount(livestreamId, userToken);

      this.logger.log(`User ${userId} joined livestream ${livestreamId} successfully`);
      return {
        streamUrl: livestream.stream_url,
        viewerCount: newViewerCount,
      };
    } catch (error) {
      this.logger.error('Error joining livestream:', error);
      throw error;
    }
  }

  async leaveLivestream(userId: string, livestreamId: string, userToken?: string): Promise<void> {
    this.logger.log(`User ${userId} leaving livestream: ${livestreamId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Update viewer record
      const { error } = await client
        .from('livestream_viewers')
        .update({
          left_at: new Date().toISOString(),
        })
        .eq('livestream_id', livestreamId)
        .eq('viewer_id', userId)
        .is('left_at', null);

      if (error) {
        this.logger.error('Failed to update viewer record:', error);
      }

      // Update viewer count
      await this.updateViewerCount(livestreamId, userToken);

      this.logger.log(`User ${userId} left livestream ${livestreamId} successfully`);
    } catch (error) {
      this.logger.error('Error leaving livestream:', error);
      throw error;
    }
  }

  async getConversationLivestreams(userId: string, conversationId: string, userToken?: string): Promise<LivestreamResponseDto[]> {
    this.logger.log(`Fetching livestreams for conversation: ${conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user has access to conversation
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new NotFoundException('Conversation not found or access denied');
      }

      const { data: livestreams, error } = await client
        .from('chat_livestreams')
        .select(`
          id,
          message_id,
          streamer_id,
          conversation_id,
          title,
          description,
          status,
          thumbnail_url,
          stream_url,
          viewer_count,
          max_viewers,
          started_at,
          ended_at,
          scheduled_for,
          created_at,
          updated_at,
          metadata,
          user_profiles!inner (
            id,
            username,
            avatar_url
          )
        `)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Database error: ${error.message}`);
      }

      // Check which livestreams user is currently viewing
      const livestreamIds = livestreams.map(ls => ls.id);
      const { data: viewerRecords } = await client
        .from('livestream_viewers')
        .select('livestream_id')
        .in('livestream_id', livestreamIds)
        .eq('viewer_id', userId)
        .is('left_at', null);

      const viewingSet = new Set(viewerRecords?.map(v => v.livestream_id) || []);

      return livestreams.map(ls => this.mapLivestreamResponse(ls, viewingSet.has(ls.id)));
    } catch (error) {
      this.logger.error('Error fetching conversation livestreams:', error);
      throw error;
    }
  }

  async deleteLivestream(userId: string, livestreamId: string, userToken?: string): Promise<void> {
    this.logger.log(`Deleting livestream: ${livestreamId} by user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user owns the livestream
      const { data: livestream } = await client
        .from('chat_livestreams')
        .select('streamer_id, message_id, status')
        .eq('id', livestreamId)
        .single();

      if (!livestream) {
        throw new NotFoundException('Livestream not found');
      }

      if (livestream.streamer_id !== userId) {
        throw new BadRequestException('Access denied - you can only delete your own livestreams');
      }

      // End livestream if it's still live
      if (livestream.status === LivestreamStatus.LIVE) {
        await this.updateLivestream(userId, livestreamId, { status: LivestreamStatus.ENDED }, userToken);
      }

      // Delete livestream record (cascading deletes will handle viewers)
      const { error: deleteError } = await client
        .from('chat_livestreams')
        .delete()
        .eq('id', livestreamId);

      if (deleteError) {
        throw new Error(`Failed to delete livestream: ${deleteError.message}`);
      }

      // Delete associated message
      await client
        .from('chat_messages')
        .delete()
        .eq('id', livestream.message_id);

      this.logger.log(`Livestream ${livestreamId} deleted successfully`);
    } catch (error) {
      this.logger.error('Error deleting livestream:', error);
      throw error;
    }
  }

  // Private helper methods
  private async generateStreamUrl(livestreamId: string): Promise<string> {
    // In production, this would integrate with streaming services like:
    // - Agora.io
    // - Twilio Video
    // - AWS Kinesis Video Streams
    // - WebRTC servers
    
    // For now, return a mock URL
    const baseUrl = this.configService.get('STREAMING_SERVICE_URL') || 'https://stream.fretiko.com';
    return `${baseUrl}/live/${livestreamId}`;
  }

  private async updateViewerCount(livestreamId: string, userToken?: string): Promise<number> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Count active viewers
      const { count, error } = await client
        .from('livestream_viewers')
        .select('id', { count: 'exact' })
        .eq('livestream_id', livestreamId)
        .is('left_at', null);

      if (error) {
        this.logger.error('Failed to count viewers:', error);
        return 0;
      }

      const viewerCount = count || 0;

      // Update livestream viewer count
      await client
        .from('chat_livestreams')
        .update({ 
          viewer_count: viewerCount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', livestreamId);

      return viewerCount;
    } catch (error) {
      this.logger.error('Error updating viewer count:', error);
      return 0;
    }
  }

  private mapLivestreamResponse(livestream: any, isViewerJoined: boolean = false): LivestreamResponseDto {
    return {
      id: livestream.id,
      messageId: livestream.message_id,
      streamerId: livestream.streamer_id,
      conversationId: livestream.conversation_id,
      title: livestream.title,
      description: livestream.description,
      status: livestream.status,
      thumbnailUrl: livestream.thumbnail_url,
      streamUrl: livestream.stream_url,
      viewerCount: livestream.viewer_count,
      maxViewers: livestream.max_viewers,
      startedAt: livestream.started_at,
      endedAt: livestream.ended_at,
      scheduledFor: livestream.scheduled_for,
      createdAt: livestream.created_at,
      updatedAt: livestream.updated_at,
      streamer: {
        id: livestream.user_profiles.id,
        username: livestream.user_profiles.username,
        avatarUrl: livestream.user_profiles.avatar_url,
      },
      isViewerJoined,
      metadata: livestream.metadata,
    };
  }

  // Get livestream analytics
  async getLivestreamAnalytics(userId: string, livestreamId: string, userToken?: string): Promise<any> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify ownership
      const { data: livestream } = await client
        .from('chat_livestreams')
        .select('streamer_id')
        .eq('id', livestreamId)
        .single();

      if (!livestream || livestream.streamer_id !== userId) {
        throw new BadRequestException('Access denied');
      }

      // Get viewer analytics
      const { data: viewers, error } = await client
        .from('livestream_viewers')
        .select(`
          viewer_id,
          joined_at,
          left_at,
          watch_duration,
          user_profiles (
            username
          )
        `)
        .eq('livestream_id', livestreamId)
        .order('joined_at', { ascending: false });

      if (error) {
        throw new Error(`Failed to fetch analytics: ${error.message}`);
      }

      // Calculate statistics
      const totalViewers = viewers?.length || 0;
      const averageWatchTime = viewers?.reduce((sum, v) => sum + (v.watch_duration || 0), 0) / totalViewers || 0;
      const peakViewers = await this.getPeakViewers(livestreamId);

      return {
        totalViewers,
        averageWatchTime,
        peakViewers,
        viewers: viewers?.map(v => ({
          username: v.user_profiles?.username,
          joinedAt: v.joined_at,
          leftAt: v.left_at,
          watchDuration: v.watch_duration,
        })),
      };
    } catch (error) {
      this.logger.error('Error fetching livestream analytics:', error);
      throw error;
    }
  }

  private async getPeakViewers(livestreamId: string): Promise<number> {
    const client = this.supabase;
    
    const { data: livestream } = await client
      .from('chat_livestreams')
      .select('max_viewers')
      .eq('id', livestreamId)
      .single();

    return livestream?.max_viewers || 0;
  }
}