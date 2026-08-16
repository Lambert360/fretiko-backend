-- Enable pgvector extension for vector similarity search
create extension if not exists vector;

-- Add embedding columns to products table
alter table products add column if not exists embedding vector(384);
alter table products add column if not exists embedding_text text;
alter table products add column if not exists embedding_updated_at timestamptz;

-- Add embedding columns to user_profiles (for vendor search)
alter table user_profiles add column if not exists embedding vector(384);
alter table user_profiles add column if not exists embedding_text text;
alter table user_profiles add column if not exists embedding_updated_at timestamptz;

-- Create IVFFlat indexes for fast similarity search
-- products: 100 lists is good for up to ~100k rows. Adjust if catalog grows.
create index if not exists products_embedding_idx
  on products using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- user_profiles: fewer lists since vendor count is smaller
create index if not exists user_profiles_embedding_idx
  on user_profiles using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);

-- Helper index to quickly find products that need embedding
create index if not exists products_needs_embedding_idx
  on products (id)
  where embedding is null and deleted_at is null and status = 'active';

-- Helper index to quickly find vendors that need embedding
create index if not exists user_profiles_needs_embedding_idx
  on user_profiles (id)
  where embedding is null and is_seller = true;

-- Function to build searchable text for a product
-- This is the text that gets embedded — combine name, description, category, tags, price
create or replace function build_product_embedding_text(p products) returns text as $$
  select coalesce(p.name, '') ||
         ' | ' || coalesce(p.description, '') ||
         ' | ' || coalesce(p.condition, '') ||
         ' | ' || coalesce(array_to_string(p.tags, ', '), '') ||
         ' | Price: ' || coalesce(p.price::text, '0') || ' NGN';
$$ language sql immutable;

-- Function to build searchable text for a vendor (user_profiles row)
create or replace function build_vendor_embedding_text(u user_profiles) returns text as $$
  select coalesce(u.username, '') ||
         ' | ' || coalesce(u.bio, '') ||
         ' | ' || coalesce(u.location, '') ||
         ' | Verified: ' || coalesce(u.is_verified::text, 'false');
$$ language sql immutable;

-- RPC function for product similarity search
-- Called via supabase.rpc('match_products', { query_embedding, match_threshold, match_count, ... })
create or replace function match_products(
  query_embedding vector(384),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_category uuid default null,
  filter_min_price float default null,
  filter_max_price float default null
)
returns table (
  id uuid,
  similarity float,
  name text,
  description text,
  price numeric,
  condition text,
  category_id uuid,
  images text[],
  primary_image_url text,
  tags text[],
  location text,
  status text,
  user_id uuid,
  average_rating float,
  review_count int,
  view_count int,
  like_count int,
  username text,
  avatar_url text,
  is_verified boolean
)
language sql stable
as $$
  select
    p.id,
    1 - (p.embedding <=> query_embedding) as similarity,
    p.name,
    p.description,
    p.price,
    p.condition,
    p.category_id,
    p.images,
    p.primary_image_url,
    p.tags,
    p.location,
    p.status,
    p.user_id,
    p.average_rating,
    p.review_count,
    p.view_count,
    p.like_count,
    u.username,
    u.avatar_url,
    u.is_verified
  from products p
  left join user_profiles u on u.id = p.user_id
  where p.embedding is not null
    and p.status = 'active'
    and p.deleted_at is null
    and (1 - (p.embedding <=> query_embedding)) > match_threshold
    and (filter_category is null or p.category_id = filter_category)
    and (filter_min_price is null or p.price >= filter_min_price)
    and (filter_max_price is null or p.price <= filter_max_price)
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

-- RPC function for vendor similarity search
create or replace function match_vendors(
  query_embedding vector(384),
  match_threshold float default 0.4,
  match_count int default 10,
  filter_verified boolean default null
)
returns table (
  id uuid,
  similarity float,
  username text,
  bio text,
  location text,
  is_verified boolean,
  avatar_url text,
  is_seller boolean
)
language sql stable
as $$
  select
    u.id,
    1 - (u.embedding <=> query_embedding) as similarity,
    u.username,
    u.bio,
    u.location,
    u.is_verified,
    u.avatar_url,
    u.is_seller
  from user_profiles u
  where u.embedding is not null
    and u.is_seller = true
    and (1 - (u.embedding <=> query_embedding)) > match_threshold
    and (filter_verified is null or u.is_verified = filter_verified)
  order by u.embedding <=> query_embedding
  limit match_count;
$$;
