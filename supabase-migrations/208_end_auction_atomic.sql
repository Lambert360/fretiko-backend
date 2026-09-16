BEGIN;

-- =====================================================
-- MIGRATION: 208
-- Create end_auction_atomic(p_auction_id UUID)
--
-- Why:
--   The previous JS scheduler selected the auction winner, then later
--   wrote that snapshot back. A last-second sniper bid could be accepted
--   but then overwritten by the stale cron, producing the wrong winner.
--
-- What this does:
--   Locks the auction row, uses the live current_bid/winner_id already
--   maintained by the bid trigger, atomically sets status to sold/ended,
--   creates auction_sales and user_auction_wins when sold, and logs the
--   auction event. Everything is one Postgres transaction.
--
-- Note:
--   Only works for timed auctions. Live auctions are closed by the host.
-- =====================================================

DROP FUNCTION IF EXISTS end_auction_atomic(UUID);

CREATE OR REPLACE FUNCTION end_auction_atomic(p_auction_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction RECORD;
  v_new_status VARCHAR(20);
  v_reserve_met BOOLEAN;
  v_has_minimum_bidders BOOLEAN;
  v_event_message TEXT;
  v_sale_id UUID;
  v_win_id UUID;
  v_exists BOOLEAN;
BEGIN
  -- Lock the auction row for the duration of the transaction
  SELECT
    id,
    seller_id,
    current_bid,
    winner_id,
    reserve_price,
    unique_bidders,
    commission_rate,
    buyer_premium_rate,
    status,
    end_time,
    title,
    auction_type
  INTO v_auction
  FROM auctions
  WHERE id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Auction not found',
      'error_code', 'AUCTION_NOT_FOUND'
    );
  END IF;

  IF v_auction.status IN ('ended', 'sold', 'cancelled') THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_ended', true,
      'auction_id', p_auction_id,
      'status', v_auction.status
    );
  END IF;

  IF v_auction.status != 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Auction is not active',
      'error_code', 'NOT_ACTIVE'
    );
  END IF;

  IF v_auction.auction_type != 'timed' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Only timed auctions can be auto-ended',
      'error_code', 'NOT_TIMED'
    );
  END IF;

  IF v_auction.end_time > NOW() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Auction has not ended yet',
      'error_code', 'NOT_ENDED'
    );
  END IF;

  v_reserve_met := (v_auction.reserve_price IS NULL) OR (v_auction.current_bid >= v_auction.reserve_price);
  v_has_minimum_bidders := (v_auction.unique_bidders IS NOT NULL AND v_auction.unique_bidders >= 2);

  IF v_auction.current_bid > 0 AND v_reserve_met AND v_has_minimum_bidders THEN
    v_new_status := 'sold';
    v_event_message := 'Auction sold! Winning bid: ' || v_auction.current_bid::text || ' Freti';
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

  -- Atomically finalize the auction with the live current_bid (already updated by the bid trigger)
  UPDATE auctions
  SET
    status = v_new_status,
    winning_bid = current_bid,
    updated_at = NOW()
  WHERE id = p_auction_id;

  -- Create sale and win records only when the auction is actually sold
  IF v_new_status = 'sold' AND v_auction.winner_id IS NOT NULL THEN
    -- Avoid duplicate sale records
    SELECT EXISTS (
      SELECT 1
      FROM auction_sales
      WHERE auction_id = p_auction_id
        AND buyer_id = v_auction.winner_id
    ) INTO v_exists;

    IF NOT v_exists THEN
      INSERT INTO auction_sales (
        auction_id,
        seller_id,
        buyer_id,
        final_bid_amount,
        commission_amount,
        buyer_premium_amount,
        total_amount,
        payment_status,
        created_at
      ) VALUES (
        p_auction_id,
        v_auction.seller_id,
        v_auction.winner_id,
        v_auction.current_bid,
        round(v_auction.current_bid * COALESCE(v_auction.commission_rate, 0.10), 6),
        round(v_auction.current_bid * COALESCE(v_auction.buyer_premium_rate, 0.00), 6),
        v_auction.current_bid,
        'pending',
        NOW()
      )
      RETURNING id INTO v_sale_id;
    END IF;

    -- Avoid duplicate win records (NULL item_id for timed auctions)
    SELECT EXISTS (
      SELECT 1
      FROM user_auction_wins
      WHERE user_id = v_auction.winner_id
        AND auction_id = p_auction_id
        AND item_id IS NULL
    ) INTO v_exists;

    IF NOT v_exists THEN
      INSERT INTO user_auction_wins (
        user_id,
        auction_id,
        item_id,
        winning_bid,
        status,
        expires_at,
        won_at,
        created_at,
        updated_at
      ) VALUES (
        v_auction.winner_id,
        p_auction_id,
        NULL,
        v_auction.current_bid,
        'pending_checkout',
        NOW() + INTERVAL '7 days',
        NOW(),
        NOW(),
        NOW()
      )
      RETURNING id INTO v_win_id;
    END IF;
  END IF;

  -- Log the auction end/sold event
  INSERT INTO auction_events (
    auction_id,
    event_type,
    event_data,
    timestamp,
    auctioneer_message,
    auctioneer_spoken
  ) VALUES (
    p_auction_id,
    CASE WHEN v_new_status = 'sold' THEN 'sold' ELSE 'auction_ended' END,
    jsonb_build_object(
      'final_bid', v_auction.current_bid,
      'winner_id', v_auction.winner_id,
      'reserve_met', v_new_status = 'sold'
    ),
    NOW(),
    v_event_message,
    false
  );

  RETURN jsonb_build_object(
    'success', true,
    'auction_id', p_auction_id,
    'new_status', v_new_status,
    'winning_bid', v_auction.current_bid,
    'winner_id', v_auction.winner_id,
    'seller_id', v_auction.seller_id,
    'message', v_event_message,
    'sale_id', v_sale_id,
    'win_id', v_win_id
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'error_code', 'INTERNAL_ERROR'
  );
END;
$$;

COMMIT;
