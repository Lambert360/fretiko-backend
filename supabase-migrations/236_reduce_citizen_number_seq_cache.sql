BEGIN;

-- =====================================================
-- MIGRATION: 236
-- Drop the citizen_number_seq cache to 1.
--
-- CACHE 1000 caused each pooled DB connection to grab a 1000-number block and
-- discard the unused remainder on release — bulk signups (and connection
-- churn in general) burned thousands of numbers as gaps. At real signup
-- volumes nextval() is cheap uncached; density beats throughput here.
-- =====================================================

ALTER SEQUENCE citizen_number_seq CACHE 1;

COMMIT;
