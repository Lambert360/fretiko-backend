import { Injectable, Logger } from '@nestjs/common';
import { IkoService } from '../../iko/iko.service';
import { ClassifiedIntent } from '../core/intent-classifier.service';
import { ToolExecutionResult } from '../dto/ai.dto';

@Injectable()
export class PreferenceLearnerService {
  private readonly logger = new Logger(PreferenceLearnerService.name);

  constructor(private ikoService: IkoService) {}

  async learn(userId: string, intent: ClassifiedIntent, toolResults: ToolExecutionResult[]): Promise<void> {
    try {
      const updates: Record<string, any> = {};
      const preferences: Record<string, any> = {};

      // Learn category preferences
      if (intent.entities?.category) {
        const current = await this.ikoService.getIkoPreferences(userId);
        const favoriteCategories = new Set(current.favorite_categories || []);
        favoriteCategories.add(intent.entities.category);
        preferences.favorite_categories = Array.from(favoriteCategories);
      }

      // Learn budget ranges
      if (intent.entities?.budget && intent.entities?.category) {
        const current = await this.ikoService.getIkoPreferences(userId);
        const existingBudget = current.budget_ranges?.[intent.entities.category] || 0;
        const newBudget = Math.max(existingBudget, intent.entities.budget);
        preferences.budget_ranges = {
          ...current.budget_ranges,
          [intent.entities.category]: newBudget,
        };
      }

      // Update preferences if anything changed
      if (Object.keys(preferences).length > 0) {
        await this.ikoService.updateIkoPreferences(userId, preferences);
      }

      // Update context with learned patterns
      const context = await this.ikoService.getIkoContext(userId);
      const learnedPatterns = context.learned_patterns || {};

      if (!learnedPatterns.ai_interactions) {
        learnedPatterns.ai_interactions = [];
      }

      learnedPatterns.ai_interactions.push({
        intent: intent.intent,
        category: intent.entities?.category,
        budget: intent.entities?.budget,
        product: intent.entities?.product,
        timestamp: new Date().toISOString(),
      });

      // Keep last 100 interactions
      if (learnedPatterns.ai_interactions.length > 100) {
        learnedPatterns.ai_interactions = learnedPatterns.ai_interactions.slice(-100);
      }

      // Update preferences_learned flag
      if (Object.keys(preferences).length > 0) {
        updates.preferences_learned = true;
      }
      updates.learned_patterns = learnedPatterns;

      await this.ikoService.updateIkoContext(userId, updates);
    } catch (error) {
      this.logger.error('Preference learning failed:', error);
      // Don't throw - learning failures shouldn't break the user experience
    }
  }
}
