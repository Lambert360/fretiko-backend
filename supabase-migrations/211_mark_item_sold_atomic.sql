BEGIN;

-- =====================================================
-- MIGRATION: 211
-- Create mark_item_sold_atomic(p_auction_id, p_item_id, p_seller_id)
--
-- Why:
--   Live item settlement is currently done in JS with separate read-then-update
--   calls. Two concurrent gavel clicks, or a bid sneaking in between reads, can
--   create duplicate auction_sales / user_auction_wins or overwrite a newer
--   winning bid. This function does the entire live item close in one Postgres
--   transaction.
--
-- What it does:
--   1. Locks the auction row and the auction_items row.
--   2. Verifies the seller, the item belongs to the auction, and the item is
--      in 'ended' state with a valid winning bid that meets reserve.
--   3. Sets the item to 'sold'.
--   4. Inserts user_auction_wins and auction_sales idempotently.
--   5. Picks the next waiting item and updates auctions.current_item_id.
--   6. Returns winner/next-item JSON.
-- =====================================================

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
  v_exists BOOLEAN;
  v_win_id UUID;
  v_sale_id UUID;
  v_winning_bid DECIMAL(18,6);
  v_commission_rate DECIMAL(5,4);
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

  IF v_item.reserve_price IS NOT NULL AND v_item.winning_bid < v_item.reserve_price THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reserve price not met');
  END IF;

  v_winning_bid := v_item.winning_bid;
  v_commission_rate := COALESCE(v_auction.commission_rate, 0.10);

  -- Mark the item as sold
  UPDATE auction_items
  SET bidding_status = 'sold'
  WHERE id = p_item_id;

  -- Create the win idempotently (partial unique index on user_id, auction_id, item_id where item_id IS NOT NULL)
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
  )
  VALUES (
    v_item.winner_id,
    p_auction_id,
    p_item_id,
    v_winning_bid,
    'pending_checkout',
    NOW() + INTERVAL '7 days',
    NOW(),
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id, auction_id, item_id) WHERE item_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_win_id;

  -- Create the sale idempotently (same item cannot be sold twice because the item row is locked)
  SELECT EXISTS (
    SELECT 1 FROM auction_sales
    WHERE auction_id = p_auction_id
      AND item_id = p_item_id
      AND buyer_id = v_item.winner_id
  ) INTO v_exists;

  IF NOT v_exists THEN
    INSERT INTO auction_sales (
      auction_id,
      seller_id,
      buyer_id,
      item_id,
      final_bid_amount,
      commission_amount,
      buyer_premium_amount,
      total_amount,
      payment_status,
      created_at
    )
    VALUES (
      p_auction_id,
      v_auction.seller_id,
      v_item.winner_id,
      p_item_id,
      v_winning_bid,
      round(v_winning_bid * v_commission_rate, 6),
      0,
      v_winning_bid,
      'pending',
      NOW()
    )
    RETURNING id INTO v_sale_id;
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
    UPDATE auctions
    SET current_item_id = v_next_item.id
    WHERE id = p_auction_id;
  ELSE
    UPDATE auctions
    SET current_item_id = NULL
    WHERE id = p_auction_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'auction_id', p_auction_id,
    'item_id', p_item_id,
    'winner_id', v_item.winner_id,
    'winning_bid', v_winning_bid,
    'win_id', v_win_id,
    'sale_id', v_sale_id,
    'next_item_id', v_next_item.id,
    'next_item_title', v_next_item.title,
    'next_item_starting_price', v_next_item.starting_price,
    'next_item_bid_increment', v_next_item.bid_increment,
    'next_item_images', v_next_item.images,
    'commission_rate', v_commission_rate
  );
END;
$$;

COMMIT;
