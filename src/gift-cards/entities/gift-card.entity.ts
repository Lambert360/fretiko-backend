export interface GiftCardDesign {
  id: string;
  name: string;
  design_url: string;
  preview_url: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface GiftCard {
  id: string;
  card_number: string;
  pin: string;
  design_id: string;
  initial_balance: number;
  current_balance: number;
  status: 'active' | 'claimed' | 'redeemed' | 'expired' | 'blocked';
  purchaser_id: string;
  recipient_username?: string;
  recipient_user_id?: string;
  recipient_email?: string;
  recipient_phone?: string;
  delivery_method: 'none' | 'email' | 'chat' | 'both';
  email_sent_at?: string;
  email_sent_to?: string;
  chat_message_id?: string;
  chat_sent_at?: string;
  claimed_at?: string;
  claim_code: string;
  purchased_at: string;
  expires_at: string;
  last_used_at?: string;
  purchase_ip?: string;
  redemption_attempts: number;
  metadata: any;
  // Admin creation tracking
  created_by?: string;
  source: 'user_purchase' | 'admin_created';
  creation_reason?: string;
  is_commercial: boolean;
  created_at: string;
  updated_at: string;
  // Joined data
  design?: GiftCardDesign;
}

export interface GiftCardTransaction {
  id: string;
  gift_card_id: string;
  transaction_type: 'purchase' | 'claim' | 'redeem' | 'partial_redeem' | 'expire' | 'block' | 'admin_adjust';
  amount?: number;
  balance_after: number;
  order_id?: string;
  user_id?: string;
  user_ip?: string;
  metadata: any;
  created_at: string;
}

export interface SuggestedAmount {
  id: string;
  amount: number;
  display_name: string;
  is_popular: boolean;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

export interface AdminCreateGiftCardDto {
  amount: number;
  design_id: string;
  quantity?: number;
  creation_reason: string;
  is_commercial?: boolean;
  expiry_days?: number;
  notes?: string;
}
