BEGIN;

-- =====================================================
-- MIGRATION: 229
-- Atomic checkout claim for auction wins
--
-- Why:
--   Two concurrent createOrder calls can both read payment_status='pending'
--   and both create orders ~200ms apart — the double-charge seen in
--   production data. The sale-status check is a TOCTOU read; the win row's
--   own lock is the only place the claim can be made atomic.
--
-- What it does:
--   release_auction_win_hold now flips status to 'checked_out' INSIDE the
--   win row's FOR UPDATE lock — a second concurrent claimant blocks, then
--   sees 'checked_out' and cannot proceed. If the subsequent order RPC
--   fails, the service reverts the claim to 'pending_checkout'.
--
-- States returned:
--   claimed              — caller owns the checkout now (hold released)
--   already_checked_out  — win fully paid; order_id returned for the caller
--                          to return the existing order instead of a new one
--   checkout_in_progress — claimed <10min ago with no order yet; another
--                          checkout attempt is in flight (caller should 409)
--   stale claim          — 'checked_out' with NULL order_id older than
--                          10min is treated as an abandoned claim and
--                          reclaimed transparently
-- =====================================================

CREATE OR REPLACE FUNCTION release_auction_win_hold(
  p_win_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
  v_txn RECORD;
  v_released BOOLEAN := false;
BEGIN
  SELECT * INTO v_win
  FROM user_auction_wins
  WHERE id = p_win_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Auction win not found');
  END IF;

  IF v_win.user_id != p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Win does not belong to this user');
  END IF;

  IF v_win.status = 'checked_out' THEN
    IF v_win.order_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_checked_out', true,
        'order_id', v_win.order_id,
        'released', false
      );
    END IF;

    -- Claimed but never linked to an order: in-flight if fresh, abandoned
    -- if stale — reclaim stale claims so a crashed checkout can't wedge the win
    IF v_win.updated_at > NOW() - INTERVAL '10 minutes' THEN
      RETURN jsonb_build_object(
        'success', true,
        'checkout_in_progress', true,
        'released', false
      );
    END IF;
    -- stale claim → fall through and reclaim below
  ELSIF v_win.status != 'pending_checkout' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Win is not pending checkout');
  END IF;

  -- ATOMIC CLAIM inside the row lock: a concurrent caller blocks here and
  -- then observes 'checked_out' instead of passing the read-time check
  UPDATE user_auction_wins
  SET status = 'checked_out', updated_at = NOW()
  WHERE id = p_win_id;

  -- Release the winner-time hold if one was taken (idempotent key)
  IF EXISTS (
    SELECT 1 FROM wallet_ledger wl
    WHERE wl.user_id = p_user_id
      AND wl.transaction_type = 'purchase_hold'
      AND wl.reference_type = 'auction_win'
      AND wl.reference_id = p_win_id
  ) THEN
    SELECT * INTO v_txn
    FROM process_wallet_transaction(
      p_user_id,
      'escrow_refund',
      v_win.winning_bid,
      'Auction checkout — win hold released',
      p_win_id::text,
      'auction_win_release'
    );

    IF NOT v_txn.success THEN
      -- Roll the claim back together with the failed release
      UPDATE user_auction_wins
      SET status = 'pending_checkout', updated_at = NOW()
      WHERE id = p_win_id;
      RETURN jsonb_build_object('success', false, 'error', v_txn.error_message);
    END IF;

    v_released := true;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'claimed', true,
    'released', v_released,
    'amount', v_win.winning_bid
  );
END;
$$;

-- ---------------------------------------------------------------------
-- revert_stale_auction_win_claims — abandoned claims self-heal
--
-- A claim flips the win to 'checked_out' before the order exists. If the
-- caller dies between the claim and markWinCheckedOut (app killed, network
-- drop, process crash), the win would sit 'checked_out' with NULL order_id
-- forever — invisible to the expiry sweep and the item dead. Reverting
-- claims older than 10min back to 'pending_checkout' lets the normal
-- expiry/promotion machinery take over. The 10min window is comfortably
-- wider than order creation; a legitimately slow checkout that gets
-- reverted is healed by the completed-sale guard in the expiry sweep.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION revert_stale_auction_win_claims()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE user_auction_wins
  SET status = 'pending_checkout',
      updated_at = NOW()
  WHERE status = 'checked_out'
    AND order_id IS NULL
    AND updated_at < NOW() - INTERVAL '10 minutes';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMIT;
