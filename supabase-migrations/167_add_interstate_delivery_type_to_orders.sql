-- Migration: allow 'interstate_delivery' as a valid orders.delivery_type value
-- The checkout service uses 'interstate_delivery' for out-of-state and out-of-country orders.
-- The existing check constraint only allowed 'pickup' and 'delivery'.

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_delivery_type_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_delivery_type_check
  CHECK (delivery_type IN ('pickup', 'delivery', 'interstate_delivery'));
