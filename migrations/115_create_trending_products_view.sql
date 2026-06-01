-- Migration: Create trending_products view for product popularity
-- Date: 2026-05-31
-- Description: Aggregates product purchase activity from orders and order_items
--              to support "Trending Now" products on the frontend.

CREATE OR REPLACE VIEW trending_products AS
SELECT
  oi.product_id,
  COUNT(DISTINCT o.id) AS order_count,
  SUM(oi.quantity) AS total_quantity,
  SUM(
    CASE
      WHEN o.created_at >= NOW() - INTERVAL '1 day'
        THEN oi.quantity * 20
      WHEN o.created_at >= NOW() - INTERVAL '7 days'
        THEN oi.quantity * 10
      WHEN o.created_at >= NOW() - INTERVAL '30 days'
        THEN oi.quantity * 3
      WHEN o.created_at >= NOW() - INTERVAL '90 days'
        THEN oi.quantity * 1
      ELSE 0
    END
  ) AS trending_score
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE
  oi.product_id IS NOT NULL
  AND o.status IN ('paid', 'assigned', 'in_transit', 'delivered', 'completed')
  AND o.created_at >= NOW() - INTERVAL '90 days'
GROUP BY oi.product_id;

-- Helpful indexes for trending calculations
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at DESC);
