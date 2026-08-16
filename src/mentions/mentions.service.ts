import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType, NotificationPriority } from '../notifications/dto/notification.dto';

export type MentionableType = 'post' | 'product' | 'service' | 'comment' | 'story';

export interface CommentParentResolution {
  parent_type: 'post' | 'story';
  parent_id: string;
}

@Injectable()
export class MentionsService {
  private readonly logger = new Logger(MentionsService.name);
  private serviceSupabase: SupabaseClient;

  constructor(
    private clientManager: SupabaseClientManager,
    private notificationsService: NotificationsService,
  ) {
    this.serviceSupabase = this.clientManager.getServiceClient();
  }

  /**
   * Extract raw usernames (without @) from a text block.
   * Example: "Hello @john and @Jane" -> ['john', 'Jane']
   */
  extractUsernames(text: string | null | undefined): string[] {
    if (!text) return [];

    const regex = /(^|\s)@([A-Za-z0-9_\.]{1,100})/g;
    const usernames = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const raw = match[2];
      if (raw) {
        usernames.add(raw.trim());
      }
    }

    return Array.from(usernames);
  }

  /**
   * Resolve usernames to user IDs from user_profiles.
   */
  async resolveUsernames(usernames: string[]): Promise<{ username: string; user_id: string }[]> {
    if (!usernames || usernames.length === 0) return [];

    const unique = Array.from(new Set(usernames.map(u => u.trim().toLowerCase()).filter(Boolean)));

    const { data, error } = await this.serviceSupabase
      .from('user_profiles')
      .select('id, username')
      .in('username', unique);

    if (error) {
      this.logger.error('Failed to resolve usernames', error);
      throw new Error(`Failed to resolve usernames: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      username: row.username,
      user_id: row.id,
    }));
  }

  /**
   * Create mentions for a given content item and notify mentioned users.
   * Chat messages are handled separately (no notifications).
   */
  async createMentions(
    mentionerUserId: string,
    mentionableId: string,
    mentionableType: MentionableType,
    text: string | null | undefined,
  ): Promise<void> {
    // Chat message mentions are not stored or notified
    if (mentionableType === ('chat_message' as any)) {
      return;
    }

    const usernames = this.extractUsernames(text);
    if (usernames.length === 0) {
      return;
    }

    const resolved = await this.resolveUsernames(usernames);

    if (!resolved || resolved.length === 0) {
      return;
    }

    const rows = resolved
      .filter(r => r.user_id !== mentionerUserId) // don't self-mention
      .map(r => ({
        mentioned_user_id: r.user_id,
        mentioner_user_id: mentionerUserId,
        mentionable_id: mentionableId,
        mentionable_type: mentionableType,
      }));

    if (rows.length === 0) {
      return;
    }

    const { error } = await this.serviceSupabase
      .from('mentions')
      .insert(rows);

    if (error) {
      this.logger.error('Failed to insert mentions', error);
      throw new Error(`Failed to insert mentions: ${error.message}`);
    }

    // Send notifications for each distinct mentioned user
    const uniqueUserIds = Array.from(new Set(rows.map(r => r.mentioned_user_id)));

    await Promise.all(
      uniqueUserIds.map(async (userId) => {
        try {
          await this.notificationsService.createNotification({
            user_id: userId,
            type: NotificationType.SOCIAL,
            title: 'You were mentioned',
            message: 'Someone mentioned you in a post',
            data: {
              mentionableId,
              mentionableType,
              mentionerUserId,
            },
            priority: NotificationPriority.MEDIUM,
          });
        } catch (err) {
          this.logger.error(`Failed to create mention notification for user ${userId}`, err as any);
        }
      }),
    );
  }

  /**
   * Get mentions for a specific user (where they were mentioned).
   * This is a simple listing for now and can be expanded later.
   */
  async getMentionsForUser(userId: string, options?: { limit?: number; offset?: number }) {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const { data, error } = await this.serviceSupabase
      .from('mentions')
      .select('*')
      .eq('mentioned_user_id', userId)
      .neq('mentionable_type', 'chat_message')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      this.logger.error('Failed to fetch mentions for user', { userId, error });
      throw new Error(`Failed to fetch mentions: ${error.message}`);
    }

    const mentions = data || [];
    if (mentions.length === 0) return [];

    const mentionerIds = [...new Set(mentions.map((m: any) => m.mentioner_user_id as string))];
    const { data: profiles } = await this.serviceSupabase
      .from('user_profiles')
      .select('id, username, avatar_url')
      .in('id', mentionerIds);

    const profileMap = new Map(
      (profiles || []).map((p: any) => [
        p.id,
        { username: p.username as string, avatarUrl: p.avatar_url as string | null },
      ]),
    );

    return mentions.map((m: any) => ({
      ...m,
      mentioner: profileMap.get(m.mentioner_user_id) ?? null,
    }));
  }

  async markAllMentionsAsRead(userId: string): Promise<void> {
    const { error } = await this.serviceSupabase
      .from('mentions')
      .update({ is_read: true })
      .eq('mentioned_user_id', userId)
      .eq('is_read', false);

    if (error) {
      this.logger.error('Failed to mark mentions as read', { userId, error });
      throw new Error(`Failed to mark mentions as read: ${error.message}`);
    }
  }

  /**
   * Resolve a comment mention (by comment id) back to its parent content.
   * Supports:
   *  - Post comments stored in post_interactions (interaction_type = 'comment')
   *  - Story comments stored in story_comments
   */
  async resolveCommentParent(commentId: string): Promise<CommentParentResolution | null> {
    // 1) Try to resolve as a post comment
    try {
      const { data: postComment, error: postError } = await this.serviceSupabase
        .from('post_interactions')
        .select('post_id')
        .eq('id', commentId)
        .eq('interaction_type', 'comment')
        .maybeSingle();

      if (postError) {
        this.logger.warn('Error while resolving post comment parent', { commentId, error: postError });
      }

      if (postComment && postComment.post_id) {
        return {
          parent_type: 'post',
          parent_id: postComment.post_id,
        };
      }
    } catch (e) {
      this.logger.error('Unexpected error resolving post comment parent', { commentId, error: e });
    }

    // 2) Try to resolve as a story comment
    try {
      const { data: storyComment, error: storyError } = await this.serviceSupabase
        .from('story_comments')
        .select('story_id')
        .eq('id', commentId)
        .maybeSingle();

      if (storyError) {
        this.logger.warn('Error while resolving story comment parent', { commentId, error: storyError });
      }

      if (storyComment && storyComment.story_id) {
        return {
          parent_type: 'story',
          parent_id: storyComment.story_id,
        };
      }
    } catch (e) {
      this.logger.error('Unexpected error resolving story comment parent', { commentId, error: e });
    }

    // Not found in any supported comment table
    return null;
  }
}
