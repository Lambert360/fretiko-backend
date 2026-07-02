import { Injectable } from '@nestjs/common';
import { IkoService } from '../../iko/iko.service';

export interface AiContext {
  userId: string;
  username: string;
  location: any;
  preferences: {
    budgetRanges: Record<string, number>;
    favoriteCategories: string[];
    locationPreference: string;
    communicationStyle: string;
  };
  recentSearches: string[];
  learnedPatterns: Record<string, any>;
  conversationCount: number;
  isFirstInteraction: boolean;
}

@Injectable()
export class ContextBuilderService {
  constructor(private ikoService: IkoService) {}

  async build(userId: string, userToken?: string): Promise<AiContext> {
    const [profile, preferences, context] = await Promise.all([
      this.ikoService.getIkoUserProfile(userId, userToken),
      this.ikoService.getIkoPreferences(userId, userToken),
      this.ikoService.getIkoContext(userId, userToken),
    ]);

    return {
      userId,
      username: profile.username || 'there',
      location: profile.location || null,
      preferences: {
        budgetRanges: preferences.budget_ranges || {},
        favoriteCategories: preferences.favorite_categories || [],
        locationPreference: preferences.location_preferences || 'nearby',
        communicationStyle: preferences.communication_style || 'friendly',
      },
      recentSearches: this.getRecentSearches(context),
      learnedPatterns: context.learned_patterns || {},
      conversationCount: context.conversation_count || 0,
      isFirstInteraction: context.first_interaction !== false,
    };
  }

  private getRecentSearches(context: any): string[] {
    const searches = context?.learned_patterns?.searches || [];
    return searches
      .slice(-5)
      .map((s: any) => s.query)
      .filter((q: string) => q)
      .reverse();
  }

  /**
   * Build a concise system prompt for the LLM based on user context.
   */
  buildSystemPrompt(context: AiContext): string {
    const lines = [
      `You are Iko, Fretiko's AI shopping assistant. You help users find products, vendors, and deals on the Fretiko marketplace.`,
      `You are speaking with ${context.username}.`,
      `Tone: ${context.preferences.communicationStyle}.`,
    ];

    if (context.location?.address) {
      lines.push(`User location: ${context.location.address}.`);
    }

    if (context.preferences.favoriteCategories.length > 0) {
      lines.push(`User's favorite categories: ${context.preferences.favoriteCategories.join(', ')}.`);
    }

    if (Object.keys(context.preferences.budgetRanges).length > 0) {
      const budgets = Object.entries(context.preferences.budgetRanges)
        .map(([cat, amount]) => `${cat}: ₦${amount}`)
        .join(', ');
      lines.push(`Known budget ranges: ${budgets}.`);
    }

    if (context.recentSearches.length > 0) {
      lines.push(`Recent searches: ${context.recentSearches.join(', ')}.`);
    }

    lines.push(`Current date: ${new Date().toISOString().split('T')[0]}.`);
    lines.push(`You must only use information provided by the backend tools. Never invent products, prices, or vendors.`);
    lines.push(`Keep responses helpful and concise. When showing results, explain why each is relevant in 1-2 sentences.`);
    lines.push(`Currency: Nigerian Naira (₦).`);

    return lines.join('\n');
  }
}
