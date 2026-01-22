BEGIN;

-- =====================================================
-- CREATE ATOMIC SEND GIFT FUNCTION
-- Migration: 151
-- Date: 2026-01-20
-- Description: 
--   Atomic function for sending gifts that prevents race conditions
--   and ensures data consistency. Handles:
--   - Quantity validation (sums total owned quantity)
--   - Proper gift selection (handles partial quantities from multiple entries)
--   - Atomic transfer (sender removal + recipient addition in one transaction)
--   - Rollback on failure
-- =====================================================

CREATE OR REPLACE FUNCTION send_gift_atomic(
  p_sender_id UUID,
  p_recipient_id UUID,
  p_gift_id UUID,
  p_quantity INTEGER,
  p_session_type TEXT,
  p_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_owned INTEGER := 0;
  v_remaining_to_send INTEGER;
  v_gift_entry RECORD;
  v_gifts_to_remove UUID[];
  v_quantities_to_remove INTEGER[];
  v_current_entry_quantity INTEGER;
  v_gift_name VARCHAR(100);
  v_gift_emoji VARCHAR(10);
  v_source_type TEXT;
  v_user_gift_id UUID; -- ID of the user_gifts record (from INSERT RETURNING)
  v_send_transaction_id UUID;
  v_receive_transaction_id UUID;
  v_error_message TEXT;
BEGIN
  -- Validate inputs
  IF p_quantity <= 0 OR p_quantity > 10 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_QUANTITY',
      'message', 'Quantity must be between 1 and 10'
    );
  END IF;

  IF p_session_type NOT IN ('call', 'stream', 'auction') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_SESSION_TYPE',
      'message', 'Session type must be call, stream, or auction'
    );
  END IF;

  -- Map session type to source type
  CASE p_session_type
    WHEN 'call' THEN v_source_type := 'received_call';
    WHEN 'stream' THEN v_source_type := 'received_stream';
    WHEN 'auction' THEN v_source_type := 'received_auction';
  END CASE;

  -- Get gift details
  SELECT name, emoji INTO v_gift_name, v_gift_emoji
  FROM virtual_gifts
  WHERE id = p_gift_id AND is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'GIFT_NOT_FOUND',
      'message', 'Gift not found or inactive'
    );
  END IF;

  -- ✅ STEP 1: Calculate total owned quantity (sum all entries, not just count records)
  SELECT COALESCE(SUM(quantity), 0) INTO v_total_owned
  FROM user_gifts
  WHERE user_id = p_sender_id
    AND gift_id = p_gift_id;

  -- Validate sender has enough gifts
  IF v_total_owned < p_quantity THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INSUFFICIENT_GIFTS',
      'message', format('You only have %s of this gift, but trying to send %s', v_total_owned, p_quantity),
      'owned', v_total_owned,
      'requested', p_quantity
    );
  END IF;

  -- ✅ STEP 2: Select gifts to remove (properly handle partial quantities)
  -- Lock sender's gift entries to prevent concurrent modifications
  v_remaining_to_send := p_quantity;
  v_gifts_to_remove := ARRAY[]::UUID[];
  v_quantities_to_remove := ARRAY[]::INTEGER[];

  -- Fetch gift entries ordered by received_at (FIFO) with row locks
  FOR v_gift_entry IN
    SELECT id, quantity
    FROM user_gifts
    WHERE user_id = p_sender_id
      AND gift_id = p_gift_id
    ORDER BY received_at ASC
    FOR UPDATE -- Lock rows to prevent concurrent modifications
  LOOP
    IF v_remaining_to_send <= 0 THEN
      EXIT;
    END IF;

    v_current_entry_quantity := LEAST(v_gift_entry.quantity, v_remaining_to_send);
    v_remaining_to_send := v_remaining_to_send - v_current_entry_quantity;

    -- If using entire entry, mark for deletion
    IF v_current_entry_quantity = v_gift_entry.quantity THEN
      v_gifts_to_remove := array_append(v_gifts_to_remove, v_gift_entry.id);
      v_quantities_to_remove := array_append(v_quantities_to_remove, v_gift_entry.quantity);
    ELSE
      -- Partial quantity - update entry and track what we're removing
      UPDATE user_gifts
      SET quantity = quantity - v_current_entry_quantity
      WHERE id = v_gift_entry.id;

      v_quantities_to_remove := array_append(v_quantities_to_remove, v_current_entry_quantity);
    END IF;
  END LOOP;

  -- Delete entries that were fully consumed
  IF array_length(v_gifts_to_remove, 1) > 0 THEN
    DELETE FROM user_gifts
    WHERE id = ANY(v_gifts_to_remove);
  END IF;

  -- ✅ STEP 3: Add gifts to recipient (use upsert to handle unique constraint)
  -- The unique constraint is: (user_id, gift_id, source, received_from, session_id)
  -- We need to check if recipient already has this gift from this sender in this session
  INSERT INTO user_gifts (
    user_id,
    gift_id,
    quantity,
    source,
    received_from,
    session_id
  )
  VALUES (
    p_recipient_id,
    p_gift_id,
    p_quantity,
    v_source_type,
    p_sender_id,
    p_session_id
  )
  ON CONFLICT (user_id, gift_id, source, received_from, session_id)
  DO UPDATE SET
    quantity = user_gifts.quantity + p_quantity,
    received_at = NOW()
  RETURNING id INTO v_user_gift_id; -- Store user_gifts record ID (not transaction ID)

  -- ✅ STEP 4: Log transactions (both send and receive)
  -- Generate unique transaction IDs for gift_transactions table
  v_send_transaction_id := gen_random_uuid();
  v_receive_transaction_id := gen_random_uuid();

  INSERT INTO gift_transactions (
    id,
    user_id,
    gift_id,
    quantity,
    transaction_type,
    credit_amount,
    recipient_id,
    session_type,
    session_id
  ) VALUES
  (
    v_send_transaction_id,
    p_sender_id,
    p_gift_id,
    p_quantity,
    'send',
    NULL,
    p_recipient_id,
    p_session_type,
    p_session_id
  ),
  (
    v_receive_transaction_id,
    p_recipient_id,
    p_gift_id,
    p_quantity,
    'receive',
    NULL,
    NULL,
    p_session_type,
    p_session_id
  );

  -- ✅ STEP 5: Return success
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Gift sent successfully',
    'gift_name', v_gift_name,
    'gift_emoji', v_gift_emoji,
    'quantity', p_quantity,
    'sender_id', p_sender_id,
    'recipient_id', p_recipient_id,
    'send_transaction_id', v_send_transaction_id,
    'receive_transaction_id', v_receive_transaction_id
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Rollback is automatic in PostgreSQL transactions
    -- Log error for debugging
    v_error_message := SQLERRM;
    
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DATABASE_ERROR',
      'message', 'Failed to send gift: ' || v_error_message
    );
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION send_gift_atomic(UUID, UUID, UUID, INTEGER, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION send_gift_atomic IS 'Atomically sends gifts from sender to recipient, handling quantity validation, proper gift selection, and transaction logging. Prevents race conditions through row-level locking.';

COMMIT;

