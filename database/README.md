# 🗄️ Fretiko Database Migrations

This folder contains SQL migration files for setting up your Supabase database.

## 📋 How to Run Migrations

### Method 1: Supabase Dashboard (Recommended for beginners)

1. **Open Supabase Dashboard**
   - Go to [supabase.com](https://supabase.com)
   - Sign in and open your Fretiko project

2. **Navigate to SQL Editor**
   - Click "SQL Editor" in the left sidebar
   - Click "New Query"

3. **Copy and Run Migration**
   - Open the migration file (e.g., `001_create_user_profiles.sql`)
   - Copy the entire contents
   - Paste into the SQL Editor
   - Click "Run" button

### Method 2: Supabase CLI (Advanced)

```bash
# Install Supabase CLI
npm install -g supabase

# Login to Supabase
supabase login

# Link your project
supabase link --project-ref YOUR_PROJECT_REF

# Run migrations
supabase db reset
```

## 📁 Migration Files

### `001_create_user_profiles.sql`
Creates the complete user profiles system:

**Tables Created:**
- `user_profiles` - Extended user information
- Automatic triggers for `updated_at`
- Row Level Security (RLS) policies

**Storage Created:**  
- `avatars` bucket for profile pictures
- Storage policies for secure file access

**Functions Created:**
- `handle_new_user()` - Auto-creates profile on signup
- `update_updated_at()` - Auto-updates timestamps

**Security Features:**
- ✅ Users can only edit their own profiles
- ✅ All users can view public profiles (for social features)  
- ✅ Secure avatar upload with user isolation
- ✅ Automatic profile creation on signup

## 🧪 Testing Your Migration

After running the migration, test it works:

1. **Check Tables Created:**
   ```sql
   SELECT * FROM user_profiles LIMIT 5;
   ```

2. **Check Storage Bucket:**
   ```sql
   SELECT * FROM storage.buckets WHERE name = 'avatars';
   ```

3. **Test Profile Creation:**
   - Sign up a new user in your app
   - Check if profile was auto-created:
   ```sql
   SELECT * FROM user_profiles ORDER BY created_at DESC LIMIT 1;
   ```

## 🔧 Rollback (if needed)

If something goes wrong, you can rollback:

```sql
-- Remove triggers
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP TRIGGER IF EXISTS user_profiles_updated_at ON user_profiles;

-- Remove functions  
DROP FUNCTION IF EXISTS handle_new_user();
DROP FUNCTION IF EXISTS update_updated_at();

-- Remove table
DROP TABLE IF EXISTS user_profiles;

-- Remove storage policies
DROP POLICY IF EXISTS "Avatar images are publicly accessible" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects; 
DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;

-- Remove bucket
DELETE FROM storage.buckets WHERE id = 'avatars';
```

## 📚 Next Steps

After running this migration:
1. ✅ Your database is ready for user profiles
2. ✅ Avatar storage is configured  
3. ✅ Security policies are in place
4. ✅ Ready to build the backend microservice

Continue with building the Users microservice in your NestJS backend!