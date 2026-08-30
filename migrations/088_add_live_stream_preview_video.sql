-- Migration: Add optional preview video URL to live streams
-- Date: 2025-08-24
-- Description: Vendors can upload a short video snippet that is used instead of a static thumbnail on the live discovery feed.

BEGIN;

ALTER TABLE live_streams
    ADD COLUMN IF NOT EXISTS preview_video_url TEXT;

CREATE OR REPLACE VIEW live_stream_stats AS
SELECT 
    ls.id,
    ls.vendor_id,
    ls.title,
    ls.description,
    ls.stream_type,
    ls.status,
    ls.viewer_count,
    ls.total_viewers,
    ls.total_sales,
    COUNT(DISTINCT lsv.user_id) FILTER (WHERE lsv.left_at IS NULL) as current_viewers,
    COUNT(DISTINCT lsc.id) FILTER (WHERE lsc.is_deleted = false) as total_comments,
    COUNT(DISTINCT lsr.id) as total_reactions,
    COUNT(DISTINCT lsg.id) as total_gifts,
    COALESCE(SUM(lsg.total_amount), 0) as total_gift_value,
    COUNT(DISTINCT lst.id) as total_transactions,
    ls.thumbnail_url,
    ls.stream_url,
    ls.created_at,
    ls.started_at,
    ls.ended_at,
    ls.preview_video_url
FROM live_streams ls
LEFT JOIN live_stream_viewers lsv ON ls.id = lsv.stream_id
LEFT JOIN live_stream_comments lsc ON ls.id = lsc.stream_id
LEFT JOIN live_stream_reactions lsr ON ls.id = lsr.stream_id
LEFT JOIN live_stream_gifts lsg ON ls.id = lsg.stream_id
LEFT JOIN live_stream_transactions lst ON ls.id = lst.stream_id
GROUP BY ls.id, ls.vendor_id, ls.title, ls.description, ls.stream_type, ls.status, 
         ls.viewer_count, ls.total_viewers, ls.total_sales, ls.thumbnail_url, 
         ls.stream_url, ls.created_at, ls.started_at, ls.ended_at, ls.preview_video_url;

COMMIT;
