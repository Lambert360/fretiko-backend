-- Create video processing queue table
CREATE TABLE IF NOT EXISTS video_processing_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    original_file_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    
    -- Processing status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'retrying')),
    progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    current_stage TEXT,
    
    -- Processing options
    quality TEXT DEFAULT 'medium' CHECK (quality IN ('low', 'medium', 'high')),
    platform TEXT DEFAULT 'android' CHECK (platform IN ('android', 'ios', 'web')),
    generate_thumbnail BOOLEAN DEFAULT true,
    generate_hls BOOLEAN DEFAULT false,
    max_duration INTEGER,
    
    -- Retry logic
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_retry_at TIMESTAMP WITH TIME ZONE,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    
    -- Processing metadata
    original_codec TEXT,
    original_resolution TEXT,
    original_bitrate BIGINT,
    original_duration FLOAT,
    
    -- Output URLs
    processed_url TEXT,
    thumbnail_url TEXT,
    hls_master_playlist_url TEXT,
    hls_variants JSONB,
    
    -- Error handling
    error_message TEXT,
    error_details JSONB,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_status ON video_processing_queue(status);
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_user_id ON video_processing_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_next_retry ON video_processing_queue(next_retry_at) WHERE next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_created_at ON video_processing_queue(created_at DESC);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_video_processing_queue_updated_at 
    BEFORE UPDATE ON video_processing_queue 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add RLS policies
ALTER TABLE video_processing_queue ENABLE ROW LEVEL SECURITY;

-- Users can only see their own video processing jobs
CREATE POLICY "Users can view own video processing jobs" ON video_processing_queue
    FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own video processing jobs
CREATE POLICY "Users can insert own video processing jobs" ON video_processing_queue
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own video processing jobs
CREATE POLICY "Users can update own video processing jobs" ON video_processing_queue
    FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own video processing jobs
CREATE POLICY "Users can delete own video processing jobs" ON video_processing_queue
    FOR DELETE USING (auth.uid() = user_id);

-- Create function for exponential backoff retry calculation
CREATE OR REPLACE FUNCTION calculate_next_retry(retry_count INTEGER)
RETURNS TIMESTAMP WITH TIME ZONE AS $$
BEGIN
    -- Exponential backoff: 5min, 15min, 45min, 2h, 6h, 18h, 54h
    CASE retry_count
        WHEN 0 THEN NOW() + INTERVAL '5 minutes'
        WHEN 1 THEN NOW() + INTERVAL '15 minutes'
        WHEN 2 THEN NOW() + INTERVAL '45 minutes'
        ELSE NOW() + INTERVAL '2 hours'
    END;
END;
$$ LANGUAGE plpgsql;

-- Create function to get next job for processing
CREATE OR REPLACE FUNCTION get_next_video_processing_job()
RETURNS TABLE (
    id UUID,
    user_id UUID,
    original_file_path TEXT,
    original_filename TEXT,
    quality TEXT,
    platform TEXT,
    generate_thumbnail BOOLEAN,
    generate_hls BOOLEAN,
    max_duration INTEGER
) AS $$
BEGIN
    -- Try to get a pending job first
    RETURN QUERY
    UPDATE video_processing_queue
    SET status = 'processing',
        started_at = NOW(),
        updated_at = NOW()
    WHERE id = (
        SELECT id FROM video_processing_queue
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id, original_file_path, original_filename, quality, platform, generate_thumbnail, generate_hls, max_duration;
    
    -- If no pending jobs, try failed jobs that need retry
    IF NOT FOUND THEN
        RETURN QUERY
        UPDATE video_processing_queue
        SET status = 'retrying',
            retry_count = retry_count + 1,
            last_retry_at = NOW(),
            next_retry_at = calculate_next_retry(retry_count + 1),
            started_at = NOW(),
            updated_at = NOW(),
            error_message = NULL,
            error_details = NULL
        WHERE id = (
            SELECT id FROM video_processing_queue
            WHERE status = 'failed'
                AND retry_count < max_retries
                AND (next_retry_at IS NULL OR next_retry_at <= NOW())
            ORDER BY last_retry_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, user_id, original_file_path, original_filename, quality, platform, generate_thumbnail, generate_hls, max_duration;
    END IF;
    
    RETURN;
END;
$$ LANGUAGE plpgsql;

-- Create function to mark job as completed
CREATE OR REPLACE FUNCTION complete_video_processing_job(
    job_id UUID,
    processed_url TEXT DEFAULT NULL,
    thumbnail_url TEXT DEFAULT NULL,
    hls_master_playlist_url TEXT DEFAULT NULL,
    hls_variants JSONB DEFAULT NULL,
    processed_codec TEXT DEFAULT NULL,
    processed_resolution TEXT DEFAULT NULL,
    processed_bitrate BIGINT DEFAULT NULL,
    processed_duration FLOAT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE video_processing_queue
    SET status = 'completed',
        progress = 100,
        current_stage = 'completed',
        processed_url = processed_url,
        thumbnail_url = thumbnail_url,
        hls_master_playlist_url = hls_master_playlist_url,
        hls_variants = hls_variants,
        -- Update processing metadata
        original_codec = COALESCE(processed_codec, original_codec),
        original_resolution = COALESCE(processed_resolution, original_resolution),
        original_bitrate = COALESCE(processed_bitrate, original_bitrate),
        original_duration = COALESCE(processed_duration, original_duration),
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = job_id;
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Create function to mark job as failed
CREATE OR REPLACE FUNCTION fail_video_processing_job(
    job_id UUID,
    error_message TEXT,
    error_details JSONB DEFAULT NULL,
    current_stage TEXT DEFAULT NULL,
    progress INTEGER DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE video_processing_queue
    SET status = CASE 
        WHEN retry_count >= max_retries THEN 'failed'
        ELSE 'failed' -- Will be retried by get_next_video_processing_job
    END,
        error_message = error_message,
        error_details = error_details,
        current_stage = COALESCE(current_stage, current_stage),
        progress = COALESCE(progress, progress),
        updated_at = NOW()
    WHERE id = job_id;
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Create function to update job progress
CREATE OR REPLACE FUNCTION update_video_processing_progress(
    job_id UUID,
    progress INTEGER,
    current_stage TEXT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE video_processing_queue
    SET progress = GREATEST(LEAST(progress, 100), 0),
        current_stage = COALESCE(current_stage, current_stage),
        updated_at = NOW()
    WHERE id = job_id;
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;
