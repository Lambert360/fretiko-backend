-- =====================================================
-- ADD ORDER_ID TO LIVE STREAM TRANSACTIONS
-- Links live stream transactions to order records for escrow tracking
-- =====================================================

-- Add order_id column to link transactions to orders
ALTER TABLE public.live_stream_transactions
ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_live_transactions_order
ON public.live_stream_transactions(order_id);

-- Add index for transaction status queries
CREATE INDEX IF NOT EXISTS idx_live_transactions_status
ON public.live_stream_transactions(status);

-- Add index for buyer transactions
CREATE INDEX IF NOT EXISTS idx_live_transactions_buyer
ON public.live_stream_transactions(buyer_id, created_at DESC);

-- Add comment
COMMENT ON COLUMN public.live_stream_transactions.order_id IS 'References the order record for escrow-protected purchases';

-- =====================================================
-- UPDATE EXISTING RECORDS (Optional)
-- =====================================================

-- NOTE: Existing live_stream_transactions will have NULL order_id
-- This is expected - only new purchases after escrow implementation will have order_id
-- Old transactions (pre-escrow) can remain NULL as they were instant payments

-- If you want to retroactively create orders for completed transactions:
-- (This is optional and should be done carefully with proper testing)

/*
DO $$
DECLARE
  trans RECORD;
  new_order_id UUID;
BEGIN
  -- Loop through completed transactions without order_id
  FOR trans IN
    SELECT * FROM live_stream_transactions
    WHERE status = 'completed'
    AND order_id IS NULL
    AND transaction_type = 'product'
    LIMIT 100 -- Process in batches
  LOOP
    -- Create order for historical transaction
    INSERT INTO orders (
      order_number,
      buyer_id,
      vendor_id,
      total_amount,
      delivery_fee,
      platform_fee,
      status,
      escrow_enabled,
      source,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      CONCAT('LIVE-RETRO-', trans.id),
      trans.buyer_id,
      (SELECT vendor_id FROM live_streams WHERE id = trans.stream_id),
      trans.total_amount,
      trans.delivery_fee,
      trans.platform_fee,
      'completed', -- Already completed
      false, -- Not escrow-enabled (legacy)
      'live_stream',
      jsonb_build_object(
        'stream_id', trans.stream_id,
        'transaction_id', trans.id,
        'legacy', true,
        'retroactive', true
      ),
      trans.created_at,
      NOW()
    )
    RETURNING id INTO new_order_id;

    -- Link transaction to order
    UPDATE live_stream_transactions
    SET order_id = new_order_id
    WHERE id = trans.id;
    
    -- Create order item
    INSERT INTO order_items (
      order_id,
      product_id,
      product_name,
      unit_price,
      quantity,
      total_price,
      product_metadata
    )
    SELECT
      new_order_id,
      trans.product_id,
      p.name,
      trans.unit_price,
      trans.quantity,
      trans.subtotal,
      jsonb_build_object('legacy', true)
    FROM products p
    WHERE p.id = trans.product_id;

    RAISE NOTICE 'Created order % for transaction %', new_order_id, trans.id;
  END LOOP;
END $$;
*/

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Check how many transactions have order_id
SELECT
  COUNT(*) as total_transactions,
  COUNT(order_id) as with_order_id,
  COUNT(*) - COUNT(order_id) as without_order_id
FROM live_stream_transactions;

-- Check recent live stream orders
SELECT
  o.order_number,
  o.total_amount,
  o.status,
  o.escrow_enabled,
  lst.id as transaction_id,
  lst.stream_id
FROM orders o
JOIN live_stream_transactions lst ON o.id = lst.order_id
WHERE o.source = 'live_stream'
ORDER BY o.created_at DESC
LIMIT 10;

