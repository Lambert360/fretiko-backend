import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import {
  AIResearchRequestDto,
  CreateActivityPlanDto,
} from './dto/chat.dto';

@Injectable()
export class AIAssistantService {
  private supabase;
  private readonly logger = new Logger(AIAssistantService.name);

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async generateAIResponse(userId: string, conversationId: string, userMessage: string, userToken?: string): Promise<string> {
    this.logger.log(`Generating AI response for user: ${userId} in conversation: ${conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get or create AI session
      const { data: session } = await this.getOrCreateAISession(userId, conversationId, 'chat', userToken);

      // Get conversation context (recent messages)
      const { data: recentMessages } = await client
        .from('chat_messages')
        .select('content, sender_id, message_type, created_at')
        .eq('conversation_id', conversationId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(10);

      // Build context for AI
      const context = this.buildConversationContext(recentMessages || [], userId);

      // Generate AI response based on message content and context
      const aiResponse = await this.generateContextualResponse(userMessage, context, session.context);

      // Update session context
      await this.updateAISessionContext(session.id, userMessage, aiResponse, userToken);

      this.logger.log(`AI response generated successfully for conversation: ${conversationId}`);
      return aiResponse;
    } catch (error) {
      this.logger.error('Error generating AI response:', error);
      return this.getFallbackResponse();
    }
  }

  async handleResearchRequest(userId: string, researchRequestDto: AIResearchRequestDto, userToken?: string): Promise<any> {
    this.logger.log(`Processing research request for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get or create AI session
      const { data: session } = await this.getOrCreateAISession(
        userId, 
        researchRequestDto.conversationId || '', 
        'research', 
        userToken
      );

      // Create research request record
      const { data: researchRequest, error } = await client
        .from('ai_research_requests')
        .insert({
          session_id: session.id,
          user_id: userId,
          query: researchRequestDto.query,
          research_type: researchRequestDto.researchType || 'general',
          status: 'processing',
        })
        .select('id')
        .single();

      if (error) {
        throw new Error(`Failed to create research request: ${error.message}`);
      }

      // Process research request (mock implementation)
      const researchResults = await this.processResearchQuery(
        researchRequestDto.query, 
        researchRequestDto.researchType
      );

      // Update research request with results
      await client
        .from('ai_research_requests')
        .update({
          status: 'completed',
          results: researchResults.results,
          sources: researchResults.sources,
          completed_at: new Date().toISOString(),
        })
        .eq('id', researchRequest.id);

      // Generate response message
      const responseMessage = this.formatResearchResponse(researchRequestDto.query, researchResults);

      this.logger.log(`Research request processed successfully: ${researchRequest.id}`);
      return {
        researchId: researchRequest.id,
        response: responseMessage,
        results: researchResults.results,
        sources: researchResults.sources,
      };
    } catch (error) {
      this.logger.error('Error processing research request:', error);
      return {
        response: "I'm having trouble researching that topic right now. Let me try to help you in another way!",
        results: {},
        sources: [],
      };
    }
  }

  async createActivityPlan(userId: string, activityPlanDto: CreateActivityPlanDto, userToken?: string): Promise<any> {
    this.logger.log(`Creating activity plan for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get or create AI session
      const { data: session } = await this.getOrCreateAISession(
        userId, 
        activityPlanDto.conversationId, 
        'planning', 
        userToken
      );

      // Generate AI suggestions for the activity
      const suggestions = await this.generateActivitySuggestions(activityPlanDto);

      // Create activity planning session
      const { data: planningSession, error } = await client
        .from('activity_planning_sessions')
        .insert({
          ai_session_id: session.id,
          user_id: userId,
          activity_type: activityPlanDto.activityType,
          title: activityPlanDto.title,
          description: activityPlanDto.description,
          planned_date: activityPlanDto.plannedDate,
          location: activityPlanDto.location,
          participants: JSON.stringify(activityPlanDto.participantIds || []),
          budget: activityPlanDto.budget,
          status: 'planning',
          suggestions: suggestions,
          metadata: activityPlanDto.metadata || {},
        })
        .select('id')
        .single();

      if (error) {
        throw new Error(`Failed to create activity plan: ${error.message}`);
      }

      // Generate response message
      const responseMessage = this.formatActivityPlanResponse(activityPlanDto, suggestions);

      this.logger.log(`Activity plan created successfully: ${planningSession.id}`);
      return {
        planningId: planningSession.id,
        response: responseMessage,
        suggestions,
        status: 'planning',
      };
    } catch (error) {
      this.logger.error('Error creating activity plan:', error);
      return {
        response: "I'd love to help you plan that activity! Let me gather some suggestions for you.",
        suggestions: {},
        status: 'planning',
      };
    }
  }

  async getAISessionHistory(userId: string, conversationId: string, userToken?: string): Promise<any[]> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: sessions, error } = await client
        .from('ai_assistant_sessions')
        .select(`
          id,
          session_type,
          context,
          created_at,
          updated_at,
          ai_research_requests (
            id,
            query,
            research_type,
            status,
            results,
            created_at,
            completed_at
          ),
          activity_planning_sessions (
            id,
            activity_type,
            title,
            description,
            planned_date,
            location,
            status,
            suggestions,
            created_at
          )
        `)
        .eq('user_id', userId)
        .eq('conversation_id', conversationId)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Failed to fetch AI session history: ${error.message}`);
      }

      return sessions || [];
    } catch (error) {
      this.logger.error('Error fetching AI session history:', error);
      return [];
    }
  }

  // Private helper methods
  private async getOrCreateAISession(userId: string, conversationId: string, sessionType: string, userToken?: string): Promise<any> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    // Try to get existing active session
    const { data: existingSession } = await client
      .from('ai_assistant_sessions')
      .select('id, context')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .eq('session_type', sessionType)
      .eq('is_active', true)
      .single();

    if (existingSession) {
      return { data: existingSession };
    }

    // Create new session
    const { data: newSession, error } = await client
      .from('ai_assistant_sessions')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        session_type: sessionType,
        context: {
          createdAt: new Date().toISOString(),
          preferences: {},
          history: [],
        },
        is_active: true,
      })
      .select('id, context')
      .single();

    if (error) {
      throw new Error(`Failed to create AI session: ${error.message}`);
    }

    return { data: newSession };
  }

  private buildConversationContext(messages: any[], userId: string): string {
    return messages
      .reverse()
      .map(msg => {
        const isUser = msg.sender_id === userId;
        const prefix = isUser ? 'User' : 'Assistant';
        return `${prefix}: ${msg.content || '[Non-text message]'}`;
      })
      .join('\n');
  }

  private async generateContextualResponse(userMessage: string, context: string, sessionContext: any): Promise<string> {
    // In production, this would integrate with AI services like:
    // - OpenAI GPT-4
    // - Anthropic Claude
    // - Google Bard
    // - Custom trained models

    // Mock AI response generation based on message content
    const message = userMessage.toLowerCase();
    
    if (message.includes('product') || message.includes('buy') || message.includes('shop')) {
      return this.getShoppingResponse(userMessage);
    } else if (message.includes('delivery') || message.includes('order') || message.includes('track')) {
      return this.getDeliveryResponse(userMessage);
    } else if (message.includes('help') || message.includes('support')) {
      return this.getHelpResponse(userMessage);
    } else if (message.includes('recommend') || message.includes('suggest')) {
      return this.getRecommendationResponse(userMessage);
    } else {
      return this.getGeneralResponse(userMessage, context);
    }
  }

  private async processResearchQuery(query: string, researchType?: string): Promise<any> {
    // Mock research processing - in production, integrate with:
    // - Web scraping APIs
    // - Product databases
    // - Price comparison services
    // - Review aggregators

    const mockResults = {
      summary: `Research results for: ${query}`,
      findings: [
        `Top-rated options for ${query}`,
        `Price ranges from $10 to $500`,
        `Best deals available on weekends`,
        `Highly recommended by 95% of users`,
      ],
      recommendations: [
        `Consider checking local stores first`,
        `Compare prices across multiple vendors`,
        `Read user reviews before purchasing`,
      ],
    };

    const mockSources = [
      {
        title: `${query} - Best Options 2024`,
        url: `https://example.com/research/${encodeURIComponent(query)}`,
        credibility: 'high',
      },
      {
        title: `Price Comparison for ${query}`,
        url: `https://pricecompare.com/${encodeURIComponent(query)}`,
        credibility: 'medium',
      },
    ];

    return {
      results: mockResults,
      sources: mockSources,
    };
  }

  private async generateActivitySuggestions(activityPlan: CreateActivityPlanDto): Promise<any> {
    // Mock activity suggestions - in production, integrate with:
    // - Event APIs (Eventbrite, Facebook Events)
    // - Location services (Google Places, Foursquare)
    // - Weather APIs
    // - Calendar services

    const suggestions = {
      venues: [
        {
          name: `Perfect venue for ${activityPlan.activityType}`,
          location: activityPlan.location || 'Downtown',
          rating: 4.5,
          priceRange: '$$',
        },
      ],
      timeline: {
        preparation: '1 week before',
        duration: '2-3 hours',
        bestTime: 'Weekend afternoons',
      },
      budget: {
        estimated: activityPlan.budget || 100,
        breakdown: {
          venue: 60,
          food: 25,
          transportation: 15,
        },
      },
      tips: [
        `Book in advance for ${activityPlan.activityType}`,
        'Consider weather conditions',
        'Bring backup plans',
      ],
    };

    return suggestions;
  }

  private async updateAISessionContext(sessionId: string, userMessage: string, aiResponse: string, userToken?: string): Promise<void> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get current context
      const { data: session } = await client
        .from('ai_assistant_sessions')
        .select('context')
        .eq('id', sessionId)
        .single();

      if (!session) return;

      // Update context with new interaction
      const updatedContext = {
        ...session.context,
        history: [
          ...(session.context.history || []).slice(-10), // Keep last 10 interactions
          {
            userMessage,
            aiResponse,
            timestamp: new Date().toISOString(),
          },
        ],
        lastUpdated: new Date().toISOString(),
      };

      // Save updated context
      await client
        .from('ai_assistant_sessions')
        .update({
          context: updatedContext,
          updated_at: new Date().toISOString(),
        })
        .eq('id', sessionId);
    } catch (error) {
      this.logger.error('Error updating AI session context:', error);
    }
  }

  // Response generators
  private getShoppingResponse(message: string): string {
    const responses = [
      "I'd love to help you find the perfect item! What specific features are you looking for?",
      "Great choice! Let me show you the best-rated options with competitive prices.",
      "I can help you compare prices and find deals from verified vendors on Fretiko!",
      "Based on your preferences, I have some amazing recommendations. Want to see the top picks?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  private getDeliveryResponse(message: string): string {
    const responses = [
      "Let me help you track your order! Can you provide your order number?",
      "I can connect you with the nearest delivery riders for fast service!",
      "Your delivery is on the way! I'll keep you updated on the status.",
      "For urgent deliveries, I recommend our express riders who are available 24/7.",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  private getHelpResponse(message: string): string {
    const responses = [
      "I'm here to help! What can I assist you with today?",
      "No problem! I can help you with shopping, deliveries, or finding services.",
      "Let me guide you through whatever you need - I'm Iko, your personal shopping assistant!",
      "I'd be happy to help! Whether it's finding products, comparing prices, or connecting with services.",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  private getRecommendationResponse(message: string): string {
    const responses = [
      "Based on trending items and user reviews, I have some fantastic suggestions for you!",
      "I'd love to recommend some options! What's your budget and preferred style?",
      "Here are my top picks based on quality, price, and customer satisfaction!",
      "Let me curate some personalized recommendations just for you!",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  private getGeneralResponse(message: string, context: string): string {
    const responses = [
      "That's interesting! Tell me more about what you're looking for.",
      "I understand! How can I help you with that?",
      "Great question! Let me provide you with some helpful information.",
      "I'm here to make your experience amazing! What would you like to explore?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  private getFallbackResponse(): string {
    return "I'm having a little trouble processing that right now, but I'm here to help! Could you try rephrasing your question?";
  }

  private formatResearchResponse(query: string, results: any): string {
    return `🔍 **Research Results for "${query}"**\n\n${results.results.summary}\n\n**Key Findings:**\n${results.results.findings.map((f: string) => `• ${f}`).join('\n')}\n\n**My Recommendations:**\n${results.results.recommendations.map((r: string) => `• ${r}`).join('\n')}\n\nWould you like me to research anything else?`;
  }

  private formatActivityPlanResponse(plan: CreateActivityPlanDto, suggestions: any): string {
    return `📅 **Activity Plan: ${plan.title}**\n\n**Type:** ${plan.activityType}\n**Date:** ${plan.plannedDate || 'To be determined'}\n**Location:** ${plan.location || 'To be determined'}\n\n**My Suggestions:**\n• **Venue:** ${suggestions.venues[0]?.name}\n• **Duration:** ${suggestions.timeline.duration}\n• **Best Time:** ${suggestions.timeline.bestTime}\n• **Estimated Budget:** $${suggestions.budget.estimated}\n\n**Pro Tips:**\n${suggestions.tips.map((tip: string) => `• ${tip}`).join('\n')}\n\nWould you like me to help you plan any other details?`;
  }
}