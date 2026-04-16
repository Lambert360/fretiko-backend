import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import {
  IkoPreferences,
  IkoContext,
  UpdateIkoPreferencesDto,
  UpdateIkoContextDto,
  IkoUserProfileDto,
} from './dto/iko.dto';

@Injectable()
export class IkoService {
  private supabase;
  private readonly logger = new Logger(IkoService.name);

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Get user's Iko preferences
   */
  async getIkoPreferences(userId: string, userToken?: string): Promise<IkoPreferences> {
    this.logger.log(`Getting Iko preferences for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data, error } = await client
        .from('user_profiles')
        .select('iko_preferences')
        .eq('id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          throw new NotFoundException('User profile not found');
        }
        throw new Error(`Database error: ${error.message}`);
      }

      return data.iko_preferences || this.getDefaultPreferences();
    } catch (error) {
      this.logger.error('Error fetching Iko preferences:', error);
      throw error;
    }
  }

  /**
   * Update user's Iko preferences
   */
  async updateIkoPreferences(
    userId: string,
    updateDto: UpdateIkoPreferencesDto,
    userToken?: string
  ): Promise<IkoPreferences> {
    this.logger.log(`Updating Iko preferences for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get current preferences first
      const currentPreferences = await this.getIkoPreferences(userId, userToken);

      // Merge with new preferences
      const updatedPreferences = this.mergePreferences(currentPreferences, updateDto);

      const { data, error } = await client
        .from('user_profiles')
        .update({
          iko_preferences: updatedPreferences,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId)
        .select('iko_preferences')
        .single();

      if (error) {
        throw new Error(`Database error: ${error.message}`);
      }

      this.logger.log(`Successfully updated Iko preferences for user: ${userId}`);
      return data.iko_preferences;
    } catch (error) {
      this.logger.error('Error updating Iko preferences:', error);
      throw error;
    }
  }

  /**
   * Get user's Iko context
   */
  async getIkoContext(userId: string, userToken?: string): Promise<IkoContext> {
    this.logger.log(`Getting Iko context for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data, error } = await client
        .from('user_profiles')
        .select('iko_context')
        .eq('id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          throw new NotFoundException('User profile not found');
        }
        throw new Error(`Database error: ${error.message}`);
      }

      return data.iko_context || this.getDefaultContext();
    } catch (error) {
      this.logger.error('Error fetching Iko context:', error);
      throw error;
    }
  }

  /**
   * Update user's Iko context
   */
  async updateIkoContext(
    userId: string,
    updateDto: UpdateIkoContextDto,
    userToken?: string
  ): Promise<IkoContext> {
    this.logger.log(`Updating Iko context for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get current context first
      const currentContext = await this.getIkoContext(userId, userToken);

      // Merge with new context
      const updatedContext = this.mergeContext(currentContext, updateDto);

      const { data, error } = await client
        .from('user_profiles')
        .update({
          iko_context: updatedContext,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId)
        .select('iko_context')
        .single();

      if (error) {
        throw new Error(`Database error: ${error.message}`);
      }

      this.logger.log(`Successfully updated Iko context for user: ${userId}`);
      return data.iko_context;
    } catch (error) {
      this.logger.error('Error updating Iko context:', error);
      throw error;
    }
  }

  /**
   * Get complete Iko profile (preferences + context + user info)
   */
  async getIkoUserProfile(userId: string, userToken?: string): Promise<IkoUserProfileDto> {
    this.logger.log(`Getting complete Iko profile for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data, error } = await client
        .from('user_profiles')
        .select('id, username, iko_preferences, iko_context, location, created_at')
        .eq('id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          throw new NotFoundException('User profile not found');
        }
        throw new Error(`Database error: ${error.message}`);
      }

      return {
        userId: data.id,
        username: data.username,
        location: data.location,
        memberSince: data.created_at,
        preferences: data.iko_preferences || this.getDefaultPreferences(),
        context: data.iko_context || this.getDefaultContext(),
      };
    } catch (error) {
      this.logger.error('Error fetching Iko user profile:', error);
      throw error;
    }
  }

  /**
   * Record conversation interaction
   */
  async recordConversation(
    userId: string,
    interactionType: 'text' | 'voice' | 'call',
    summary?: string,
    userToken?: string
  ): Promise<void> {
    this.logger.log(`Recording conversation for user: ${userId}, type: ${interactionType}`);

    try {
      const currentContext = await this.getIkoContext(userId, userToken);

      const updatedContext = {
        ...currentContext,
        last_conversation: new Date().toISOString(),
        conversation_count: (currentContext.conversation_count || 0) + 1,
        last_interaction_type: interactionType,
        last_interaction_summary: summary,
      };

      await this.updateIkoContext(userId, updatedContext, userToken);
    } catch (error) {
      this.logger.error('Error recording conversation:', error);
      // Don't throw error as this is a tracking function
    }
  }

  /**
   * Add ongoing plan
   */
  async addOngoingPlan(
    userId: string,
    plan: {
      id: string;
      type: string;
      title: string;
      description?: string;
      scheduledFor?: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    },
    userToken?: string
  ): Promise<void> {
    this.logger.log(`Adding ongoing plan for user: ${userId}`);

    try {
      const currentContext = await this.getIkoContext(userId, userToken);
      const ongoingPlans = currentContext.ongoing_plans || [];

      // Add new plan
      ongoingPlans.push({
        ...plan,
        createdAt: new Date().toISOString(),
      });

      await this.updateIkoContext(userId, { ongoing_plans: ongoingPlans }, userToken);
    } catch (error) {
      this.logger.error('Error adding ongoing plan:', error);
      throw error;
    }
  }

  /**
   * Update ongoing plan status
   */
  async updateOngoingPlan(
    userId: string,
    planId: string,
    updates: { status?: string; notes?: string },
    userToken?: string
  ): Promise<void> {
    this.logger.log(`Updating ongoing plan ${planId} for user: ${userId}`);

    try {
      const currentContext = await this.getIkoContext(userId, userToken);
      const ongoingPlans = currentContext.ongoing_plans || [];

      // Find and update the plan
      const planIndex = ongoingPlans.findIndex(plan => plan.id === planId);
      if (planIndex !== -1) {
        ongoingPlans[planIndex] = {
          ...ongoingPlans[planIndex],
          ...updates,
          updatedAt: new Date().toISOString(),
        } as IkoContext['ongoing_plans'][0];

        await this.updateIkoContext(userId, { ongoing_plans: ongoingPlans }, userToken);
      }
    } catch (error) {
      this.logger.error('Error updating ongoing plan:', error);
      throw error;
    }
  }

  // Private helper methods
  private getDefaultPreferences(): IkoPreferences {
    return {
      budget_ranges: {},
      favorite_categories: [],
      preferred_times: {},
      communication_style: 'friendly',
      location_preferences: 'nearby',
      notification_preferences: {
        proactive_suggestions: false,
        price_alerts: false,
        plan_reminders: false,
      },
    };
  }

  private getDefaultContext(): IkoContext {
    return {
      first_interaction: true,
      last_conversation: null,
      ongoing_plans: [],
      learned_patterns: {},
      conversation_count: 0,
      preferences_learned: false,
    };
  }

  private mergePreferences(current: IkoPreferences, updates: UpdateIkoPreferencesDto): IkoPreferences {
    return {
      ...current,
      ...updates,
      budget_ranges: { ...current.budget_ranges, ...updates.budget_ranges },
      notification_preferences: {
        ...current.notification_preferences,
        ...updates.notification_preferences
      },
    };
  }

  private mergeContext(current: IkoContext, updates: UpdateIkoContextDto): IkoContext {
    return {
      ...current,
      ...updates,
      learned_patterns: { ...current.learned_patterns, ...updates.learned_patterns },
    };
  }
}