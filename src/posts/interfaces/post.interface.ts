export enum MediaType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  MIXED = 'mixed',
}

export enum PrivacyLevel {
  PUBLIC = 'public',
  FRIENDS = 'friends',
  PRIVATE = 'private',
}

export enum InteractionType {
  LIKE = 'like',
  COMMENT = 'comment',
  SHARE = 'share',
  GIFT = 'gift',
}

export enum FeedItemType {
  POST = 'post',
  SERVICE = 'service',
}

export interface Post {
  id: string;
  userId: string;
  content: string | null;
  mediaUrls: string[];
  processedMediaUrls?: string[];
  mediaType: MediaType;
  privacyLevel: PrivacyLevel;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  giftsCount: number;
  isPinned: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  user?: UserInfo;
  isLiked?: boolean;
  isBookmarked?: boolean;
}

export interface PostMedia {
  id: string;
  postId: string;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  thumbnailUrl: string | null;
  fileSize: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  orderIndex: number;
  createdAt: Date;
}

export interface PostInteraction {
  id: string;
  postId: string;
  userId: string;
  interactionType: InteractionType;
  content: string | null;
  giftId: string | null;
  parentCommentId: string | null;
  createdAt: Date;
  user?: UserInfo;
  // Comment reaction fields (only applicable when interactionType = COMMENT)
  likesCount?: number;
  giftsCount?: number;
  isLiked?: boolean;
  isGifted?: boolean;
}

export interface PostBookmark {
  id: string;
  postId: string;
  userId: string;
  createdAt: Date;
}

export interface UnifiedFeedItem {
  id: string;
  type: FeedItemType;
  itemId: string;
  score: number;
  isSeen: boolean;
  createdAt: Date;
  // For posts
  postData?: Post;
  // For services (will be populated by service
  serviceData?: any;
}

export interface UserInfo {
  id: string;
  username: string;
  avatarUrl: string | null;
  isVerified: boolean;
}

export interface PostGift {
  id: string;
  postId: string;
  fromUserId: string;
  toUserId: string;
  giftType: 'virtual' | 'monetary';
  giftValue: number;
  giftIcon: string;
  message: string | null;
  createdAt: Date;
}

export interface FeedQueryParams {
  limit?: number;
  offset?: number;
  type?: FeedItemType;
  userId?: string;
}

export interface PostReport {
  id: string;
  postId: string;
  reporterId: string;
  reason: string;
  details: string | null;
  status: 'pending' | 'reviewing' | 'resolved' | 'dismissed';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}
