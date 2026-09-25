-- Extend service_bookings.status CHECK to include 'pending_confirmation'
-- (vendor marked service complete, awaiting buyer confirmation — matches
--  the workspace completeServiceBooking flow).
-- Existing constraint from migration 011 allows:
--   pending, confirmed, in_progress, completed, cancelled, rejected

DO $$
DECLARE
  conname TEXT;
BEGIN
  -- Find the CHECK constraint on service_bookings.status
  SELECT con.conname INTO conname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
  WHERE rel.relname = 'service_bookings'
    AND att.attname = 'status'
    AND con.contype = 'c'
  LIMIT 1;

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE service_bookings DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE service_bookings
  ADD CONSTRAINT service_bookings_status_check
  CHECK (status IN (
    'pending',
    'confirmed',
    'in_progress',
    'pending_confirmation',
    'completed',
    'cancelled',
    'rejected'
  ));
