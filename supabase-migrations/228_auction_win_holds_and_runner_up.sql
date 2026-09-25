BEGIN;

-- =====================================================
-- MIGRATION: 228
-- Winner-time wallet holds + runner-up promotion
--
-- Why:
--   Auction winners previously paid nothing until they chose to check out,
--   and a winner who ghosted left the item 'sold' forever — nobody else
--   could buy it. Per-bid wallet holds were rejected (ledger churn, wallet
--   row contention on hot items). Instead we take ONE purchase_hold when a
--   winner is finalized. If the winner cannot cover the hold, settlement
--   cascades to the next highest valid bidder until someone holds or bids
--   run out. On win expiry the hold is released and the same cascade
--   promotes a runner-up.
--
-- What it does:
--   1. mark_item_sold_atomic — re-written: candidate cascade with a
--      purchase_hold keyed reference_type='auction_win', reference_id=win.id.
--      Live item wins now expire after 48 hours (was 7 days).
--   2. end_auction_atomic — re-written: same cascade for timed auctions
--      (7-day win expiry kept).
--   3. expire_and_promote_auction_wins() — new: expires stale wins,
--      releases their holds, promotes the next bidder (with their own
--      hold), or marks the sale failed and the item passed.
--   4. release_auction_win_hold() — new: releases a winner's hold back to
--      available balance at checkout, before the order hold is taken.
--
-- Ledger types reused: purchase_hold / escrow_refund (no CHECK changes).
-- All holds/refunds are idempotent via (user_id, type, ref_type, ref_id).
-- =====================================================

-- ---------------------------------------------------------------------
-- 1. mark_item_sold_atomic — live item settlement with hold cascade
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS mark_item_sold_atomic(UUID, UUID, UUID);

CREATE OR REPLACE FUNCTION mark_item_sold_atomic(
  p_auction_id UUID,
  p_item_id UUID,
  p_seller_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction RECORD;
  v_item RECORD;
  v_next_item RECORD;
  v_candidate RECORD;
  v_existing_win RECORD;
  v_hold RECORD;
  v_exists BOOLEAN;
  v_win_id UUID;
  v_sale_id UUID;
  v_winner_id UUID;
  v_winning_bid DECIMAL(18,6);
  v_commission_rate DECIMAL(5,4);
  v_failed UUID[] := '{}';
  v_forfeited JSONB := '[]'::jsonb;
  v_settled BOOLEAN := false;
BEGIN
  -- Lock the auction row to serialize concurrent mark-as-sold calls
  SELECT id, seller_id, commission_rate
  INTO v_auction
  FROM auctions
  WHERE id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Auction not found');
  END IF;

  IF v_auction.seller_id != p_seller_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only the seller can mark item as sold');
  END IF;

  -- Lock the item row
  SELECT *
  INTO v_item
  FROM auction_items
  WHERE id = p_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item not found');
  END IF;

  IF v_item.auction_id != p_auction_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item does not belong to this auction');
  END IF;

  IF v_item.bidding_status != 'ended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item bidding must be ended before marking as sold');
  END IF;

  IF v_item.winner_id IS NULL OR v_item.winning_bid IS NULL OR v_item.winning_bid < v_item.starting_price THEN
    RETURN jsonb_build_object('success', false, 'error', 'No valid winning bid for this item');
  END IF;

  v_commission_rate := COALESCE(v_auction.commission_rate, 0.10);

  -- Candidate cascade: highest valid bid first. Each candidate gets a win row
  -- and a wallet hold attempt; whoever can fund the hold settles the item.
  LOOP
    SELECT b.bidder_id, b.amount, b.id AS bid_id
    INTO v_candidate
    FROM auction_bids b
    WHERE b.auction_id = p_auction_id
      AND b.item_id = p_item_id
      AND b.is_valid = true
      AND b.amount >= v_item.starting_price
      AND (v_item.reserve_price IS NULL OR b.amount >= v_item.reserve_price)
      AND NOT (b.bidder_id = ANY(v_failed))
    ORDER BY b.amount DESC, b.created_at ASC
    LIMIT 1;

    EXIT WHEN NOT FOUND;

    -- Win row first so the hold can reference it (48h checkout window for live items)
    INSERT INTO user_auction_wins (
      user_id, auction_id, item_id, winning_bid, status, expires_at, won_at, created_at, updated_at
    )
    VALUES (
      v_candidate.bidder_id, p_auction_id, p_item_id, v_candidate.amount,
      'pending_checkout', NOW() + INTERVAL '48 hours', NOW(), NOW(), NOW()
    )
    ON CONFLICT (user_id, auction_id, item_id) WHERE item_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_win_id;

    IF v_win_id IS NULL THEN
      -- The bidder already has a win row for this item (e.g. an expired one
      -- from a previous promotion cycle, or a re-run of this settlement)
      SELECT id, status INTO v_existing_win
      FROM user_auction_wins
      WHERE user_id = v_candidate.bidder_id
        AND auction_id = p_auction_id
        AND item_id = p_item_id;

      IF v_existing_win.status = 'pending_checkout' THEN
        v_win_id := v_existing_win.id;
      ELSE
        v_failed := array_append(v_failed, v_candidate.bidder_id);
        CONTINUE;
      END IF;
    END IF;

    -- Attempt the winner-time hold (idempotent via reference key)
    SELECT * INTO v_hold
    FROM process_wallet_transaction(
      v_candidate.bidder_id,
      'purchase_hold',
      v_candidate.amount,
      'Auction win hold',
      v_win_id::text,
      'auction_win'
    );

    IF v_hold.success THEN
      v_settled := true;
      v_winner_id := v_candidate.bidder_id;
      v_winning_bid := v_candidate.amount;
      EXIT;
    END IF;

    -- Hold failed (usually insufficient funds) — remove the win and move on
    DELETE FROM user_auction_wins WHERE id = v_win_id;
    UPDATE auction_bids SET is_winning = false WHERE id = v_candidate.bid_id;
    v_failed := array_append(v_failed, v_candidate.bidder_id);
    v_forfeited := v_forfeited || jsonb_build_object(
      'bidder_id', v_candidate.bidder_id,
      'amount', v_candidate.amount
    );
  END LOOP;

  IF v_settled THEN
    -- Flag only the settled bid as winning inside this item scope
    UPDATE auction_bids
    SET is_winning = false
    WHERE auction_id = p_auction_id AND item_id = p_item_id AND is_winning = true;

    UPDATE auction_bids
    SET is_winning = true
    WHERE id = v_candidate.bid_id;

    UPDATE auction_items
    SET bidding_status = 'sold',
        winner_id = v_winner_id,
        winning_bid = v_winning_bid,
        current_bid = v_winning_bid
    WHERE id = p_item_id;

    -- Create the sale idempotently (the item row is locked)
    SELECT EXISTS (
      SELECT 1 FROM auction_sales
      WHERE auction_id = p_auction_id
        AND item_id = p_item_id
        AND buyer_id = v_winner_id
    ) INTO v_exists;

    IF NOT v_exists THEN
      INSERT INTO auction_sales (
        auction_id, seller_id, buyer_id, item_id,
        final_bid_amount, commission_amount, buyer_premium_amount,
        total_amount, payment_status, created_at
      )
      VALUES (
        p_auction_id, v_auction.seller_id, v_winner_id, p_item_id,
        v_winning_bid, round(v_winning_bid * v_commission_rate, 6), 0,
        v_winning_bid, 'pending', NOW()
      )
      RETURNING id INTO v_sale_id;
    END IF;
  ELSE
    -- Nobody could cover the winning amount — pass the item
    v_win_id := NULL;
    UPDATE auction_items
    SET bidding_status = 'passed',
        winner_id = NULL,
        winning_bid = NULL,
        current_bid = v_item.starting_price
    WHERE id = p_item_id;
  END IF;

  -- Pick the next waiting item and update the auction's current_item_id
  SELECT id, title, starting_price, bid_increment, images
  INTO v_next_item
  FROM auction_items
  WHERE auction_id = p_auction_id
    AND bidding_status = 'waiting'
  ORDER BY order_in_auction ASC
  LIMIT 1;

  IF FOUND THEN
    UPDATE auctions SET current_item_id = v_next_item.id WHERE id = p_auction_id;
  ELSE
    UPDATE auctions SET current_item_id = NULL WHERE id = p_auction_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'outcome', CASE WHEN v_settled THEN 'sold' ELSE 'passed' END,
    'auction_id', p_auction_id,
    'item_id', p_item_id,
    'winner_id', v_winner_id,
    'winning_bid', v_winning_bid,
    'win_id', v_win_id,
    'sale_id', v_sale_id,
    'forfeited', v_forfeited,
    'next_item_id', v_next_item.id,
    'next_item_title', v_next_item.title,
    'next_item_starting_price', v_next_item.starting_price,
    'next_item_bid_increment', v_next_item.bid_increment,
    'next_item_images', v_next_item.images,
    'commission_rate', v_commission_rate
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 2. end_auction_atomic — timed auction settlement with hold cascade
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS end_auction_atomic(UUID);

CREATE OR REPLACE FUNCTION end_auction_atomic(p_auction_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction RECORD;
  v_candidate RECORD;
  v_existing_win RECORD;
  v_hold RECORD;
  v_new_status VARCHAR(20);
  v_reserve_met BOOLEAN;
  v_has_minimum_bidders BOOLEAN;
  v_event_message TEXT;
  v_sale_id UUID;
  v_win_id UUID;
  v_exists BOOLEAN;
  v_winner_id UUID;
  v_winning_bid DECIMAL(18,6);
  v_failed UUID[] := '{}';
  v_forfeited JSONB := '[]'::jsonb;
  v_settled BOOLEAN := false;
BEGIN
  -- Lock the auction row for the duration of the transaction
  SELECT
    id, seller_id, current_bid, winner_id, reserve_price, unique_bidders,
    commission_rate, buyer_premium_rate, status, end_time, title, auction_type
  INTO v_auction
  FROM auctions
  WHERE id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Auction not found', 'error_code', 'AUCTION_NOT_FOUND'
    );
  END IF;

  IF v_auction.status IN ('ended', 'sold', 'cancelled') THEN
    RETURN jsonb_build_object(
      'success', true, 'already_ended', true,
      'auction_id', p_auction_id, 'status', v_auction.status
    );
  END IF;

  IF v_auction.status != 'active' THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Auction is not active', 'error_code', 'NOT_ACTIVE'
    );
  END IF;

  IF v_auction.auction_type != 'timed' THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Only timed auctions can be auto-ended', 'error_code', 'NOT_TIMED'
    );
  END IF;

  IF v_auction.end_time > NOW() THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Auction has not ended yet', 'error_code', 'NOT_ENDED'
    );
  END IF;

  v_reserve_met := (v_auction.reserve_price IS NULL) OR (v_auction.current_bid >= v_auction.reserve_price);
  v_has_minimum_bidders := (v_auction.unique_bidders IS NOT NULL AND v_auction.unique_bidders >= 2);

  IF v_auction.current_bid > 0 AND v_reserve_met AND v_has_minimum_bidders THEN
    -- Candidate cascade: whoever can fund the winning hold takes the lot
    LOOP
      SELECT b.bidder_id, b.amount, b.id AS bid_id
      INTO v_candidate
      FROM auction_bids b
      WHERE b.auction_id = p_auction_id
        AND b.item_id IS NULL
        AND b.is_valid = true
        AND (v_auction.reserve_price IS NULL OR b.amount >= v_auction.reserve_price)
        AND NOT (b.bidder_id = ANY(v_failed))
      ORDER BY b.amount DESC, b.created_at ASC
      LIMIT 1;

      EXIT WHEN NOT FOUND;

      INSERT INTO user_auction_wins (
        user_id, auction_id, item_id, winning_bid, status, expires_at, won_at, created_at, updated_at
      )
      VALUES (
        v_candidate.bidder_id, p_auction_id, NULL, v_candidate.amount,
        'pending_checkout', NOW() + INTERVAL '7 days', NOW(), NOW(), NOW()
      )
      ON CONFLICT (user_id, auction_id) WHERE item_id IS NULL DO NOTHING
      RETURNING id INTO v_win_id;

      IF v_win_id IS NULL THEN
        SELECT id, status INTO v_existing_win
        FROM user_auction_wins
        WHERE user_id = v_candidate.bidder_id
          AND auction_id = p_auction_id
          AND item_id IS NULL;

        IF v_existing_win.status = 'pending_checkout' THEN
          v_win_id := v_existing_win.id;
        ELSE
          v_failed := array_append(v_failed, v_candidate.bidder_id);
          CONTINUE;
        END IF;
      END IF;

      SELECT * INTO v_hold
      FROM process_wallet_transaction(
        v_candidate.bidder_id,
        'purchase_hold',
        v_candidate.amount,
        'Auction win hold',
        v_win_id::text,
        'auction_win'
      );

      IF v_hold.success THEN
        v_settled := true;
        v_winner_id := v_candidate.bidder_id;
        v_winning_bid := v_candidate.amount;
        EXIT;
      END IF;

      DELETE FROM user_auction_wins WHERE id = v_win_id;
      UPDATE auction_bids SET is_winning = false WHERE id = v_candidate.bid_id;
      v_failed := array_append(v_failed, v_candidate.bidder_id);
      v_forfeited := v_forfeited || jsonb_build_object(
        'bidder_id', v_candidate.bidder_id,
        'amount', v_candidate.amount
      );
    END LOOP;
  END IF;

  IF v_settled THEN
    v_new_status := 'sold';
    v_event_message := 'Auction sold! Winning bid: ' || v_winning_bid::text || ' Freti';
  ELSIF v_auction.current_bid > 0 AND v_reserve_met AND v_has_minimum_bidders THEN
    -- There were qualifying bids but nobody could fund the hold
    v_new_status := 'ended';
    v_event_message := 'Auction ended. Winning bidder could not complete the purchase.';
  ELSE
    v_new_status := 'ended';

    IF v_auction.current_bid = 0 THEN
      v_event_message := 'Auction ended. No bids were placed.';
    ELSIF NOT v_reserve_met THEN
      v_event_message := 'Auction ended. Reserve price not met.';
    ELSE
      v_event_message := 'Auction ended. Minimum 2 bidders required (' || COALESCE(v_auction.unique_bidders, 0)::text || ' bidder(s) participated).';
    END IF;
  END IF;

  -- Atomically finalize the auction
  UPDATE auctions
  SET
    status = v_new_status,
    winner_id = CASE WHEN v_settled THEN v_winner_id ELSE winner_id END,
    winning_bid = CASE WHEN v_settled THEN v_winning_bid ELSE current_bid END,
    current_bid = CASE WHEN v_settled THEN v_winning_bid ELSE current_bid END,
    updated_at = NOW()
  WHERE id = p_auction_id;

  IF v_settled THEN
    UPDATE auction_bids
    SET is_winning = false
    WHERE auction_id = p_auction_id AND item_id IS NULL AND is_winning = true;

    UPDATE auction_bids
    SET is_winning = true
    WHERE id = v_candidate.bid_id;

    -- Avoid duplicate sale records
    SELECT EXISTS (
      SELECT 1 FROM auction_sales
      WHERE auction_id = p_auction_id
        AND buyer_id = v_winner_id
    ) INTO v_exists;

    IF NOT v_exists THEN
      INSERT INTO auction_sales (
        auction_id, seller_id, buyer_id,
        final_bid_amount, commission_amount, buyer_premium_amount,
        total_amount, payment_status, created_at
      ) VALUES (
        p_auction_id, v_auction.seller_id, v_winner_id,
        v_winning_bid,
        round(v_winning_bid * COALESCE(v_auction.commission_rate, 0.10), 6),
        round(v_winning_bid * COALESCE(v_auction.buyer_premium_rate, 0.00), 6),
        v_winning_bid,
        'pending',
        NOW()
      )
      RETURNING id INTO v_sale_id;
    END IF;
  END IF;

  -- Log the auction end/sold event
  INSERT INTO auction_events (
    auction_id, event_type, event_data, timestamp, auctioneer_message, auctioneer_spoken
  ) VALUES (
    p_auction_id,
    CASE WHEN v_new_status = 'sold' THEN 'sold' ELSE 'auction_ended' END,
    jsonb_build_object(
      'final_bid', COALESCE(v_winning_bid, v_auction.current_bid),
      'winner_id', v_winner_id,
      'reserve_met', v_new_status = 'sold',
      'forfeited_count', jsonb_array_length(v_forfeited)
    ),
    NOW(),
    v_event_message,
    false
  );

  RETURN jsonb_build_object(
    'success', true,
    'auction_id', p_auction_id,
    'new_status', v_new_status,
    'winning_bid', COALESCE(v_winning_bid, v_auction.current_bid),
    'winner_id', v_winner_id,
    'seller_id', v_auction.seller_id,
    'message', v_event_message,
    'sale_id', v_sale_id,
    'win_id', v_win_id,
    'forfeited', v_forfeited
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'error_code', 'INTERNAL_ERROR'
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 3. expire_and_promote_auction_wins — expiry + hold release + promotion
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION expire_and_promote_auction_wins()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
  v_item_start DECIMAL(18,6);
  v_item_reserve DECIMAL(18,6);
  v_auction RECORD;
  v_candidate RECORD;
  v_existing_win RECORD;
  v_sale RECORD;
  v_hold RECORD;
  v_excluded UUID[];
  v_new_win_id UUID;
  v_settled BOOLEAN;
  v_rows INTEGER;
  v_expired JSONB := '[]'::jsonb;
  v_promoted JSONB := '[]'::jsonb;
  v_forfeited JSONB := '[]'::jsonb;
  v_failed_sales JSONB := '[]'::jsonb;
BEGIN
  FOR v_win IN
    SELECT *
    FROM user_auction_wins
    WHERE status = 'pending_checkout'
      AND expires_at < NOW()
    ORDER BY expires_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Per-win subtransaction: a failure on one win rolls back only that
    -- row's work (the win stays pending_checkout for the next run) instead
    -- of aborting the entire sweep.
    BEGIN
    -- Self-heal: if a paid/processing sale already exists for this buyer in
    -- this scope, the order went through but markWinCheckedOut never landed.
    -- Heal the win instead of expiring it and promoting a runner-up over an
    -- already-paid order.
    SELECT s.id, s.payment_transaction_id
    INTO v_sale
    FROM auction_sales s
    WHERE s.auction_id = v_win.auction_id
      AND s.item_id IS NOT DISTINCT FROM v_win.item_id
      AND s.buyer_id = v_win.user_id
      AND s.payment_status IN ('processing', 'completed')
    LIMIT 1;

    IF FOUND THEN
      UPDATE user_auction_wins
      SET status = 'checked_out',
          order_id = COALESCE(order_id, v_sale.payment_transaction_id),
          updated_at = NOW()
      WHERE id = v_win.id;
      CONTINUE;
    END IF;

    -- Expire the win
    UPDATE user_auction_wins
    SET status = 'expired', updated_at = NOW()
    WHERE id = v_win.id;

    -- Release the winner-time hold if one was taken for this win
    IF EXISTS (
      SELECT 1 FROM wallet_ledger wl
      WHERE wl.user_id = v_win.user_id
        AND wl.transaction_type = 'purchase_hold'
        AND wl.reference_type = 'auction_win'
        AND wl.reference_id = v_win.id
    ) THEN
      SELECT * INTO v_hold
      FROM process_wallet_transaction(
        v_win.user_id,
        'escrow_refund',
        v_win.winning_bid,
        'Auction win expired — hold released',
        v_win.id::text,
        'auction_win_release'
      );
    END IF;

    v_expired := v_expired || jsonb_build_object(
      'win_id', v_win.id,
      'user_id', v_win.user_id,
      'auction_id', v_win.auction_id,
      'item_id', v_win.item_id,
      'amount', v_win.winning_bid
    );

    -- Bidders who already forfeited/ghosted this scope are excluded
    SELECT COALESCE(array_agg(user_id), '{}')
    INTO v_excluded
    FROM user_auction_wins
    WHERE auction_id = v_win.auction_id
      AND item_id IS NOT DISTINCT FROM v_win.item_id
      AND status IN ('expired', 'cancelled');

    SELECT id, seller_id, starting_price, reserve_price, commission_rate, buyer_premium_rate, status
    INTO v_auction
    FROM auctions
    WHERE id = v_win.auction_id;

    IF v_win.item_id IS NOT NULL THEN
      SELECT starting_price, reserve_price
      INTO v_item_start, v_item_reserve
      FROM auction_items
      WHERE id = v_win.item_id;
    ELSE
      v_item_start := NULL;
      v_item_reserve := NULL;
    END IF;

    -- Promotion cascade: next highest valid bidder who can fund a hold
    v_settled := false;
    LOOP
      SELECT b.bidder_id, b.amount, b.id AS bid_id
      INTO v_candidate
      FROM auction_bids b
      WHERE b.auction_id = v_win.auction_id
        AND b.item_id IS NOT DISTINCT FROM v_win.item_id
        AND b.is_valid = true
        AND (v_win.item_id IS NULL OR b.amount >= COALESCE(v_item_start, 0))
        AND (v_win.item_id IS NULL OR v_item_reserve IS NULL OR b.amount >= v_item_reserve)
        AND (v_win.item_id IS NOT NULL OR v_auction.reserve_price IS NULL OR b.amount >= v_auction.reserve_price)
        AND NOT (b.bidder_id = ANY(v_excluded))
      ORDER BY b.amount DESC, b.created_at ASC
      LIMIT 1;

      EXIT WHEN NOT FOUND;

      INSERT INTO user_auction_wins (
        user_id, auction_id, item_id, winning_bid, status, expires_at, won_at, created_at, updated_at
      )
      VALUES (
        v_candidate.bidder_id, v_win.auction_id, v_win.item_id, v_candidate.amount,
        'pending_checkout',
        CASE WHEN v_win.item_id IS NULL
             THEN NOW() + INTERVAL '7 days'
             ELSE NOW() + INTERVAL '48 hours' END,
        NOW(), NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_new_win_id;

      IF v_new_win_id IS NULL THEN
        SELECT id, status INTO v_existing_win
        FROM user_auction_wins
        WHERE user_id = v_candidate.bidder_id
          AND auction_id = v_win.auction_id
          AND item_id IS NOT DISTINCT FROM v_win.item_id;

        IF v_existing_win.status = 'pending_checkout' THEN
          v_new_win_id := v_existing_win.id;
        ELSE
          v_excluded := array_append(v_excluded, v_candidate.bidder_id);
          CONTINUE;
        END IF;
      END IF;

      SELECT * INTO v_hold
      FROM process_wallet_transaction(
        v_candidate.bidder_id,
        'purchase_hold',
        v_candidate.amount,
        'Auction win hold',
        v_new_win_id::text,
        'auction_win'
      );

      IF v_hold.success THEN
        v_settled := true;
        EXIT;
      END IF;

      DELETE FROM user_auction_wins WHERE id = v_new_win_id;
      UPDATE auction_bids SET is_winning = false WHERE id = v_candidate.bid_id;
      v_excluded := array_append(v_excluded, v_candidate.bidder_id);
      v_forfeited := v_forfeited || jsonb_build_object(
        'bidder_id', v_candidate.bidder_id,
        'auction_id', v_win.auction_id,
        'item_id', v_win.item_id,
        'amount', v_candidate.amount
      );
    END LOOP;

    IF v_settled THEN
      -- Re-point winning flags at the promoted bid
      UPDATE auction_bids
      SET is_winning = false
      WHERE auction_id = v_win.auction_id
        AND item_id IS NOT DISTINCT FROM v_win.item_id
        AND is_winning = true;

      UPDATE auction_bids
      SET is_winning = true
      WHERE id = v_candidate.bid_id;

      IF v_win.item_id IS NOT NULL THEN
        UPDATE auction_items
        SET winner_id = v_candidate.bidder_id,
            winning_bid = v_candidate.amount,
            current_bid = v_candidate.amount
        WHERE id = v_win.item_id;
      ELSE
        UPDATE auctions
        SET winner_id = v_candidate.bidder_id,
            winning_bid = v_candidate.amount,
            current_bid = v_candidate.amount,
            updated_at = NOW()
        WHERE id = v_win.auction_id;
      END IF;

      -- Re-point the pending sale at the new buyer; create it if missing
      UPDATE auction_sales
      SET buyer_id = v_candidate.bidder_id,
          final_bid_amount = v_candidate.amount,
          commission_amount = round(v_candidate.amount * COALESCE(v_auction.commission_rate, 0.10), 6),
          buyer_premium_amount = CASE WHEN v_win.item_id IS NULL
            THEN round(v_candidate.amount * COALESCE(v_auction.buyer_premium_rate, 0.00), 6)
            ELSE 0 END,
          total_amount = v_candidate.amount,
          payment_transaction_id = NULL
      WHERE auction_id = v_win.auction_id
        AND item_id IS NOT DISTINCT FROM v_win.item_id
        AND buyer_id = v_win.user_id
        AND payment_status = 'pending';

      GET DIAGNOSTICS v_rows = ROW_COUNT;

      IF v_rows = 0 THEN
        INSERT INTO auction_sales (
          auction_id, seller_id, buyer_id, item_id,
          final_bid_amount, commission_amount, buyer_premium_amount,
          total_amount, payment_status, created_at
        ) VALUES (
          v_win.auction_id, v_auction.seller_id, v_candidate.bidder_id, v_win.item_id,
          v_candidate.amount,
          round(v_candidate.amount * COALESCE(v_auction.commission_rate, 0.10), 6),
          CASE WHEN v_win.item_id IS NULL
            THEN round(v_candidate.amount * COALESCE(v_auction.buyer_premium_rate, 0.00), 6)
            ELSE 0 END,
          v_candidate.amount,
          'pending',
          NOW()
        );
      END IF;

      v_promoted := v_promoted || jsonb_build_object(
        'win_id', v_new_win_id,
        'user_id', v_candidate.bidder_id,
        'auction_id', v_win.auction_id,
        'item_id', v_win.item_id,
        'amount', v_candidate.amount
      );
    ELSE
      -- Nobody left who can pay — fail the scope and demote the stale
      -- winning flag left on the expired winner's bid
      UPDATE auction_bids
      SET is_winning = false
      WHERE auction_id = v_win.auction_id
        AND item_id IS NOT DISTINCT FROM v_win.item_id
        AND is_winning = true;

      IF v_win.item_id IS NOT NULL THEN
        UPDATE auction_items
        SET bidding_status = 'passed',
            winner_id = NULL,
            winning_bid = NULL
        WHERE id = v_win.item_id
          AND bidding_status = 'sold';
      ELSE
        UPDATE auctions
        SET status = 'ended', updated_at = NOW()
        WHERE id = v_win.auction_id
          AND status = 'sold';
      END IF;

      UPDATE auction_sales
      SET payment_status = 'failed'
      WHERE auction_id = v_win.auction_id
        AND item_id IS NOT DISTINCT FROM v_win.item_id
        AND buyer_id = v_win.user_id
        AND payment_status = 'pending';

      v_failed_sales := v_failed_sales || jsonb_build_object(
        'auction_id', v_win.auction_id,
        'item_id', v_win.item_id,
        'user_id', v_win.user_id,
        'seller_id', v_auction.seller_id
      );
    END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed_sales := v_failed_sales || jsonb_build_object(
        'win_id', v_win.id,
        'auction_id', v_win.auction_id,
        'item_id', v_win.item_id,
        'user_id', v_win.user_id,
        'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'expired', v_expired,
    'promoted', v_promoted,
    'forfeited', v_forfeited,
    'failed', v_failed_sales
  );
END;
$$;

-- Legacy shim: keep expire_old_auction_wins() working for any existing
-- callers, delegating to the new function so stale semantics (expiring
-- wins without releasing holds or promoting runner-ups) never run again.
CREATE OR REPLACE FUNCTION expire_old_auction_wins()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  v_result := expire_and_promote_auction_wins();
  RETURN jsonb_array_length(COALESCE(v_result->'expired', '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------
-- 4. release_auction_win_hold — checkout releases the winner-time hold
--    before the order RPC takes its own hold for the full total
-- ---------------------------------------------------------------------

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
    RETURN jsonb_build_object('success', true, 'already_checked_out', true, 'released', false);
  END IF;

  IF v_win.status != 'pending_checkout' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Win is not pending checkout');
  END IF;

  -- Only refund if a winner-time hold was actually taken
  IF EXISTS (
    SELECT 1 FROM wallet_ledger wl
    WHERE wl.user_id = p_user_id
      AND wl.transaction_type = 'purchase_hold'
      AND wl.reference_type = 'auction_win'
      AND wl.reference_id = p_win_id
  ) THEN
    -- escrow_refund is idempotent on (user, type, 'auction_win_release', win_id)
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
      RETURN jsonb_build_object('success', false, 'error', v_txn.error_message);
    END IF;

    RETURN jsonb_build_object('success', true, 'released', true, 'amount', v_win.winning_bid);
  END IF;

  RETURN jsonb_build_object('success', true, 'released', false);
END;
$$;

COMMIT;
