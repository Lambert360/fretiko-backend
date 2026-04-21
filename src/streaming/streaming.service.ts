import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import * as crypto from 'crypto';

// Agora token generation utility
interface AgoraTokenConfig {
  appId: string;
  appCertificate: string;
  channelName: string;
  uid: number;
  role: number;
  expireTime: number;
}

@Injectable()
export class StreamingService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Generate Agora RTC Token
   */
  async generateAgoraToken(
    channelName: string,
    uid?: number,
    role: 'publisher' | 'subscriber' = 'subscriber',
    expireTime: number = 3600,
  ) {
    try {
      const appId = this.configService.get<string>('AGORA_APP_ID') ||
                   process.env.AGORA_APP_ID;
      const appCertificate = this.configService.get<string>('AGORA_APP_CERTIFICATE') ||
                            process.env.AGORA_APP_CERTIFICATE;

      if (!appId || !appCertificate) {
        throw new Error('Agora credentials not configured');
      }

      // Generate UID if not provided
      const userId = uid || this.generateUID();

      // Role mapping: publisher = 1, subscriber = 2
      const roleId = role === 'publisher' ? 1 : 2;

      // Calculate expiration timestamp
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const privilegeExpiredTs = currentTimestamp + expireTime;

      // Generate token using Agora algorithm
      const token = this.buildAgoraToken({
        appId,
        appCertificate,
        channelName,
        uid: userId,
        role: roleId,
        expireTime: privilegeExpiredTs,
      });

      return {
        token,
        channelName,
        uid: userId,
        appId,
        expiresAt: new Date(privilegeExpiredTs * 1000).toISOString(),
      };
    } catch (error) {
      console.error('Error generating Agora token:', error);
      throw error;
    }
  }

  /**
   * Build Agora RTC Token (simplified implementation)
   * In production, use the official Agora token generation library
   */
  private buildAgoraToken(config: AgoraTokenConfig): string {
    try {
      // This is a simplified implementation
      // In production, use: npm install agora-access-token

      const { appId, appCertificate, channelName, uid, role, expireTime } = config;

      // Create message to sign
      const message = `${appId}${channelName}${uid}${role}${expireTime}`;

      // Generate signature using HMAC-SHA256
      const signature = crypto
        .createHmac('sha256', appCertificate)
        .update(message)
        .digest('hex');

      // Create token structure (simplified)
      const tokenData = {
        appId,
        channelName,
        uid,
        role,
        expireTime,
        signature,
      };

      // Encode token as base64
      const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');

      return `agora_token_${token}`;
    } catch (error) {
      console.error('Error building Agora token:', error);
      throw new Error('Failed to build token');
    }
  }

  /**
   * Generate random UID for Agora
   */
  private generateUID(): number {
    return Math.floor(Math.random() * 4294967295); // Max uint32
  }

  /**
   * Verify user has access to stream
   */
  async verifyStreamAccess(
    userId: string,
    streamId: string,
    role: 'publisher' | 'subscriber',
    userToken?: string,
  ): Promise<boolean> {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data: stream, error } = await supabaseClient
        .from('live_streams')
        .select('*')
        .eq('id', streamId)
        .single();

      if (error || !stream) {
        throw new Error('Stream not found');
      }

      // Publishers must be the stream owner
      if (role === 'publisher' && stream.vendor_id !== userId) {
        throw new Error('Unauthorized: Not stream owner');
      }

      // Subscribers can join if stream is active and not private
      if (role === 'subscriber') {
        if (stream.status !== 'active') {
          throw new Error('Stream not active');
        }

        if (stream.is_private) {
          // Check if user has permission for private stream
          const { data: permission } = await supabaseClient
            .from('stream_permissions')
            .select('*')
            .eq('stream_id', streamId)
            .eq('user_id', userId)
            .single();

          if (!permission) {
            throw new Error('Unauthorized: Private stream access denied');
          }
        }
      }

      return true;
    } catch (error) {
      console.error('Error verifying stream access:', error);
      throw error;
    }
  }

  /**
   * Create new live stream
   */
  async createStream(
    vendorId: string,
    streamData: {
      title: string;
      description?: string;
      category: string;
      tags?: string[];
      isPrivate?: boolean;
      scheduledStartTime?: string;
      estimatedDuration?: number;
    },
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // Generate unique channel name
      const channelName = `live_${vendorId}_${Date.now()}`;

      const streamRecord = {
        vendor_id: vendorId,
        title: streamData.title,
        description: streamData.description || '',
        category: streamData.category,
        tags: streamData.tags || [],
        is_private: streamData.isPrivate || false,
        channel_name: channelName,
        status: 'created',
        scheduled_start_time: streamData.scheduledStartTime,
        estimated_duration: streamData.estimatedDuration || 60,
        created_at: new Date().toISOString(),
      };

      const { data: stream, error } = await supabaseClient
        .from('live_streams')
        .insert(streamRecord)
        .select()
        .single();

      if (error) {
        console.error('Error creating stream:', error);
        throw new Error('Failed to create stream');
      }

      return stream;
    } catch (error) {
      console.error('Error creating stream:', error);
      throw error;
    }
  }

  /**
   * Start live stream
   */
  async startStream(
    streamId: string,
    vendorId: string,
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // Update stream status to active
      const { data: stream, error } = await supabaseClient
        .from('live_streams')
        .update({
          status: 'active',
          started_at: new Date().toISOString(),
        })
        .eq('id', streamId)
        .eq('vendor_id', vendorId)
        .select()
        .single();

      if (error || !stream) {
        throw new Error('Failed to start stream or unauthorized');
      }

      // Record analytics event
      await this.recordStreamEvent(streamId, 'stream_started', {
        vendorId,
        channelName: stream.channel_name,
      });

      return {
        success: true,
        stream,
        message: 'Stream started successfully',
      };
    } catch (error) {
      console.error('Error starting stream:', error);
      throw error;
    }
  }

  /**
   * End live stream
   */
  async endStream(
    streamId: string,
    vendorId: string,
    endData?: {
      reason?: string;
      summary?: string;
    },
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const endTime = new Date().toISOString();

      // Update stream status
      const { data: stream, error } = await supabaseClient
        .from('live_streams')
        .update({
          status: 'ended',
          ended_at: endTime,
          end_reason: endData?.reason || 'normal',
          summary: endData?.summary || '',
        })
        .eq('id', streamId)
        .eq('vendor_id', vendorId)
        .select()
        .single();

      if (error || !stream) {
        throw new Error('Failed to end stream or unauthorized');
      }

      // Calculate final stats
      const startTime = new Date(stream.started_at);
      const duration = Math.floor((new Date(endTime).getTime() - startTime.getTime()) / 1000);

      // Record analytics event
      await this.recordStreamEvent(streamId, 'stream_ended', {
        vendorId,
        duration,
        reason: endData?.reason || 'normal',
      });

      return {
        success: true,
        stream,
        duration,
        message: 'Stream ended successfully',
      };
    } catch (error) {
      console.error('Error ending stream:', error);
      throw error;
    }
  }

  /**
   * Get stream by ID
   */
  async getStreamById(streamId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data: stream, error } = await supabaseClient
        .from('live_streams')
        .select('*')
        .eq('id', streamId)
        .single();

      if (error) {
        throw new Error('Stream not found');
      }

      return stream;
    } catch (error) {
      console.error('Error fetching stream:', error);
      throw error;
    }
  }

  /**
   * Get user's active streams
   */
  async getUserActiveStreams(userId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data: streams, error } = await supabaseClient
        .from('live_streams')
        .select('*')
        .eq('vendor_id', userId)
        .in('status', ['created', 'active', 'paused'])
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error('Failed to fetch active streams');
      }

      return streams || [];
    } catch (error) {
      console.error('Error fetching active streams:', error);
      throw error;
    }
  }

  /**
   * Get stream statistics
   */
  async getStreamStats(streamId: string, userToken?: string) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      // Get stream info
      const { data: stream } = await supabaseClient
        .from('live_streams')
        .select('*')
        .eq('id', streamId)
        .single();

      if (!stream) {
        throw new Error('Stream not found');
      }

      // Get analytics data
      const [viewersData, salesData, giftsData] = await Promise.all([
        supabaseClient
          .from('stream_viewers')
          .select('*')
          .eq('stream_id', streamId),
        supabaseClient
          .from('live_stream_transactions')
          .select('*')
          .eq('stream_id', streamId),
        supabaseClient
          .from('live_stream_gifts')
          .select('*')
          .eq('stream_id', streamId),
      ]);

      const currentViewers = viewersData.data?.filter(v => v.left_at === null).length || 0;
      const totalViewers = viewersData.data?.length || 0;
      const totalSales = salesData.data?.reduce((sum, sale) => sum + (sale.total_amount || 0), 0) || 0;
      const totalGifts = giftsData.data?.reduce((sum, gift) => sum + (gift.total_amount || 0), 0) || 0;

      return {
        streamId,
        currentViewers,
        totalViewers,
        totalSales,
        totalGifts,
        totalRevenue: totalSales + totalGifts,
        status: stream.status,
        duration: stream.started_at ?
          Math.floor((new Date().getTime() - new Date(stream.started_at).getTime()) / 1000) : 0,
      };
    } catch (error) {
      console.error('Error fetching stream stats:', error);
      throw error;
    }
  }

  /**
   * Update stream quality settings
   */
  async updateStreamQuality(
    streamId: string,
    vendorId: string,
    qualitySettings: {
      resolution: string;
      frameRate: number;
      bitrate: number;
    },
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const { data: stream, error } = await supabaseClient
        .from('live_streams')
        .update({
          video_quality: qualitySettings,
          updated_at: new Date().toISOString(),
        })
        .eq('id', streamId)
        .eq('vendor_id', vendorId)
        .select()
        .single();

      if (error || !stream) {
        throw new Error('Failed to update stream quality or unauthorized');
      }

      return {
        success: true,
        message: 'Stream quality updated successfully',
        qualitySettings,
      };
    } catch (error) {
      console.error('Error updating stream quality:', error);
      throw error;
    }
  }

  /**
   * Toggle cloud recording
   */
  async toggleRecording(
    streamId: string,
    vendorId: string,
    recordingOptions: {
      action: 'start' | 'stop';
      format?: 'mp4' | 'hls';
      storageConfig?: any;
    },
    userToken?: string,
  ) {
    const supabaseClient = userToken
      ? createUserSupabaseClient(this.configService, userToken)
      : this.supabase;

    try {
      const recordingStatus = recordingOptions.action === 'start' ? 'recording' : 'stopped';

      const { data: stream, error } = await supabaseClient
        .from('live_streams')
        .update({
          recording_status: recordingStatus,
          recording_config: recordingOptions,
          updated_at: new Date().toISOString(),
        })
        .eq('id', streamId)
        .eq('vendor_id', vendorId)
        .select()
        .single();

      if (error || !stream) {
        throw new Error('Failed to toggle recording or unauthorized');
      }

      // Record analytics event
      await this.recordStreamEvent(streamId, `recording_${recordingOptions.action}`, {
        vendorId,
        format: recordingOptions.format,
      });

      return {
        success: true,
        message: `Recording ${recordingOptions.action}ed successfully`,
        recordingStatus,
      };
    } catch (error) {
      console.error('Error toggling recording:', error);
      throw error;
    }
  }

  /**
   * Get streaming configuration
   */
  async getStreamingConfig(userId: string) {
    try {
      const appId = this.configService.get<string>('AGORA_APP_ID') ||
                   process.env.AGORA_APP_ID;

      return {
        agoraAppId: appId,
        maxStreamDuration: 7200, // 2 hours
        supportedFormats: ['mp4', 'hls'],
        qualityPresets: [
          { name: 'Low', resolution: '480x360', bitrate: 400, frameRate: 15 },
          { name: 'Medium', resolution: '640x480', bitrate: 800, frameRate: 24 },
          { name: 'High', resolution: '1280x720', bitrate: 1500, frameRate: 30 },
        ],
        features: {
          recording: true,
          beautyFilter: false,
          virtualBackground: false,
          noiseReduction: true,
        },
      };
    } catch (error) {
      console.error('Error getting streaming config:', error);
      throw error;
    }
  }

  /**
   * Validate streaming environment
   */
  async validateEnvironment(
    userId: string,
    environmentData: {
      platform: string;
      deviceType: string;
      appVersion: string;
      networkQuality?: number;
      hasCamera?: boolean;
      hasMicrophone?: boolean;
    },
    userToken?: string,
  ) {
    try {
      const validation = {
        isSupported: true,
        capabilities: {
          videoStreaming: environmentData.hasCamera !== false,
          audioStreaming: environmentData.hasMicrophone !== false,
          cloudRecording: true,
          beautyFilter: false,
        },
        requirements: {
          minAppVersion: '1.0.0',
          requiredPermissions: ['camera', 'microphone'],
          networkQuality: 3, // Minimum quality on scale 1-6
        },
        recommendations: [] as string[],
        warnings: [] as string[],
      };

      // Check network quality
      if (environmentData.networkQuality && environmentData.networkQuality < 3) {
        validation.warnings.push('Poor network quality may affect streaming performance');
      }

      // Check device capabilities
      if (!environmentData.hasCamera) {
        validation.warnings.push('Camera access is required for video streaming');
        validation.capabilities.videoStreaming = false;
      }

      if (!environmentData.hasMicrophone) {
        validation.warnings.push('Microphone access is required for audio streaming');
        validation.capabilities.audioStreaming = false;
      }

      // Platform-specific recommendations
      if (environmentData.platform === 'web') {
        validation.recommendations.push('For best performance, use the mobile app');
      }

      if (environmentData.deviceType === 'simulator') {
        validation.warnings.push('Real device recommended for optimal streaming experience');
      }

      return validation;
    } catch (error) {
      console.error('Error validating environment:', error);
      throw error;
    }
  }

  /**
   * Record streaming analytics event
   */
  private async recordStreamEvent(
    streamId: string,
    eventType: string,
    metadata: any,
  ) {
    try {
      await this.supabase
        .from('stream_analytics_events')
        .insert({
          stream_id: streamId,
          event_type: eventType,
          metadata,
          created_at: new Date().toISOString(),
        });
    } catch (error) {
      // Don't throw error for analytics, just log it
      console.error('Error recording stream event:', error);
    }
  }
}