# 🚀 Supabase Migration Instructions

## **Required Steps to Enable New Authentication System**

The migration script can't run automatically because Supabase doesn't allow arbitrary SQL execution via API. You need to run the migrations manually.

---

## **Step 1: Go to Supabase Dashboard**

1. Open https://supabase.com/dashboard
2. Select your project: `piytfaopdlxltdczdvtk`
3. Go to **SQL Editor** in the left sidebar

---

## **Step 2: Run Migration 1 - Refresh Tokens**

1. Copy the entire content of `migrations/004_create_refresh_tokens.sql`
2. Paste it into the SQL Editor
3. Click **"Run"** or **"Execute"**
4. Wait for success message

**Expected Output:**
```
✅ Table created successfully
✅ Indexes created successfully  
✅ RLS policies created successfully
✅ Functions created successfully
```

---

## **Step 3: Run Migration 2 - User Activity Log**

1. Copy the entire content of `migrations/005_create_user_activity_log.sql`
2. Paste it into the SQL Editor (replace previous content)
3. Click **"Run"** or **"Execute"**
4. Wait for success message

**Expected Output:**
```
✅ Table created successfully
✅ Indexes created successfully
✅ RLS policies created successfully
✅ Functions created successfully
```

---

## **Step 4: Verify Migration Success**

Run this simple test query to verify everything works:

```sql
-- Test if tables exist
SELECT 
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'refresh_tokens') as refresh_tokens_exists,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'user_activity_log') as user_activity_log_exists;

-- Test if functions exist
SELECT 
  proname as function_name
FROM pg_proc 
WHERE proname IN ('log_user_activity', 'is_user_inactive', 'cleanup_expired_refresh_tokens', 'cleanup_old_activity_logs');
```

**Expected Result:**
- `refresh_tokens_exists = 1`
- `user_activity_log_exists = 1`
- Should see 4 function names listed

---

## **Step 5: Deploy Backend**

Once migrations are complete:

1. **Deploy backend to Render** (if not already deployed)
2. **Test authentication endpoints**:
   - `POST /auth/signin` - should return refresh token
   - `POST /auth/refresh` - should refresh access token
   - `POST /auth/logout` - should revoke refresh token

---

## **🎯 What This Enables**

After migration completion:

✅ **7-day access tokens** (no more 30-minute forced logout)  
✅ **30-day refresh tokens** (persistent sessions)  
✅ **Activity tracking** (security monitoring)  
✅ **Device management** (multiple device support)  
✅ **Automatic token refresh** (seamless user experience)  

---

## **⚠️ Important Notes**

- **Existing users will need to re-login** once (clean break approach)
- **All user data remains intact** - only authentication changes
- **Mobile app must be updated** to use new token system
- **Backward compatibility not needed** as requested

---

## **🔍 Troubleshooting**

**If migrations fail:**
- Check you have **Service Role** key permissions
- Ensure you're in the correct project
- Try running each SQL statement separately

**If functions don't appear:**
- Wait 30 seconds for Supabase to update schema cache
- Refresh the SQL Editor page
- Check for syntax errors in the SQL

---

## **✅ Migration Complete Checklist**

- [ ] Refresh tokens table created
- [ ] User activity log table created  
- [ ] All database functions created
- [ ] RLS policies enabled
- [ ] Backend deployed with new authentication
- [ ] Mobile app updated
- [ ] Test login flow works

Once all items are checked, your modern authentication system is live! 🚀
