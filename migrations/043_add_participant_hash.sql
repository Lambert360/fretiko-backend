-- Industry Standard: Add participant hash for efficient conversation matching
-- This is the standard approach used by WhatsApp, Telegram, Discord, etc.

BEGIN;

-- Add participant_hash column to conversations table
ALTER TABLE public.chat_conversations
ADD COLUMN IF NOT EXISTS participant_hash TEXT;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_chat_conversations_participant_hash
ON public.chat_conversations(participant_hash);

-- Create function to generate participant hash (using UUID[] for Supabase)
CREATE OR REPLACE FUNCTION generate_participant_hash(participant_ids UUID[])
RETURNS TEXT AS $$
BEGIN
    -- Sort participant IDs and create a hash
    -- Convert UUIDs to text, sort them, then hash
    RETURN encode(
        digest(
            array_to_string(
                array(
                    SELECT unnest(participant_ids)::text
                    ORDER BY 1
                ),
                ','
            ),
            'sha256'
        ),
        'hex'
    );
END;
$$ LANGUAGE plpgsql;

-- Create function to update existing conversations with participant hashes
CREATE OR REPLACE FUNCTION update_existing_conversation_hashes()
RETURNS void AS $$
DECLARE
    conv_record RECORD;
    participant_ids TEXT[];
BEGIN
    -- Update all existing conversations with participant hashes
    FOR conv_record IN
        SELECT
            cc.id as conversation_id,
            array_agg(cp.user_id ORDER BY cp.user_id) as participants
        FROM public.chat_conversations cc
        LEFT JOIN public.chat_participants cp ON cc.id = cp.conversation_id
        WHERE cc.participant_hash IS NULL
        GROUP BY cc.id
    LOOP
        IF conv_record.participants IS NOT NULL THEN
            UPDATE public.chat_conversations
            SET participant_hash = generate_participant_hash(conv_record.participants)
            WHERE id = conv_record.conversation_id;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Update existing conversations
SELECT update_existing_conversation_hashes();

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION generate_participant_hash(UUID[]) TO PUBLIC;

-- Add constraint to ensure participant_hash is always set for new conversations
-- (We'll handle this in the application code)

COMMIT;