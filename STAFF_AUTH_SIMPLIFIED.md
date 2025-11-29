# Staff Authentication - Simplified Flow

## Overview
The staff authentication system has been simplified to use `signInWithPassword` for existing Supabase Auth users, avoiding the broken Admin API (`listUsers`, `createUser`, `updateUserById`).

## Changes Made

### Login Flow (`StaffService.login()`)

**Before:**
- Complex flow with multiple fallbacks
- Attempted to create/update Supabase Auth users using Admin API
- Searched through paginated user lists
- Multiple retry mechanisms

**After:**
1. **Find staff account** in `staff_accounts` table
2. **Try `signInWithPassword`** with Supabase Auth
3. **If successful:**
   - Sync password in `staff_accounts` if needed
   - Update last login timestamp
   - Return Supabase JWT tokens
4. **If failed:**
   - Verify password against `staff_accounts` (source of truth)
   - If password invalid → throw "Invalid credentials"
   - If password valid but sign-in failed → throw helpful error message indicating Supabase Auth user doesn't exist

### Key Benefits

✅ **Simpler code** - Removed ~300 lines of complex fallback logic  
✅ **Faster login** - No paginated user searches  
✅ **Clear error messages** - Users know exactly what's wrong  
✅ **Works for existing users** - If Supabase Auth user exists, login works immediately  

### Limitations

⚠️ **New staff accounts** - The `createStaff()` method still uses `auth.admin.createUser()` which will fail until Admin API is fixed  
⚠️ **Missing Supabase Auth users** - If a staff account exists in `staff_accounts` but not in Supabase Auth, login will fail with a helpful error  

## Current Status

### ✅ Working
- Login for existing Supabase Auth users
- Password synchronization (if changed in Supabase Auth)
- JWT token generation (from Supabase)
- Token validation in `StaffJwtAuthGuard`

### ❌ Not Working
- Creating new staff accounts (requires Admin API)
- Auto-creating Supabase Auth users on first login (requires Admin API)
- Updating Supabase Auth passwords programmatically (requires Admin API)

## Workarounds

### For New Staff Accounts
Until Admin API is fixed, create Supabase Auth users manually:

1. **Via Supabase Dashboard:**
   - Go to Authentication → Users
   - Click "Add User"
   - Enter email and password
   - Copy the user ID

2. **Update `staff_accounts` table:**
   - Set `id` to match the Supabase Auth user ID
   - This ensures RLS policies work correctly

### For Existing Staff Without Supabase Auth Users
If a staff account exists in `staff_accounts` but login fails:

1. Create the Supabase Auth user manually (see above)
2. Ensure the `staff_accounts.id` matches the Supabase Auth user ID
3. Set the password in Supabase Auth to match `staff_accounts.password_hash` (or use a known password)

## Next Steps

1. **Fix Supabase Admin API** (recommended)
   - Check Supabase Dashboard → Logs
   - Verify service role key permissions
   - Contact Supabase support if needed

2. **Alternative: Manual User Creation**
   - Create a script to help admins create Supabase Auth users
   - Provide clear instructions in admin panel

3. **Alternative: Workaround Token Generation**
   - Generate Supabase-compatible JWT tokens manually
   - Only if Admin API cannot be fixed

## Testing

To test the simplified login:

```bash
# Test with existing Supabase Auth user
curl -X POST http://localhost:3000/api/staff/login \
  -H "Content-Type: application/json" \
  -d '{
    "staffIdOrEmail": "admin@fretiko.com",
    "password": "your-password"
  }'
```

Expected responses:
- ✅ **200 OK**: Login successful, returns JWT tokens
- ❌ **401 Unauthorized**: Invalid credentials OR Supabase Auth user doesn't exist

## Error Messages

### "Invalid credentials"
- Password is incorrect in `staff_accounts` table
- Staff account not found or inactive

### "Your account exists but is not set up in the authentication system"
- Password is correct in `staff_accounts`
- But Supabase Auth user doesn't exist
- **Solution**: Create Supabase Auth user manually (see workarounds above)

