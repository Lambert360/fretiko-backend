-- Fix participant hash function to handle UUID arrays properly
-- Run this in Supabase SQL Editor

BEGIN;

-- Drop existing functions if they exist
DROP FUNCTION IF EXISTS generate_participant_hash(TEXT[]);
DROP FUNCTION IF EXISTS generate_participant_hash(UUID[]);
DROP FUNCTION IF EXISTS update_existing_conversation_hashes();

-- Create function that works with UUID arrays (Supabase standard)
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

COMMIT;