import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StreamingService } from './streaming.service';

interface GenerateTokenRequest {
  channelName: string;
  streamId: string;
  role: 'publisher' | 'subscriber';
  uid?: number;
  expireTime?: number;
}

interface CreateStreamRequest {
  title: string;
  description?: string;
  category: string;
  tags?: string[];
  isPrivate?: boolean;
  scheduledStartTime?: string;
  estimatedDuration?: number;
}

interface StreamTokenResponse {
  token: string;
  channelName: string;
  uid: number;
  appId: string;
  expiresAt: string;
  role: string;
}

@Controller('streaming')
@UseGuards(JwtAuthGuard)
export class StreamingController {
  constructor(private readonly streamingService: StreamingService) {}

  /**
   * POST /streaming/token
   * Generate Agora RTC token for video streaming
   */
  @Post('token')
  async generateToken(
    @Request() req,
    @Body() tokenRequest: GenerateTokenRequest,
  ): Promise<StreamTokenResponse> {
    try {
      // Validate the request
      if (!tokenRequest.channelName || !tokenRequest.streamId) {
        throw new HttpException(
          'Channel name and stream ID are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Verify user has permission to access this stream
      await this.streamingService.verifyStreamAccess(
        req.user.sub,
        tokenRequest.streamId,
        tokenRequest.role,
        req.supabaseToken,
      );

      // Generate token
      const tokenData = await this.streamingService.generateAgoraToken(
        tokenRequest.channelName,
        tokenRequest.uid,
        tokenRequest.role,
        tokenRequest.expireTime,
      );

      return {
        ...tokenData,
        role: tokenRequest.role,
      };
    } catch (error) {
      console.error('Error generating streaming token:', error);
      throw new HttpException(
        error.message || 'Failed to generate streaming token',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /streaming/refresh-token
   * Refresh an expired Agora RTC token
   */
  @Post('refresh-token')
  async refreshToken(
    @Request() req,
    @Body() refreshRequest: {
      channelName: string;
      streamId: string;
      currentToken: string;
      role: 'publisher' | 'subscriber';
    },
  ): Promise<StreamTokenResponse> {
    try {
      // Verify the current token and stream access
      await this.streamingService.verifyStreamAccess(
        req.user.sub,
        refreshRequest.streamId,
        refreshRequest.role,
        req.supabaseToken,
      );

      // Generate new token
      const tokenData = await this.streamingService.generateAgoraToken(
        refreshRequest.channelName,
        undefined, // Let service generate UID
        refreshRequest.role,
        3600, // 1 hour expiry
      );

      return {
        ...tokenData,
        role: refreshRequest.role,
      };
    } catch (error) {
      console.error('Error refreshing streaming token:', error);
      throw new HttpException(
        'Failed to refresh streaming token',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /streaming/create
   * Create a new live stream session
   */
  @Post('create')
  async createStream(
    @Request() req,
    @Body() createRequest: CreateStreamRequest,
  ) {
    try {
      const stream = await this.streamingService.createStream(
        req.user.sub,
        createRequest,
        req.supabaseToken,
      );

      // Generate initial tokens for the stream
      const publisherToken = await this.streamingService.generateAgoraToken(
        stream.channelName,
        undefined,
        'publisher',
        3600,
      );

      return {
        stream,
        publisherToken,
      };
    } catch (error) {
      console.error('Error creating stream:', error);
      throw new HttpException(
        'Failed to create stream',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /streaming/:streamId/start
   * Start a live stream
   */
  @Post(':streamId/start')
  async startStream(
    @Request() req,
    @Query('streamId') streamId: string,
  ) {
    try {
      const result = await this.streamingService.startStream(
        streamId,
        req.user.sub,
        req.supabaseToken,
      );

      return result;
    } catch (error) {
      console.error('Error starting stream:', error);
      throw new HttpException(
        'Failed to start stream',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /streaming/:streamId/end
   * End a live stream
   */
  @Post(':streamId/end')
  async endStream(
    @Request() req,
    @Query('streamId') streamId: string,
    @Body() endData?: {
      reason?: string;
      summary?: string;
    },
  ) {
    try {
      const result = await this.streamingService.endStream(
        streamId,
        req.user.sub,
        endData,
        req.supabaseToken,
      );

      return result;
    } catch (error) {
      console.error('Error ending stream:', error);
      throw new HttpException(
        'Failed to end stream',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /streaming/:streamId/viewer-token
   * Get viewer token for joining a stream
   */
  @Get(':streamId/viewer-token')
  async getViewerToken(
    @Request() req,
    @Query('streamId') streamId: string,
  ): Promise<StreamTokenResponse> {
    try {
      // Verify stream exists and is active
      const stream = await this.streamingService.getStreamById(
        streamId,
        req.supabaseToken,
      );

      if (!stream || stream.status !== 'active') {
        throw new HttpException(
          'Stream not found or not active',
          HttpStatus.NOT_FOUND,
        );
      }

      // Generate viewer token
      const tokenData = await this.streamingService.generateAgoraToken(
        stream.channel_name,
        undefined,
        'subscriber',
        3600,
      );

      return {
        ...tokenData,
        role: 'subscriber',
      };
    } catch (error) {
      console.error('Error generating viewer token:', error);
      throw new HttpException(
        'Failed to generate viewer token',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /streaming/active
   * Get user's active streams
   */
  @Get('active')
  async getActiveStreams(@Request() req) {
    try {
      const streams = await this.streamingService.getUserActiveStreams(
        req.user.sub,
        req.supabaseToken,
      );

      return streams;
    } catch (error) {
      console.error('Error fetching active streams:', error);
      throw new HttpException(
        'Failed to fetch active streams',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /streaming/:streamId/stats
   * Get real-time stream statistics
   */
  @Get(':streamId/stats')
  async getStreamStats(
    @Request() req,
    @Query('streamId') streamId: string,
  ) {
    try {
      const stats = await this.streamingService.getStreamStats(
        streamId,
        req.supabaseToken,
      );

      return stats;
    } catch (error) {
      console.error('Error fetching stream stats:', error);
      throw new HttpException(
        'Failed to fetch stream stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /streaming/:streamId/update-quality
   * Update stream quality settings
   */
  @Post(':streamId/update-quality')
  async updateStreamQuality(
    @Request() req,
    @Query('streamId') streamId: string,
    @Body() qualitySettings: {
      resolution: string;
      frameRate: number;
      bitrate: number;
    },
  ) {
    try {
      const result = await this.streamingService.updateStreamQuality(
        streamId,
        req.user.sub,
        qualitySettings,
        req.supabaseToken,
      );

      return result;
    } catch (error) {
      console.error('Error updating stream quality:', error);
      throw new HttpException(
        'Failed to update stream quality',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /streaming/:streamId/record
   * Start/stop cloud recording
   */
  @Post(':streamId/record')
  async toggleRecording(
    @Request() req,
    @Query('streamId') streamId: string,
    @Body() recordingOptions: {
      action: 'start' | 'stop';
      format?: 'mp4' | 'hls';
      storageConfig?: {
        vendor: string;
        region: string;
        bucket: string;
        accessKey: string;
        secretKey: string;
      };
    },
  ) {
    try {
      const result = await this.streamingService.toggleRecording(
        streamId,
        req.user.sub,
        recordingOptions,
        req.supabaseToken,
      );

      return result;
    } catch (error) {
      console.error('Error toggling recording:', error);
      throw new HttpException(
        'Failed to toggle recording',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /streaming/config
   * Get streaming configuration for client
   */
  @Get('config')
  async getStreamingConfig(@Request() req) {
    try {
      const config = await this.streamingService.getStreamingConfig(req.user.sub);

      return config;
    } catch (error) {
      console.error('Error fetching streaming config:', error);
      throw new HttpException(
        'Failed to fetch streaming config',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /streaming/validate-environment
   * Validate user's streaming environment and capabilities
   */
  @Post('validate-environment')
  async validateEnvironment(
    @Request() req,
    @Body() environmentData: {
      platform: string;
      deviceType: string;
      appVersion: string;
      networkQuality?: number;
      hasCamera?: boolean;
      hasMicrophone?: boolean;
    },
  ) {
    try {
      const validation = await this.streamingService.validateEnvironment(
        req.user.sub,
        environmentData,
        req.supabaseToken,
      );

      return validation;
    } catch (error) {
      console.error('Error validating environment:', error);
      throw new HttpException(
        'Failed to validate environment',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}