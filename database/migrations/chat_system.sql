-- Enhanced Chat System Database Schema
-- This migration creates all necessary tables for the comprehensive chat functionality

-- Create enum types for better data integrity
CREATE TYPE message_type AS ENUM (
    'text', 
    'image', 
    'audio', 
    'video', 
    'file', 
    'livestream', 
    'auction', 
    'system'
);

CREATE TYPE message_status_enum AS ENUM (
    'sending', 
    'sent', 
    'delivered', 
    'read'
);

CREATE TYPE chat_type AS ENUM (
    'friend', 
    'vendor', 
    'support', 
    'ai', 
    'rider'
);

CREATE TYPE call_type AS ENUM (
    'audio', 
    'video'
);

CREATE TYPE call_status AS ENUM (
    'calling', 
    'connected', 
    'ended', 
    'missed', 
    'declined'
);

CREATE TYPE auction_status AS ENUM (
    'active', 
    'ended', 
    'cancelled'
);

CREATE TYPE livestream_status AS ENUM (
    'live', 
    'ended', 
    'scheduled'
);

-- Chat conversations table
CREATE TABLE IF NOT EXISTS chat_conversations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    chat_type chat_type NOT NULL DEFAULT 'friend',
    is_group BOOLEAN DEFAULT FALSE,
    name TEXT, -- For group chats or custom names
    description TEXT,
    avatar_url TEXT,
    created_by UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT TRUE,
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}' -- Additional chat settings, pinned status, etc.
);

-- Chat participants (many-to-many relationship)
CREATE TABLE IF NOT EXISTS chat_participants (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    left_at TIMESTAMP WITH TIME ZONE,
    role TEXT DEFAULT 'member', -- 'admin', 'member', 'viewer'
    is_muted BOOLEAN DEFAULT FALSE,
    is_pinned BOOLEAN DEFAULT FALSE,
    last_read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    notification_settings JSONB DEFAULT '{}',
    UNIQUE(conversation_id, user_id)
);

-- Messages table (main chat messages)
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    message_type message_type NOT NULL DEFAULT 'text',
    content TEXT, -- Text content or description
    media_url TEXT, -- URL for images, videos, audio files
    file_metadata JSONB, -- File info: name, size, type, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    edited_at TIMESTAMP WITH TIME ZONE,
    is_deleted BOOLEAN DEFAULT FALSE,
    reply_to_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}' -- Additional message data
);

-- Message status tracking (for delivery/read receipts)
CREATE TABLE IF NOT EXISTS message_status (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    status message_status_enum NOT NULL DEFAULT 'sent',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(message_id, user_id)
);

-- File uploads table (for media storage tracking)
CREATE TABLE IF NOT EXISTS chat_file_uploads (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID REFERENCES chat_messages(id) ON DELETE CASCADE,
    uploader_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    file_type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_path TEXT NOT NULL, -- Supabase storage path
    public_url TEXT NOT NULL,
    upload_completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Live streams table
CREATE TABLE IF NOT EXISTS chat_livestreams (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID REFERENCES chat_messages(id) ON DELETE CASCADE,
    streamer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status livestream_status NOT NULL DEFAULT 'scheduled',
    thumbnail_url TEXT,
    stream_url TEXT,
    viewer_count INTEGER DEFAULT 0,
    max_viewers INTEGER DEFAULT 0,
    started_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE,
    scheduled_for TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}' -- Stream settings, quality, etc.
);

-- Livestream viewers tracking
CREATE TABLE IF NOT EXISTS livestream_viewers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    livestream_id UUID REFERENCES chat_livestreams(id) ON DELETE CASCADE,
    viewer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    left_at TIMESTAMP WITH TIME ZONE,
    watch_duration INTEGER DEFAULT 0, -- in seconds
    UNIQUE(livestream_id, viewer_id)
);

-- Auctions table
CREATE TABLE IF NOT EXISTS chat_auctions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID REFERENCES chat_messages(id) ON DELETE CASCADE,
    seller_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
    item_name TEXT NOT NULL,
    description TEXT,
    starting_price DECIMAL(10,2) NOT NULL,
    current_price DECIMAL(10,2) NOT NULL,
    buy_now_price DECIMAL(10,2),
    status auction_status NOT NULL DEFAULT 'active',
    image_urls JSONB DEFAULT '[]', -- Array of image URLs
    category TEXT,
    condition TEXT,
    location TEXT,
    ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    winner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    total_bids INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}' -- Additional auction settings
);

-- Auction bids table
CREATE TABLE IF NOT EXISTS auction_bids (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    auction_id UUID REFERENCES chat_auctions(id) ON DELETE CASCADE,
    bidder_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    bid_amount DECIMAL(10,2) NOT NULL,
    is_auto_bid BOOLEAN DEFAULT FALSE,
    max_auto_bid DECIMAL(10,2),
    placed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_winning BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'
);

-- Call sessions table
CREATE TABLE IF NOT EXISTS chat_call_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
    initiator_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    call_type call_type NOT NULL,
    status call_status NOT NULL DEFAULT 'calling',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    answered_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE,
    duration INTEGER DEFAULT 0, -- in seconds
    end_reason TEXT, -- 'completed', 'declined', 'missed', 'error'
    recording_url TEXT, -- If call was recorded
    metadata JSONB DEFAULT '{}' -- Call quality, participants, etc.
);

-- Call participants table
CREATE TABLE IF NOT EXISTS call_participants (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    call_session_id UUID REFERENCES chat_call_sessions(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    left_at TIMESTAMP WITH TIME ZONE,
    is_muted BOOLEAN DEFAULT FALSE,
    is_video_enabled BOOLEAN DEFAULT FALSE,
    connection_quality TEXT DEFAULT 'good', -- 'excellent', 'good', 'poor'
    UNIQUE(call_session_id, user_id)
);

-- AI assistant interactions (for Mo)
CREATE TABLE IF NOT EXISTS ai_assistant_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    session_type TEXT NOT NULL, -- 'chat', 'research', 'planning'
    context JSONB DEFAULT '{}', -- Conversation context, user preferences
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}'
);

-- AI research requests
CREATE TABLE IF NOT EXISTS ai_research_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id UUID REFERENCES ai_assistant_sessions(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    research_type TEXT DEFAULT 'general', -- 'product', 'price', 'reviews', 'general'
    status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    results JSONB DEFAULT '{}',
    sources JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}'
);

-- Activity planning sessions
CREATE TABLE IF NOT EXISTS activity_planning_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ai_session_id UUID REFERENCES ai_assistant_sessions(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    activity_type TEXT NOT NULL, -- 'event', 'trip', 'meeting', 'shopping'
    title TEXT NOT NULL,
    description TEXT,
    planned_date TIMESTAMP WITH TIME ZONE,
    location TEXT,
    participants JSONB DEFAULT '[]', -- Array of user IDs
    budget DECIMAL(10,2),
    status TEXT DEFAULT 'planning', -- 'planning', 'confirmed', 'completed', 'cancelled'
    suggestions JSONB DEFAULT '{}', -- AI suggestions for the activity
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at ON chat_conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_created_by ON chat_conversations(created_by);
CREATE INDEX IF NOT EXISTS idx_chat_participants_user_id ON chat_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_conversation_id ON chat_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_id ON chat_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_status_message_id ON message_status(message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_user_id ON message_status(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_livestreams_status ON chat_livestreams(status);
CREATE INDEX IF NOT EXISTS idx_chat_auctions_status ON chat_auctions(status);
CREATE INDEX IF NOT EXISTS idx_chat_auctions_ends_at ON chat_auctions(ends_at);
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction_id ON auction_bids(auction_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_conversation_id ON chat_call_sessions(conversation_id);

-- Row Level Security (RLS) Policies

-- Enable RLS on all tables
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_file_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_livestreams ENABLE ROW LEVEL SECURITY;
ALTER TABLE livestream_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_assistant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_research_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_planning_sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for chat_conversations
CREATE POLICY "Users can view conversations they participate in" ON chat_conversations
    FOR SELECT USING (
        id IN (
            SELECT conversation_id FROM chat_participants 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create conversations" ON chat_conversations
    FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY "Participants can update conversations" ON chat_conversations
    FOR UPDATE USING (
        id IN (
            SELECT conversation_id FROM chat_participants 
            WHERE user_id = auth.uid()
        )
    );

-- RLS Policies for chat_participants
CREATE POLICY "Users can view participants in their conversations" ON chat_participants
    FOR SELECT USING (
        conversation_id IN (
            SELECT conversation_id FROM chat_participants 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can join conversations" ON chat_participants
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own participation" ON chat_participants
    FOR UPDATE USING (user_id = auth.uid());

-- RLS Policies for chat_messages
CREATE POLICY "Users can view messages in their conversations" ON chat_messages
    FOR SELECT USING (
        conversation_id IN (
            SELECT conversation_id FROM chat_participants 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can send messages to their conversations" ON chat_messages
    FOR INSERT WITH CHECK (
        sender_id = auth.uid() AND
        conversation_id IN (
            SELECT conversation_id FROM chat_participants 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update their own messages" ON chat_messages
    FOR UPDATE USING (sender_id = auth.uid());

-- RLS Policies for message_status
CREATE POLICY "Users can view message status for their messages" ON message_status
    FOR SELECT USING (
        user_id = auth.uid() OR
        message_id IN (
            SELECT id FROM chat_messages 
            WHERE sender_id = auth.uid()
        )
    );

CREATE POLICY "Users can update message status" ON message_status
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their message status" ON message_status
    FOR UPDATE USING (user_id = auth.uid());

-- RLS Policies for other tables (file uploads, livestreams, auctions, etc.)
CREATE POLICY "Users can view files in their conversations" ON chat_file_uploads
    FOR SELECT USING (
        message_id IN (
            SELECT id FROM chat_messages 
            WHERE conversation_id IN (
                SELECT conversation_id FROM chat_participants 
                WHERE user_id = auth.uid()
            )
        )
    );

CREATE POLICY "Users can upload files to their messages" ON chat_file_uploads
    FOR INSERT WITH CHECK (uploader_id = auth.uid());

-- Similar policies for livestreams, auctions, calls, etc.
CREATE POLICY "Users can view livestreams in their conversations" ON chat_livestreams
    FOR SELECT USING (
        conversation_id IN (
            SELECT conversation_id FROM chat_participants 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create livestreams" ON chat_livestreams
    FOR INSERT WITH CHECK (streamer_id = auth.uid());

CREATE POLICY "Users can view auctions in their conversations" ON chat_auctions
    FOR SELECT USING (
        conversation_id IN (
            SELECT conversation_id FROM chat_participants 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create auctions" ON chat_auctions
    FOR INSERT WITH CHECK (seller_id = auth.uid());

-- Functions for updating timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for auto-updating timestamps
CREATE TRIGGER update_chat_conversations_updated_at BEFORE UPDATE ON chat_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_chat_messages_updated_at BEFORE UPDATE ON chat_messages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_chat_livestreams_updated_at BEFORE UPDATE ON chat_livestreams
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_chat_auctions_updated_at BEFORE UPDATE ON chat_auctions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to update conversation last_message_at when new message is added
CREATE OR REPLACE FUNCTION update_conversation_last_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE chat_conversations 
    SET last_message_at = NEW.created_at
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_conversation_last_message_trigger 
    AFTER INSERT ON chat_messages
    FOR EACH ROW EXECUTE FUNCTION update_conversation_last_message();

-- Create storage buckets for media files (run this in Supabase dashboard or via API)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('chat-media', 'chat-media', true);
-- INSERT INTO storage.buckets (id, name, public) VALUES ('auction-images', 'auction-images', true);
-- INSERT INTO storage.buckets (id, name, public) VALUES ('livestream-thumbnails', 'livestream-thumbnails', true);