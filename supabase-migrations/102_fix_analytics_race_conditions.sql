-- Migration: Fix race conditions in live stream analytics updates
-- Description: Add atomic update function for live_stream_analytics to prevent race conditions
-- Date: 2025-01-XX

-- ================================
-- ATOMIC ANALYTICS UPDATE FUNCTION
-- ================================

-- Note: If live_stream_analytics table doesn't have aggregated columns, we'll need to check the actual schema
-- This assumes a structure where metrics are stored per stream_id with timestamp buckets

-- Create function for atomic analytics updates
-- This uses PostgreSQL's row-level locking (FOR UPDATE) to prevent race conditions
-- ✅ PHASE 6 FIX: Updated to support batch counts for better performance
CREATE OR REPLACE FUNCTION update_live_stream_analytics_atomic(
  p_stream_id UUID,
  p_viewer_join BOOLEAN DEFAULT FALSE,
  p_viewer_join_count INTEGER DEFAULT 0,
  p_viewer_leave BOOLEAN DEFAULT FALSE,
  p_viewer_leave_count INTEGER DEFAULT 0,
  p_comment BOOLEAN DEFAULT FALSE,
  p_comment_count INTEGER DEFAULT 0,
  p_reaction BOOLEAN DEFAULT FALSE,
  p_reaction_count INTEGER DEFAULT 0,
  p_gift_amount DECIMAL DEFAULT 0,
  p_purchase_amount DECIMAL DEFAULT 0
) RETURNS JSONB AS $$
DECLARE
  v_current JSONB;
  v_viewer_count INTEGER := 0;
  v_peak_viewers INTEGER := 0;
  v_total_comments INTEGER := 0;
  v_total_reactions INTEGER := 0;
  v_total_gifts INTEGER := 0;
  v_total_gift_value DECIMAL := 0;
  v_total_sales DECIMAL := 0;
  v_engagement_score DECIMAL := 0;
  v_now TIMESTAMP WITH TIME ZONE := NOW();
  v_hour_bucket TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Create hour bucket for time-based aggregation (e.g., 2025-01-15 14:00:00)
  v_hour_bucket := date_trunc('hour', v_now);

  -- Get current stream metrics with row lock (prevents concurrent updates)
  SELECT 
    COALESCE(viewer_count, 0),
    COALESCE(peak_viewers, 0),
    COALESCE(total_comments, 0),
    COALESCE(total_reactions, 0),
    COALESCE(total_gifts, 0),
    COALESCE(total_gift_value, 0),
    COALESCE(total_sales, 0),
    COALESCE(engagement_score, 0)
  INTO
    v_viewer_count,
    v_peak_viewers,
    v_total_comments,
    v_total_reactions,
    v_total_gifts,
    v_total_gift_value,
    v_total_sales,
    v_engagement_score
  FROM live_streams
  WHERE id = p_stream_id
  FOR UPDATE; -- ✅ PHASE 6 FIX: Row-level locking prevents race conditions

  -- ✅ PHASE 6 FIX: Update metrics atomically with batch counts
  IF p_viewer_join_count > 0 THEN
    v_viewer_count := v_viewer_count + p_viewer_join_count;
    v_peak_viewers := GREATEST(v_peak_viewers, v_viewer_count);
  ELSIF p_viewer_join THEN
    v_viewer_count := v_viewer_count + 1;
    v_peak_viewers := GREATEST(v_peak_viewers, v_viewer_count);
  END IF;

  IF p_viewer_leave_count > 0 THEN
    v_viewer_count := GREATEST(0, v_viewer_count - p_viewer_leave_count);
  ELSIF p_viewer_leave THEN
    v_viewer_count := GREATEST(0, v_viewer_count - 1);
  END IF;

  IF p_comment_count > 0 THEN
    v_total_comments := v_total_comments + p_comment_count;
    v_engagement_score := v_engagement_score + p_comment_count;
  ELSIF p_comment THEN
    v_total_comments := v_total_comments + 1;
    v_engagement_score := v_engagement_score + 1;
  END IF;

  IF p_reaction_count > 0 THEN
    v_total_reactions := v_total_reactions + p_reaction_count;
    v_engagement_score := v_engagement_score + (p_reaction_count * 0.5);
  ELSIF p_reaction THEN
    v_total_reactions := v_total_reactions + 1;
    v_engagement_score := v_engagement_score + 0.5;
  END IF;

  IF p_gift_amount > 0 THEN
    v_total_gifts := v_total_gifts + 1;
    v_total_gift_value := v_total_gift_value + p_gift_amount;
    v_engagement_score := v_engagement_score + 5;
  END IF;

  IF p_purchase_amount > 0 THEN
    v_total_sales := v_total_sales + p_purchase_amount;
    v_engagement_score := v_engagement_score + 10;
  END IF;

  -- Update live_streams table atomically
  UPDATE live_streams
  SET
    viewer_count = v_viewer_count,
    total_viewers = GREATEST(total_viewers, v_viewer_count),
    peak_viewers = v_peak_viewers,
    total_comments = v_total_comments,
    total_reactions = v_total_reactions,
    total_gifts = v_total_gifts,
    total_gift_value = v_total_gift_value,
    total_sales = v_total_sales,
    engagement_score = v_engagement_score,
    updated_at = v_now
  WHERE id = p_stream_id;

  -- Insert analytics event into live_stream_analytics table
  -- (This maintains historical record while aggregated data is in live_streams)
  INSERT INTO live_stream_analytics (
    stream_id,
    metric_type,
    metric_value,
    metadata,
    created_at
  ) VALUES (
    p_stream_id,
    CASE
      WHEN p_viewer_join THEN 'viewer_join'
      WHEN p_viewer_leave THEN 'viewer_leave'
      WHEN p_comment THEN 'comment'
      WHEN p_reaction THEN 'reaction'
      WHEN p_gift_amount > 0 THEN 'gift'
      WHEN p_purchase_amount > 0 THEN 'purchase'
      ELSE 'unknown'
    END,
    CASE
      WHEN p_viewer_join OR p_viewer_leave THEN v_viewer_count
      WHEN p_comment THEN v_total_comments
      WHEN p_reaction THEN v_total_reactions
      WHEN p_gift_amount > 0 THEN v_total_gifts
      WHEN p_purchase_amount > 0 THEN 1
      ELSE 1
    END,
    jsonb_build_object(
      'gift_amount', p_gift_amount,
      'purchase_amount', p_purchase_amount,
      'current_viewer_count', v_viewer_count
    ),
    v_now
  );

  -- Return updated metrics
  RETURN jsonb_build_object(
    'viewer_count', v_viewer_count,
    'peak_viewers', v_peak_viewers,
    'total_comments', v_total_comments,
    'total_reactions', v_total_reactions,
    'total_gifts', v_total_gifts,
    'total_gift_value', v_total_gift_value,
    'total_sales', v_total_sales,
    'engagement_score', v_engagement_score
  );
END;
$$ LANGUAGE plpgsql;

-- ================================
-- COMMENTS
-- ================================

COMMENT ON FUNCTION update_live_stream_analytics_atomic IS 'Atomically updates live stream analytics to prevent race conditions using row-level locking';

