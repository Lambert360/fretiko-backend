import { Injectable, NotFoundException, BadRequestException, Logger, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import {
  StartCallDto,
  UpdateCallDto,
  JoinCallDto,
  CallSessionResponseDto,
  CallStatus,
  CallType,
} from './dto/chat.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PushNotificationService } from '../notifications/push-notification.service';

@Injectable()
export class CallsService {
  private supabase;
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => RealtimeGateway))
    private realtimeGateway: RealtimeGateway,
    private pushNotificationService: PushNotificationService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async startCall(userId: string, startCallDto: StartCallDto, userToken?: string): Promise<CallSessionResponseDto> {
    this.logger.log(`Starting ${startCallDto.callType} call for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user is participant in conversation
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', startCallDto.conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new NotFoundException('Conversation not found or access denied');
      }

      // Verify all participants exist and have access
      const { data: participants } = await client
        .from('chat_participants')
        .select('user_id')
        .eq('conversation_id', startCallDto.conversationId)
        .in('user_id', startCallDto.participantIds);

      if (!participants || participants.length !== startCallDto.participantIds.length) {
        throw new BadRequestException('Some participants do not have access to this conversation');
      }

      // Create call session (using service role to bypass RLS)
      const { data: callSession, error: callError } = await this.supabase
        .from('chat_call_sessions')
        .insert({
          conversation_id: startCallDto.conversationId,
          initiator_id: userId,
          call_type: startCallDto.callType,
          status: CallStatus.CALLING,
          metadata: {
            participants: startCallDto.participantIds,
            createdAt: new Date().toISOString(),
          },
        })
        .select(`
          id,
          conversation_id,
          initiator_id,
          call_type,
          status,
          started_at,
          answered_at,
          ended_at,
          duration,
          end_reason,
          metadata
        `)
        .single();

      if (callError) {
        this.logger.error('Failed to create call session:', callError);
        throw new Error(`Database error: ${callError.message}`);
      }

      // Add call participants (using service role)
      const participantInserts = startCallDto.participantIds.map(participantId => ({
        call_session_id: callSession.id,
        user_id: participantId,
        is_muted: false,
        is_video_enabled: startCallDto.callType === CallType.VIDEO,
      }));

      const { error: participantsError } = await this.supabase
        .from('call_participants')
        .insert(participantInserts);

      if (participantsError) {
        this.logger.error('Failed to add call participants:', participantsError);
        // Cleanup call session
        await this.supabase.from('chat_call_sessions').delete().eq('id', callSession.id);
        throw new Error(`Failed to add participants: ${participantsError.message}`);
      }

      // Create system message in conversation (using service role)
      await this.supabase
        .from('chat_messages')
        .insert({
          conversation_id: startCallDto.conversationId,
          sender_id: userId,
          message_type: 'system',
          content: `📞 ${startCallDto.callType === CallType.VIDEO ? 'Video' : 'Voice'} call started`,
        });

      // Send call notifications to participants
      await this.notifyCallParticipants(
        callSession.id,
        'incoming_call',
        startCallDto.conversationId,
        callSession.call_type,
        userId
      );

      // Auto-end call after timeout (e.g., 60 seconds if no one answers)
      this.scheduleCallTimeout(callSession.id, 60000);

      this.logger.log(`Call session created successfully: ${callSession.id}`);
      
      // Generate Agora token for the call
      const agoraConfig = await this.generateAgoraCallToken(callSession.id, userId);
      
      return this.mapCallSessionResponse(callSession, [], agoraConfig);
    } catch (error) {
      this.logger.error('Error starting call:', error);
      throw error;
    }
  }

  async joinCall(userId: string, joinCallDto: JoinCallDto, userToken?: string): Promise<CallSessionResponseDto> {
    this.logger.log(`User ${userId} joining call: ${joinCallDto.callSessionId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify call session exists (using service role to bypass RLS initially)
      const { data: callSession, error: callError } = await this.supabase
        .from('chat_call_sessions')
        .select(`
          id,
          conversation_id,
          initiator_id,
          call_type,
          status,
          started_at
        `)
        .eq('id', joinCallDto.callSessionId)
        .single();

      if (callError || !callSession) {
        this.logger.error(`Failed to find call session ${joinCallDto.callSessionId}:`, callError);
        this.logger.error('Call session data:', callSession);
        throw new NotFoundException('Call session not found');
      }

      // Check if user is a participant in the conversation (not call_participants yet)
      const { data: conversationParticipant } = await this.supabase
        .from('chat_participants')
        .select('user_id')
        .eq('conversation_id', callSession.conversation_id)
        .eq('user_id', userId)
        .single();

      if (!conversationParticipant) {
        throw new BadRequestException('Access denied - you are not a participant in this conversation');
      }

      // Check call status
      if (callSession.status === CallStatus.ENDED) {
        throw new BadRequestException('Call has already ended');
      }

      // Update call status to connected if this is the first join
      let updateData: any = {};
      if (callSession.status === CallStatus.CALLING) {
        updateData = {
          status: CallStatus.CONNECTED,
          answered_at: new Date().toISOString(),
        };
      }

      if (Object.keys(updateData).length > 0) {
        await client
          .from('chat_call_sessions')
          .update(updateData)
          .eq('id', joinCallDto.callSessionId);
      }

      // Update participant record
      const { error: participantError } = await client
        .from('call_participants')
        .update({
          joined_at: new Date().toISOString(),
          left_at: null,
          is_muted: joinCallDto.isMuted || false,
          is_video_enabled: joinCallDto.isVideoEnabled || false,
        })
        .eq('call_session_id', joinCallDto.callSessionId)
        .eq('user_id', userId);

      if (participantError) {
        this.logger.error('Failed to update participant record:', participantError);
      }

      // Notify other participants
      await this.notifyCallParticipants(joinCallDto.callSessionId, 'participant_joined', {
        participantId: userId,
      });

      this.logger.log(`User ${userId} joined call ${joinCallDto.callSessionId} successfully`);
      return this.getCallSession(userId, joinCallDto.callSessionId, userToken);
    } catch (error) {
      this.logger.error('Error joining call:', error);
      throw error;
    }
  }

  async leaveCall(userId: string, callSessionId: string, userToken?: string): Promise<void> {
    this.logger.log(`User ${userId} leaving call: ${callSessionId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Update participant record
      await client
        .from('call_participants')
        .update({
          left_at: new Date().toISOString(),
        })
        .eq('call_session_id', callSessionId)
        .eq('user_id', userId);

      // Check if all participants have left
      const { data: activeParticipants } = await client
        .from('call_participants')
        .select('user_id')
        .eq('call_session_id', callSessionId)
        .is('left_at', null);

      // If no active participants, end the call
      if (!activeParticipants || activeParticipants.length === 0) {
        await this.endCall(callSessionId, 'all_participants_left');
      } else {
        // Notify remaining participants
        await this.notifyCallParticipants(callSessionId, 'participant_left', {
          participantId: userId,
        });
      }

      this.logger.log(`User ${userId} left call ${callSessionId} successfully`);
    } catch (error) {
      this.logger.error('Error leaving call:', error);
      throw error;
    }
  }

  async endCall(callSessionId: string, reason: string = 'ended', userToken?: string): Promise<void> {
    this.logger.log(`Ending call: ${callSessionId} - Reason: ${reason}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get call session details
      const { data: callSession } = await client
        .from('chat_call_sessions')
        .select('started_at, answered_at, conversation_id')
        .eq('id', callSessionId)
        .single();

      if (!callSession) {
        this.logger.warn(`Call session ${callSessionId} not found`);
        return;
      }

      // Calculate duration
      const endTime = new Date();
      const startTime = new Date(callSession.answered_at || callSession.started_at);
      const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

      // Update call session
      const { error: updateError } = await client
        .from('chat_call_sessions')
        .update({
          status: CallStatus.ENDED,
          ended_at: endTime.toISOString(),
          duration,
          end_reason: reason,
        })
        .eq('id', callSessionId);

      if (updateError) {
        this.logger.error('Failed to update call session:', updateError);
        return;
      }

      // Update all participants as left
      await client
        .from('call_participants')
        .update({
          left_at: endTime.toISOString(),
        })
        .eq('call_session_id', callSessionId)
        .is('left_at', null);

      // Create system message
      const durationText = duration > 60 
        ? `${Math.floor(duration / 60)}m ${duration % 60}s`
        : `${duration}s`;

      await client
        .from('chat_messages')
        .insert({
          conversation_id: callSession.conversation_id,
          sender_id: callSession.initiator_id, // Use system ID in production
          message_type: 'system',
          content: `📞 Call ended - Duration: ${durationText}`,
        });

      // Notify participants
      await this.notifyCallParticipants(callSessionId, 'call_ended', {
        duration,
        reason,
      });

      this.logger.log(`Call ${callSessionId} ended successfully`);
    } catch (error) {
      this.logger.error('Error ending call:', error);
    }
  }

  async getCallSession(userId: string, callSessionId: string, userToken?: string): Promise<CallSessionResponseDto> {
    this.logger.log(`Fetching call session: ${callSessionId} for user: ${userId}`);

    // Always use service role for fetching call sessions since we validate access manually
    const client = this.supabase;

    try {
      const { data: callSession, error } = await client
        .from('chat_call_sessions')
        .select(`
          id,
          conversation_id,
          initiator_id,
          call_type,
          status,
          started_at,
          answered_at,
          ended_at,
          duration,
          end_reason,
          metadata,
          call_participants (
            id,
            user_id,
            joined_at,
            left_at,
            is_muted,
            is_video_enabled,
            connection_quality
          )
        `)
        .eq('id', callSessionId)
        .single();

      if (error || !callSession) {
        throw new NotFoundException('Call session not found');
      }

      // Verify user is a participant in the CONVERSATION (not call_participants yet if they're joining)
      const { data: conversationParticipant } = await this.supabase
        .from('chat_participants')
        .select('user_id')
        .eq('conversation_id', callSession.conversation_id)
        .eq('user_id', userId)
        .single();

      if (!conversationParticipant) {
        this.logger.warn(`User ${userId} denied access to call ${callSessionId} - not a conversation participant`);
        throw new BadRequestException('Access denied - you are not a participant in this conversation');
      }

      // Generate Agora token for the call
      const agoraConfig = await this.generateAgoraCallToken(callSessionId, userId);
      
      return this.mapCallSessionResponse(callSession, callSession.call_participants, agoraConfig);
    } catch (error) {
      this.logger.error('Error fetching call session:', error);
      throw error;
    }
  }

  async updateCallSettings(
    userId: string, 
    callSessionId: string, 
    settings: { isMuted?: boolean; isVideoEnabled?: boolean }, 
    userToken?: string
  ): Promise<void> {
    this.logger.log(`Updating call settings for user ${userId} in call: ${callSessionId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const updateData: any = {};
      if (settings.isMuted !== undefined) updateData.is_muted = settings.isMuted;
      if (settings.isVideoEnabled !== undefined) updateData.is_video_enabled = settings.isVideoEnabled;

      if (Object.keys(updateData).length === 0) {
        return;
      }

      const { error } = await client
        .from('call_participants')
        .update(updateData)
        .eq('call_session_id', callSessionId)
        .eq('user_id', userId);

      if (error) {
        throw new Error(`Failed to update call settings: ${error.message}`);
      }

      // Notify other participants of settings change
      await this.notifyCallParticipants(callSessionId, 'participant_settings_changed', {
        participantId: userId,
        settings,
      });

      this.logger.log(`Call settings updated successfully for user ${userId}`);
    } catch (error) {
      this.logger.error('Error updating call settings:', error);
      throw error;
    }
  }

  async getConversationCalls(userId: string, conversationId: string, userToken?: string): Promise<CallSessionResponseDto[]> {
    this.logger.log(`Fetching calls for conversation: ${conversationId}`);

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

      const { data: callSessions, error } = await client
        .from('chat_call_sessions')
        .select(`
          id,
          conversation_id,
          initiator_id,
          call_type,
          status,
          started_at,
          answered_at,
          ended_at,
          duration,
          end_reason,
          metadata
        `)
        .eq('conversation_id', conversationId)
        .order('started_at', { ascending: false })
        .limit(50); // Limit to recent calls

      if (error) {
        throw new Error(`Database error: ${error.message}`);
      }

      // Note: For conversation calls list, we don't generate tokens (only needed when joining)
      return callSessions?.map(session => this.mapCallSessionResponse(session, [], undefined)) || [];
    } catch (error) {
      this.logger.error('Error fetching conversation calls:', error);
      throw error;
    }
  }

  // Private helper methods
  private async notifyCallParticipants(
    callSessionId: string,
    eventType: string,
    conversationIdOrData?: string | any,
    callTypeOrUndefined?: CallType,
    initiatorIdOrUndefined?: string
  ): Promise<void> {
    try {
      this.logger.log(`📞 Notifying participants of call ${callSessionId} about ${eventType}`);

      let conversationId: string | undefined;
      let callType: CallType | undefined;
      let initiatorId: string | undefined;

      // Check if third argument is a string (conversation ID) or an object (old style data)
      if (typeof conversationIdOrData === 'string') {
        conversationId = conversationIdOrData;
        callType = callTypeOrUndefined;
        initiatorId = initiatorIdOrUndefined;
      } else {
        // Old style call - third argument is data object, need to fetch call session
        conversationId = undefined;
        callType = undefined;
        initiatorId = undefined;
      }

      // If conversation ID not provided, fetch call session to get it
      if (!conversationId || !callType) {
        const { data: callSession, error } = await this.supabase
          .from('chat_call_sessions')
          .select('conversation_id, call_type, initiator_id')
          .eq('id', callSessionId)
          .single();

        if (error || !callSession) {
          this.logger.error(`❌ Failed to get call session ${callSessionId}:`, error?.message);
          return;
        }

        conversationId = callSession.conversation_id;
        callType = callSession.call_type;
        if (!initiatorId) {
          initiatorId = callSession.initiator_id;
        }
      }

      // Get initiator details if this is an incoming call
      let initiatorData: {
        id: string;
        username: string;
        full_name: string;
        avatar_url?: string | null;
      } | null = null;
      if (eventType === 'incoming_call' && initiatorId) {
        const { data: initiator } = await this.supabase
          .from('user_profiles')
          .select('id, username, avatar_url, full_name')
          .eq('id', initiatorId)
          .single();

        initiatorData = initiator || {
          id: initiatorId,
          username: 'Unknown User',
          full_name: 'Unknown User',
        };
      }

      // Broadcast call event via WebSocket to all participants in the conversation
      await this.realtimeGateway.notifyCallEvent(conversationId!, eventType, {
        callSessionId,
        callType,
        initiator: initiatorData,
      });

      // For incoming_call, also send a high-priority push notification so the callee
      // receives the alert even when the app is backgrounded or the device is locked.
      if (eventType === 'incoming_call' && initiatorId) {
        const { data: callees } = await this.supabase
          .from('chat_participants')
          .select('user_id')
          .eq('conversation_id', conversationId!)
          .neq('user_id', initiatorId);

        if (callees && callees.length > 0) {
          const callerName = initiatorData?.full_name || initiatorData?.username || 'Someone';
          const pushPromises = callees.map(({ user_id }) =>
            this.pushNotificationService.sendPushNotification(user_id, {
              title: `Incoming ${callType === CallType.VIDEO ? 'video' : 'voice'} call`,
              body: `${callerName} is calling you`,
              priority: 'high',
              sound: 'default',
              channelId: 'calls',
              data: {
                type: 'call_incoming',
                conversationId: conversationId!,
                callSessionId,
                callType,
                callerName,
                callerAvatar: initiatorData?.avatar_url || null,
              },
            }).catch(err =>
              this.logger.warn(`Push to callee ${user_id} failed: ${err.message}`)
            ),
          );
          await Promise.all(pushPromises);
        }
      }

      this.logger.log(`✅ Successfully notified participants of ${eventType} for call ${callSessionId}`);
    } catch (error) {
      this.logger.error(`❌ Error notifying call participants:`, error.stack || error.message);
    }
  }

  private scheduleCallTimeout(callSessionId: string, timeoutMs: number): void {
    // In production, use a job queue instead of setTimeout
    setTimeout(async () => {
      try {
        const { data: callSession } = await this.supabase
          .from('chat_call_sessions')
          .select('status')
          .eq('id', callSessionId)
          .single();

        // Only timeout if still in calling state
        if (callSession && callSession.status === CallStatus.CALLING) {
          await this.endCall(callSessionId, 'timeout');
        }
      } catch (error) {
        this.logger.error('Error handling call timeout:', error);
      }
    }, timeoutMs);
  }

  private mapCallSessionResponse(callSession: any, participants: any[] = [], agoraConfig?: any): CallSessionResponseDto {
    return {
      id: callSession.id,
      conversationId: callSession.conversation_id,
      initiatorId: callSession.initiator_id,
      callType: callSession.call_type,
      status: callSession.status,
      startedAt: callSession.started_at,
      answeredAt: callSession.answered_at,
      endedAt: callSession.ended_at,
      duration: callSession.duration || 0,
      endReason: callSession.end_reason,
      participants: participants.map(p => ({
        id: p.id,
        userId: p.user_id,
        joinedAt: p.joined_at,
        leftAt: p.left_at,
        isMuted: p.is_muted,
        isVideoEnabled: p.is_video_enabled,
        connectionQuality: p.connection_quality || 'good',
        user: {
          id: p.user_id,
          username: 'User', // Default value, could be fetched separately if needed
          avatarUrl: undefined,
        },
      })),
      initiator: {
        id: callSession.initiator_id,
        username: 'User', // Default value, could be fetched separately if needed
        avatarUrl: undefined,
      },
      metadata: callSession.metadata,
      agoraConfig: agoraConfig, // Include Agora configuration for calls
      rtcConfiguration: agoraConfig, // Backward compatibility with frontend
    };
  }

  // Get call statistics for analytics
  async getCallStats(userId: string, userToken?: string): Promise<any> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get calls where user was a participant
      const { data: userCalls } = await client
        .from('chat_call_sessions')
        .select(`
          id,
          call_type,
          status,
          duration,
          started_at,
          call_participants!inner (
            user_id
          )
        `)
        .eq('call_participants.user_id', userId)
        .gte('started_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()); // Last 30 days

      if (!userCalls) return null;

      // Calculate statistics
      const totalCalls = userCalls.length;
      const videoCalls = userCalls.filter(c => c.call_type === CallType.VIDEO).length;
      const audioCalls = userCalls.filter(c => c.call_type === CallType.AUDIO).length;
      const completedCalls = userCalls.filter(c => c.status === CallStatus.ENDED).length;
      const totalDuration = userCalls.reduce((sum, call) => sum + (call.duration || 0), 0);
      const averageDuration = totalCalls > 0 ? totalDuration / totalCalls : 0;

      return {
        totalCalls,
        videoCalls,
        audioCalls,
        completedCalls,
        totalDuration,
        averageDuration: Math.round(averageDuration),
        totalDurationFormatted: this.formatDuration(totalDuration),
        averageDurationFormatted: this.formatDuration(averageDuration),
        period: '30 days',
      };
    } catch (error) {
      this.logger.error('Error fetching call stats:', error);
      throw error;
    }
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Generate Agora RTC token for 1-on-1 calls
   * Uses Communication profile (not LiveBroadcasting)
   */
  private async generateAgoraCallToken(callSessionId: string, userId: string): Promise<{
    appId: string;
    channel: string;
    token: string;
    uid: number;
  }> {
    try {
      const appId = this.configService.get<string>('AGORA_APP_ID');
      const appCertificate = this.configService.get<string>('AGORA_APP_CERTIFICATE');

      if (!appId || !appCertificate) {
        this.logger.warn('Agora credentials not configured, call will use tokenless mode');
        // Return config without token (tokenless mode)
        const channelName = `call_${callSessionId}`;
        const uid = Math.abs(this.hashCode(userId)) % 1000000;
        return {
          appId: appId || '', // Ensure appId is always a string
          channel: channelName,
          token: '',
          uid,
        };
      }

      // Generate channel name for call (unique per call session)
      const channelName = `call_${callSessionId}`;
      
      // Generate unique UID (use numeric part of user ID hash)
      const uid = Math.abs(this.hashCode(userId)) % 1000000;
      
      // Token expires in 24 hours
      const expirationTimeInSeconds = 86400;
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

      // Generate Agora token for Communication profile (publisher role for both users)
      const { RtcTokenBuilder, RtcRole } = require('agora-token');
      const agoraRole = RtcRole.PUBLISHER; // Both users are publishers in Communication profile
      
      const token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCertificate,
        channelName,
        uid,
        agoraRole,
        privilegeExpiredTs
      );

      this.logger.log(`Agora token generated for call: ${callSessionId}`, {
        channel: channelName,
        uid,
        expiresAt: new Date(privilegeExpiredTs * 1000).toISOString(),
      });

      return {
        appId,
        channel: channelName,
        token,
        uid,
      };
    } catch (error) {
      this.logger.error('Error generating Agora call token:', error);
      // Return config without token if generation fails (tokenless mode for dev)
      const appId = this.configService.get<string>('AGORA_APP_ID') || '';
      const channelName = `call_${callSessionId}`;
      const uid = Math.abs(this.hashCode(userId)) % 1000000;
      return {
        appId,
        channel: channelName,
        token: '',
        uid,
      };
    }
  }

  /**
   * Hash string to number (for UID generation)
   */
  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }
}