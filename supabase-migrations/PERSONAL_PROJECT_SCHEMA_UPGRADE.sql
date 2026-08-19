-- Run this ONCE in your personal Supabase project's SQL Editor
-- (jrgvrjtvvwilracbbhme). It upgrades the older test schema to match
-- what the current backend code expects, WITHOUT touching your
-- existing 118 posts or the "users" table.

-- 1. Create user_profiles table (used by current Posts/Image-Feeds code)
CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID PRIMARY KEY,
    username VARCHAR(50) UNIQUE,
    bio TEXT,
    avatar_url TEXT,
    location VARCHAR(100),
    is_seller BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view all profiles" ON public.user_profiles;
CREATE POLICY "Users can view all profiles" ON public.user_profiles
    FOR SELECT USING (true);

-- 2. Copy existing bot users from the old "users" table into user_profiles
--    so old and new code refer to the same identities.
INSERT INTO public.user_profiles (id, username, bio, avatar_url)
SELECT id, username, bio, avatar_url FROM public.users
ON CONFLICT (id) DO NOTHING;

-- 3. Add the columns current Posts module expects to the existing posts table
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS media_urls TEXT[] DEFAULT '{}';
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS media_type VARCHAR(20) DEFAULT 'text';
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS privacy_level VARCHAR(20) DEFAULT 'public';
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS gifts_count INTEGER DEFAULT 0;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

-- 4. Create post_media table (stores individual image/video records per post)
CREATE TABLE IF NOT EXISTS public.post_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
    media_url TEXT NOT NULL,
    thumbnail_url TEXT,
    file_size BIGINT,
    duration INTEGER,
    width INTEGER,
    height INTEGER,
    mime_type VARCHAR(50),
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Create post_interactions table (likes/comments/shares/gifts)
CREATE TABLE IF NOT EXISTS public.post_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    interaction_type VARCHAR(20) NOT NULL CHECK (interaction_type IN ('like', 'comment', 'share', 'gift')),
    content TEXT,
    parent_comment_id UUID REFERENCES public.post_interactions(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(post_id, user_id, interaction_type)
);

-- Done. After running this, the current backend code (posts module,
-- image-feeds module) will work correctly against this project.
