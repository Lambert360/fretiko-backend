import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Delete, 
  Body, 
  Param, 
  Query, 
  Headers,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  BadRequestException,
  Logger 
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ChatService } from './chat.service';
import { FileUploadService } from './file-upload.service';
import { CallsService } from './calls.service';
import { AIAssistantService } from './ai-assistant.service';
import { InvoiceService } from './invoice.service';
import {
  CreateConversationDto,
  SendMessageDto,
  UpdateMessageStatusDto,
  GetConversationsDto,
  GetMessagesDto,
  StartCallDto,
  UpdateCallDto,
  JoinCallDto,
  AIResearchRequestDto,
  CreateActivityPlanDto,
  MessageType,
} from './dto/chat.dto';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
} from './dto/invoice.dto';

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly fileUploadService: FileUploadService,
    private readonly callsService: CallsService,
    private readonly aiAssistantService: AIAssistantService,
    private readonly invoiceService: InvoiceService,
  ) {}

  // Helper method to extract user ID from token
  private getUserIdFromToken(authHeader: string): string {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new BadRequestException('Authorization token required');
    }

    const token = authHeader.split(' ')[1];

    try {
      // Decode JWT token to extract user ID
      // Since we're using Supabase, we can decode the JWT payload
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());

      // Supabase JWT contains user ID in 'sub' field
      const userId = payload.sub;

      if (!userId) {
        throw new BadRequestException('Invalid token: user ID not found');
      }

      return userId;
    } catch (error) {
      this.logger.error('Error decoding JWT token:', error);
      throw new BadRequestException('Invalid token format');
    }
  }

  // =============================================================================
  // CONVERSATION ENDPOINTS
  // =============================================================================

  @Get('conversations')
  async getConversations(
    @Query() query: GetConversationsDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/conversations - Query: ${JSON.stringify(query)}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const conversations = await this.chatService.getConversations(userId, query, token);
      
      this.logger.log(`Found ${conversations.length} conversations for user: ${userId}`);
      return {
        success: true,
        data: conversations,
        pagination: {
          page: query.page || 1,
          limit: query.limit || 20,
          total: conversations.length,
        },
      };
    } catch (error) {
      this.logger.error('Error fetching conversations:', error);
      throw error;
    }
  }

  @Post('conversations')
  async createConversation(
    @Body() createConversationDto: CreateConversationDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/conversations - Data: ${JSON.stringify(createConversationDto)}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const conversation = await this.chatService.createConversation(userId, createConversationDto, token);

      this.logger.log(`Conversation created successfully: ${conversation.id}`);
      return {
        success: true,
        data: conversation,
        message: 'Conversation created successfully',
      };
    } catch (error) {
      this.logger.error('Error creating conversation:', error);
      throw error;
    }
  }

  @Post('conversations/find-or-create')
  async findOrCreateConversation(
    @Body() body: { participantIds: string[]; chatType: string },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/conversations/find-or-create - Data: ${JSON.stringify(body)}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const conversation = await this.chatService.findOrCreateConversation(
        userId,
        body.participantIds,
        body.chatType,
        token
      );

      this.logger.log(`Conversation found/created successfully: ${conversation.id}`);
      return {
        success: true,
        data: conversation,
        message: 'Conversation found or created successfully',
      };
    } catch (error) {
      this.logger.error('Error finding/creating conversation:', error);
      throw error;
    }
  }

  // =============================================================================
  // MESSAGE ENDPOINTS
  // =============================================================================

  @Get('conversations/:conversationId/messages')
  async getMessages(
    @Param('conversationId') conversationId: string,
    @Query() query: Omit<GetMessagesDto, 'conversationId'>,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/conversations/${conversationId}/messages - Query: ${JSON.stringify(query)}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    const fullQuery: GetMessagesDto = { ...query, conversationId };
    
    try {
      const messages = await this.chatService.getMessages(userId, fullQuery, token);
      
      this.logger.log(`Found ${messages.length} messages for conversation: ${conversationId}`);
      return {
        success: true,
        data: messages,
        pagination: {
          page: query.page || 1,
          limit: query.limit || 50,
          total: messages.length,
        },
      };
    } catch (error) {
      this.logger.error('Error fetching messages:', error);
      throw error;
    }
  }

  @Post('messages')
  async sendMessage(
    @Body() sendMessageDto: SendMessageDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/messages - Data: ${JSON.stringify(sendMessageDto)}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const message = await this.chatService.sendMessage(userId, sendMessageDto, token);

      this.logger.log(`Message sent successfully: ${message.id}`);
      return {
        success: true,
        data: message,
        message: 'Message sent successfully',
      };
    } catch (error) {
      this.logger.error('Error sending message:', error);
      throw error;
    }
  }

  @Post('messages/ai')
  async sendAIMessage(
    @Body() body: { conversationId: string; content: string; isAIResponse?: boolean },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/messages/ai - Data: ${JSON.stringify(body)}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      // Always use the authenticated user for RLS compliance, but specify actual sender in message
      const message = await this.chatService.sendMessage(userId, {
        conversationId: body.conversationId,
        messageType: MessageType.TEXT,
        content: body.content,
        // Store actual sender info for AI messages
        actualSenderId: body.isAIResponse ? '00000000-0000-4000-8000-000000000001' : userId,
        isAIResponse: body.isAIResponse,
      }, token);

      this.logger.log(`AI message sent successfully: ${message.id}`);
      return {
        success: true,
        data: message,
        message: 'AI message sent successfully',
      };
    } catch (error) {
      this.logger.error('Error sending AI message:', error);
      throw error;
    }
  }

  @Put('messages/:messageId/status')
  async updateMessageStatus(
    @Param('messageId') messageId: string,
    @Body() updateStatusDto: Omit<UpdateMessageStatusDto, 'messageId'>,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/messages/${messageId}/status - Status: ${updateStatusDto.status}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    const fullUpdateDto: UpdateMessageStatusDto = { ...updateStatusDto, messageId };

    try {
      await this.chatService.updateMessageStatus(userId, fullUpdateDto, token);

      this.logger.log(`Message status updated successfully: ${messageId}`);
      return {
        success: true,
        message: 'Message status updated successfully',
      };
    } catch (error) {
      this.logger.error('Error updating message status:', error);
      throw error;
    }
  }

  @Put('messages/:messageId')
  async updateMessage(
    @Param('messageId') messageId: string,
    @Body() updateData: { content?: string; mediaUrl?: string; fileData?: any },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/messages/${messageId} - Updating message content/media`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const updatedMessage = await this.chatService.updateMessage(userId, messageId, updateData, token);

      this.logger.log(`Message updated successfully: ${messageId}`);
      return {
        success: true,
        data: updatedMessage,
        message: 'Message updated successfully',
      };
    } catch (error) {
      this.logger.error('Error updating message:', error);
      throw error;
    }
  }

  // =============================================================================
  // EMOJI REACTION ENDPOINTS
  // =============================================================================

  @Post('messages/:messageId/reactions')
  async addReaction(
    @Param('messageId') messageId: string,
    @Body() body: { emoji: string },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/messages/${messageId}/reactions - Emoji: ${body.emoji}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const result = await this.chatService.toggleReaction(userId, messageId, body.emoji, token);

      this.logger.log(`Reaction toggled successfully for message: ${messageId}`);
      return {
        success: true,
        data: result,
        message: 'Reaction toggled successfully',
      };
    } catch (error) {
      this.logger.error('Error toggling reaction:', error);
      throw error;
    }
  }

  @Get('messages/:messageId/reactions')
  async getReactions(
    @Param('messageId') messageId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/messages/${messageId}/reactions`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const reactions = await this.chatService.getReactions(messageId, token);

      return {
        success: true,
        data: reactions,
      };
    } catch (error) {
      this.logger.error('Error fetching reactions:', error);
      throw error;
    }
  }

  // =============================================================================
  // FILE UPLOAD ENDPOINTS
  // =============================================================================

  @Post('messages/:messageId/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @Param('messageId') messageId: string,
    @UploadedFile() file: Express.Multer.File,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/messages/${messageId}/upload - File: ${file?.originalname}`);
    
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const result = await this.fileUploadService.uploadFile(userId, file, messageId, token);
      
      this.logger.log(`File uploaded successfully: ${result.publicUrl}`);
      return {
        success: true,
        data: {
          url: result.publicUrl,
          fileData: result.fileData,
        },
        message: 'File uploaded successfully',
      };
    } catch (error) {
      this.logger.error('Error uploading file:', error);
      throw error;
    }
  }

  @Post('messages/:messageId/upload-multiple')
  @UseInterceptors(FilesInterceptor('files', 10)) // Max 10 files
  async uploadMultipleFiles(
    @Param('messageId') messageId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/messages/${messageId}/upload-multiple - Files: ${files?.length}`);
    
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const result = await this.fileUploadService.uploadMultipleFiles(userId, files, messageId, token);
      
      this.logger.log(`${files.length} files uploaded successfully`);
      return {
        success: true,
        data: {
          urls: result.publicUrls,
          filesData: result.filesData,
        },
        message: `${files.length} files uploaded successfully`,
      };
    } catch (error) {
      this.logger.error('Error uploading multiple files:', error);
      throw error;
    }
  }

  @Get('files/:fileId/download')
  async downloadFile(
    @Param('fileId') fileId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/files/${fileId}/download`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const presignedUrl = await this.fileUploadService.generatePresignedUrl(userId, fileId, 3600, token);
      
      this.logger.log(`Presigned URL generated for file: ${fileId}`);
      return {
        success: true,
        data: {
          downloadUrl: presignedUrl,
          expiresIn: 3600,
        },
      };
    } catch (error) {
      this.logger.error('Error generating download URL:', error);
      throw error;
    }
  }

  @Delete('files/:fileId')
  async deleteFile(
    @Param('fileId') fileId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`DELETE /chat/files/${fileId}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      await this.fileUploadService.deleteFile(userId, fileId, token);
      
      this.logger.log(`File deleted successfully: ${fileId}`);
      return {
        success: true,
        message: 'File deleted successfully',
      };
    } catch (error) {
      this.logger.error('Error deleting file:', error);
      throw error;
    }
  }

  @Get('storage/stats')
  async getStorageStats(
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log('GET /chat/storage/stats');
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const stats = await this.fileUploadService.getStorageStats(userId, token);
      
      this.logger.log(`Storage stats retrieved for user: ${userId}`);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error('Error fetching storage stats:', error);
      throw error;
    }
  }

  // =============================================================================
  // CALL ENDPOINTS
  // =============================================================================

  @Post('calls')
  async startCall(
    @Body() startCallDto: StartCallDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/calls - Data: ${JSON.stringify(startCallDto)}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const callSession = await this.callsService.startCall(userId, startCallDto, token);
      
      this.logger.log(`Call started successfully: ${callSession.id}`);
      return {
        success: true,
        data: callSession,
        message: 'Call started successfully',
      };
    } catch (error) {
      this.logger.error('Error starting call:', error);
      throw error;
    }
  }

  @Post('calls/:callSessionId/join')
  async joinCall(
    @Param('callSessionId') callSessionId: string,
    @Body() joinCallDto: Omit<JoinCallDto, 'callSessionId'>,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/calls/${callSessionId}/join`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    const fullJoinDto: JoinCallDto = { ...joinCallDto, callSessionId };
    
    try {
      const callSession = await this.callsService.joinCall(userId, fullJoinDto, token);
      
      this.logger.log(`User joined call successfully: ${callSessionId}`);
      return {
        success: true,
        data: callSession,
        message: 'Joined call successfully',
      };
    } catch (error) {
      this.logger.error('Error joining call:', error);
      throw error;
    }
  }

  @Post('calls/:callSessionId/leave')
  async leaveCall(
    @Param('callSessionId') callSessionId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/calls/${callSessionId}/leave`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      await this.callsService.leaveCall(userId, callSessionId, token);
      
      this.logger.log(`User left call successfully: ${callSessionId}`);
      return {
        success: true,
        message: 'Left call successfully',
      };
    } catch (error) {
      this.logger.error('Error leaving call:', error);
      throw error;
    }
  }

  @Put('calls/:callSessionId/settings')
  async updateCallSettings(
    @Param('callSessionId') callSessionId: string,
    @Body() settings: { isMuted?: boolean; isVideoEnabled?: boolean },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/calls/${callSessionId}/settings - Settings: ${JSON.stringify(settings)}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      await this.callsService.updateCallSettings(userId, callSessionId, settings, token);
      
      this.logger.log(`Call settings updated successfully: ${callSessionId}`);
      return {
        success: true,
        message: 'Call settings updated successfully',
      };
    } catch (error) {
      this.logger.error('Error updating call settings:', error);
      throw error;
    }
  }

  @Get('calls/:callSessionId')
  async getCallSession(
    @Param('callSessionId') callSessionId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/calls/${callSessionId}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const callSession = await this.callsService.getCallSession(userId, callSessionId, token);
      
      this.logger.log(`Call session retrieved successfully: ${callSessionId}`);
      return {
        success: true,
        data: callSession,
      };
    } catch (error) {
      this.logger.error('Error fetching call session:', error);
      throw error;
    }
  }

  @Get('conversations/:conversationId/calls')
  async getConversationCalls(
    @Param('conversationId') conversationId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/conversations/${conversationId}/calls`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const calls = await this.callsService.getConversationCalls(userId, conversationId, token);
      
      this.logger.log(`Found ${calls.length} calls for conversation: ${conversationId}`);
      return {
        success: true,
        data: calls,
      };
    } catch (error) {
      this.logger.error('Error fetching conversation calls:', error);
      throw error;
    }
  }

  @Get('calls/stats')
  async getCallStats(
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log('GET /chat/calls/stats');
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const stats = await this.callsService.getCallStats(userId, token);
      
      this.logger.log(`Call stats retrieved for user: ${userId}`);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error('Error fetching call stats:', error);
      throw error;
    }
  }

  // =============================================================================
  // AI ASSISTANT ENDPOINTS
  // =============================================================================

  @Post('ai/research')
  async requestResearch(
    @Body() researchRequestDto: AIResearchRequestDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/ai/research - Query: ${researchRequestDto.query}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const result = await this.aiAssistantService.handleResearchRequest(userId, researchRequestDto, token);
      
      this.logger.log(`Research request processed successfully`);
      return {
        success: true,
        data: result,
        message: 'Research completed successfully',
      };
    } catch (error) {
      this.logger.error('Error processing research request:', error);
      throw error;
    }
  }

  @Post('ai/plan-activity')
  async planActivity(
    @Body() activityPlanDto: CreateActivityPlanDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/ai/plan-activity - Activity: ${activityPlanDto.title}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const result = await this.aiAssistantService.createActivityPlan(userId, activityPlanDto, token);
      
      this.logger.log(`Activity plan created successfully`);
      return {
        success: true,
        data: result,
        message: 'Activity plan created successfully',
      };
    } catch (error) {
      this.logger.error('Error creating activity plan:', error);
      throw error;
    }
  }

  @Get('ai/sessions/:conversationId')
  async getAISessionHistory(
    @Param('conversationId') conversationId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/ai/sessions/${conversationId}`);
    
    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];
    
    try {
      const sessions = await this.aiAssistantService.getAISessionHistory(userId, conversationId, token);
      
      this.logger.log(`Found ${sessions.length} AI sessions for conversation: ${conversationId}`);
      return {
        success: true,
        data: sessions,
      };
    } catch (error) {
      this.logger.error('Error fetching AI session history:', error);
      throw error;
    }
  }

  // =============================================================================
  // CONVERSATION MANAGEMENT ENDPOINTS
  // =============================================================================

  @Put('conversations/:conversationId/read')
  async markConversationAsRead(
    @Param('conversationId') conversationId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/conversations/${conversationId}/read`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      await this.chatService.markConversationAsRead(userId, conversationId, token);

      this.logger.log(`Conversation marked as read successfully: ${conversationId}`);
      return {
        success: true,
        message: 'Conversation marked as read',
      };
    } catch (error) {
      this.logger.error('Error marking conversation as read:', error);
      throw error;
    }
  }

  @Put('conversations/:conversationId/archive')
  async archiveConversation(
    @Param('conversationId') conversationId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/conversations/${conversationId}/archive`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      await this.chatService.archiveConversation(userId, conversationId, token);

      this.logger.log(`Conversation archived successfully: ${conversationId}`);
      return {
        success: true,
        message: 'Conversation archived',
      };
    } catch (error) {
      this.logger.error('Error archiving conversation:', error);
      throw error;
    }
  }

  @Put('conversations/:conversationId/unarchive')
  async unarchiveConversation(
    @Param('conversationId') conversationId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/conversations/${conversationId}/unarchive`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      await this.chatService.unarchiveConversation(userId, conversationId, token);

      this.logger.log(`Conversation unarchived successfully: ${conversationId}`);
      return {
        success: true,
        message: 'Conversation unarchived',
      };
    } catch (error) {
      this.logger.error('Error unarchiving conversation:', error);
      throw error;
    }
  }

  @Put('conversations/:conversationId/pin')
  async togglePinConversation(
    @Param('conversationId') conversationId: string,
    @Body() body: { isPinned: boolean },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/conversations/${conversationId}/pin - isPinned: ${body.isPinned}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      await this.chatService.togglePinConversation(userId, conversationId, body.isPinned, token);

      this.logger.log(`Conversation pin status updated successfully: ${conversationId}`);
      return {
        success: true,
        message: body.isPinned ? 'Conversation pinned' : 'Conversation unpinned',
      };
    } catch (error) {
      this.logger.error('Error updating pin status:', error);
      throw error;
    }
  }

  @Put('conversations/:conversationId/mute')
  async toggleMuteConversation(
    @Param('conversationId') conversationId: string,
    @Body() body: { isMuted: boolean },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/conversations/${conversationId}/mute - isMuted: ${body.isMuted}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      await this.chatService.toggleMuteConversation(userId, conversationId, body.isMuted, token);

      this.logger.log(`Conversation mute status updated successfully: ${conversationId}`);
      return {
        success: true,
        message: body.isMuted ? 'Conversation muted' : 'Conversation unmuted',
      };
    } catch (error) {
      this.logger.error('Error updating mute status:', error);
      throw error;
    }
  }

  // =============================================================================
  // TYPING INDICATOR ENDPOINTS
  // =============================================================================

  @Post('conversations/:conversationId/typing')
  async updateTypingStatus(
    @Param('conversationId') conversationId: string,
    @Body() body: { isTyping: boolean },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/conversations/${conversationId}/typing - isTyping: ${body.isTyping}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      await this.chatService.updateTypingStatus(userId, conversationId, body.isTyping, token);

      this.logger.log(`Typing status updated successfully for conversation: ${conversationId}`);
      return {
        success: true,
        message: 'Typing status updated',
      };
    } catch (error) {
      this.logger.error('Error updating typing status:', error);
      throw error;
    }
  }

  // =============================================================================
  // USER STATUS ENDPOINTS
  // =============================================================================

  @Get('users/:userId/status')
  async getUserStatus(
    @Param('userId') userId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/users/${userId}/status`);

    const requestingUserId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const status = await this.chatService.getUserStatus(requestingUserId, userId, token);

      this.logger.log(`User status retrieved successfully for: ${userId}`);
      return {
        success: true,
        data: status,
      };
    } catch (error) {
      this.logger.error('Error fetching user status:', error);
      throw error;
    }
  }

  @Put('users/status')
  async updateUserStatus(
    @Body() body: { isOnline: boolean },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/users/status - isOnline: ${body.isOnline}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      await this.chatService.updateUserOnlineStatus(userId, body.isOnline, token);

      this.logger.log(`User status updated successfully for: ${userId}`);
      return {
        success: true,
        message: 'Status updated successfully',
      };
    } catch (error) {
      this.logger.error('Error updating user status:', error);
      throw error;
    }
  }

  // =============================================================================
  // AI CONVERSATION METADATA ENDPOINTS
  // =============================================================================

  @Put('conversations/:conversationId/metadata')
  async updateConversationMetadata(
    @Param('conversationId') conversationId: string,
    @Body() body: { lastMessagePreview?: string },
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/conversations/${conversationId}/metadata`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      await this.chatService.updateConversationMetadata(userId, conversationId, body.lastMessagePreview, token);

      this.logger.log(`Conversation metadata updated successfully: ${conversationId}`);
      return {
        success: true,
        message: 'Conversation metadata updated',
      };
    } catch (error) {
      this.logger.error('Error updating conversation metadata:', error);
      throw error;
    }
  }

  // =============================================================================
  // INVOICE ENDPOINTS
  // =============================================================================

  @Post('invoices/upload-image')
  @UseInterceptors(FileInterceptor('image'))
  async uploadInvoiceItemImage(
    @UploadedFile() file: Express.Multer.File,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log('POST /chat/invoices/upload-image');

    const userId = this.getUserIdFromToken(authHeader);

    if (!file) {
      throw new BadRequestException('No image file provided');
    }

    try {
      const imageUrl = await this.invoiceService.uploadInvoiceItemImage(userId, file);

      return {
        success: true,
        data: { imageUrl },
        message: 'Image uploaded successfully',
      };
    } catch (error) {
      this.logger.error('Error uploading invoice item image:', error);
      throw error;
    }
  }

  @Post('invoices')
  async createInvoice(
    @Body() createInvoiceDto: CreateInvoiceDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`POST /chat/invoices - Conversation: ${createInvoiceDto.conversationId}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const invoice = await this.invoiceService.createInvoice(userId, createInvoiceDto, token);

      this.logger.log(`Invoice created successfully: ${invoice.invoiceNumber}`);
      return {
        success: true,
        data: invoice,
        message: 'Invoice created successfully',
      };
    } catch (error) {
      this.logger.error('Error creating invoice:', error);
      throw error;
    }
  }

  @Get('invoices/:invoiceId')
  async getInvoice(
    @Param('invoiceId') invoiceId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`GET /chat/invoices/${invoiceId}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const invoice = await this.invoiceService.getInvoiceById(userId, invoiceId, token);

      return {
        success: true,
        data: invoice,
      };
    } catch (error) {
      this.logger.error('Error fetching invoice:', error);
      throw error;
    }
  }

  @Put('invoices/:invoiceId')
  async updateInvoice(
    @Param('invoiceId') invoiceId: string,
    @Body() updateInvoiceDto: UpdateInvoiceDto,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`PUT /chat/invoices/${invoiceId}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const invoice = await this.invoiceService.updateInvoice(userId, invoiceId, updateInvoiceDto, token);

      this.logger.log(`Invoice updated successfully: ${invoiceId}`);
      return {
        success: true,
        data: invoice,
        message: 'Invoice updated successfully',
      };
    } catch (error) {
      this.logger.error('Error updating invoice:', error);
      throw error;
    }
  }

  @Delete('invoices/:invoiceId')
  async cancelInvoice(
    @Param('invoiceId') invoiceId: string,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log(`DELETE /chat/invoices/${invoiceId}`);

    const userId = this.getUserIdFromToken(authHeader);
    const token = authHeader.split(' ')[1];

    try {
      const result = await this.invoiceService.cancelInvoice(userId, invoiceId, token);

      this.logger.log(`Invoice cancelled successfully: ${invoiceId}`);
      return {
        success: true,
        message: 'Invoice cancelled successfully',
      };
    } catch (error) {
      this.logger.error('Error cancelling invoice:', error);
      throw error;
    }
  }

  // =============================================================================
  // HEALTH CHECK ENDPOINT
  // =============================================================================

  @Get('health')
  async healthCheck() {
    this.logger.log('GET /chat/health');

    return {
      success: true,
      service: 'Chat Service',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    };
  }
}