/**
 * Gift Entity Definitions
 * Database entity types for virtual gifts system
 */

export interface VirtualGift {
  id: string;
  name: string;
  emoji: string;
  credit_value: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface UserGift {
  id: string;
  user_id: string;
  gift_id: string;
  quantity: number;
  source: 'purchased' | 'received_call' | 'received_stream' | 'received_auction';
  received_from: string | null;
  session_id: string | null;
  received_at: string;
  created_at: string;
  // Joined data
  gift?: VirtualGift;
}

export interface GiftTransaction {
  id: string;
  user_id: string;
  gift_id: string;
  quantity: number;
  transaction_type: 'purchase' | 'convert' | 'send' | 'receive';
  credit_amount: number | null;
  recipient_id: string | null;
  session_type: 'call' | 'stream' | 'auction' | null;
  session_id: string | null;
  created_at: string;
}

export interface UserGiftWithDetails extends UserGift {
  gift: VirtualGift;
  total_value: number; // quantity * credit_value
}

