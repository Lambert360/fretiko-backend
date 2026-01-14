-- =====================================================
-- ATOMIC SERVICE SLOT BOOKING FUNCTION
-- Prevents race conditions in service slot booking
-- Industry standard: Atomic slot reservation with locking
-- =====================================================

CREATE OR REPLACE FUNCTION book_live_service_slot_atomic(
  p_service_id UUID,
  p_booking_date DATE,
  p_booking_time TIME
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_service_record RECORD;
  v_slot_found BOOLEAN := FALSE;
  v_slot_index INTEGER := -1;
  v_updated_slots JSONB;
BEGIN
  -- Lock the service record to prevent concurrent modifications
  SELECT * INTO v_service_record
  FROM live_stream_services
  WHERE id = p_service_id
  FOR UPDATE; -- Acquire row-level lock

  -- Check if service exists
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Service not found',
      'error_code', 'SERVICE_NOT_FOUND'
    );
  END IF;

  -- Check if available_slots is valid JSON
  IF v_service_record.available_slots IS NULL OR jsonb_typeof(v_service_record.available_slots) != 'array' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Service slots configuration invalid',
      'error_code', 'INVALID_SLOT_CONFIG'
    );
  END IF;

  -- Find the slot and check availability
  FOR i IN 0 .. jsonb_array_length(v_service_record.available_slots) - 1 LOOP
    DECLARE
      slot_data JSONB := v_service_record.available_slots->i;
    BEGIN
      -- Check if this slot matches the requested date/time and is available
      IF (slot_data->>'date')::DATE = p_booking_date
         AND (slot_data->>'time')::TIME = p_booking_time
         AND (slot_data->>'available')::BOOLEAN = TRUE THEN

        v_slot_found := TRUE;
        v_slot_index := i;

        -- Update the slot to mark as unavailable
        v_updated_slots := jsonb_set(
          v_service_record.available_slots,
          ARRAY[i::text, 'available'],
          'false'::jsonb,
          true
        );

        EXIT; -- Found the slot, exit loop
      END IF;
    END;
  END LOOP;

  -- If slot not found or not available
  IF NOT v_slot_found THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Requested time slot is not available',
      'error_code', 'SLOT_NOT_AVAILABLE'
    );
  END IF;

  -- Update the service record with the new slots
  UPDATE live_stream_services
  SET
    available_slots = v_updated_slots,
    updated_at = NOW()
  WHERE id = p_service_id;

  -- Check if update succeeded
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Failed to update service slots',
      'error_code', 'UPDATE_FAILED'
    );
  END IF;

  -- Return success
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Service slot booked successfully',
    'slot_index', v_slot_index,
    'booking_date', p_booking_date,
    'booking_time', p_booking_time
  );

END;
$$;

-- Add comment to function
COMMENT ON FUNCTION book_live_service_slot_atomic(UUID, DATE, TIME) IS
'Atomically books a service slot by checking availability and marking it unavailable in a single transaction. Prevents race conditions in concurrent bookings.';

-- =====================================================
-- FUNCTION TO GET AVAILABLE SERVICE SLOTS
-- =====================================================

CREATE OR REPLACE FUNCTION get_available_service_slots(
  p_service_id UUID
)
RETURNS TABLE (
  slot_date DATE,
  slot_time TIME,
  available BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (slot->>'date')::DATE as slot_date,
    (slot->>'time')::TIME as slot_time,
    (slot->>'available')::BOOLEAN as available
  FROM live_stream_services s,
       jsonb_array_elements(s.available_slots) as slot
  WHERE s.id = p_service_id
    AND (slot->>'available')::BOOLEAN = TRUE
  ORDER BY slot_date, slot_time;
END;
$$;

-- Add comment to function
COMMENT ON FUNCTION get_available_service_slots(UUID) IS
'Returns all available service slots for a given service.';
