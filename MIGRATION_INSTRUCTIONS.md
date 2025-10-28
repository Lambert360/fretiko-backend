# 🗄️ Database Migration Instructions

## ✅ **Option 1: Run Master Migration File (RECOMMENDED)**

### **Single Consolidated File:**
📄 `supabase-migrations/MASTER_ESCROW_SYSTEM_MIGRATION.sql`

This file contains **ALL 5 migrations** in the correct order with proper dependencies.

### **Steps to Run:**

1. **Open Supabase Dashboard**
   - Go to https://supabase.com/dashboard
   - Select your project
   - Navigate to **SQL Editor**

2. **Load Migration File**
   - Click **"New query"**
   - Copy contents of `MASTER_ESCROW_SYSTEM_MIGRATION.sql`
   - Paste into SQL editor

3. **Execute Migration**
   - Click **"Run"** button
   - Wait for completion (should take 2-5 seconds)

4. **Verify Success**
   - Run verification queries (included at bottom of file)
   - Check for any error messages
   - All queries should return results

### **Expected Output:**
```
✅ service_bookings.order_id column added
✅ Escrow RLS policies created (3 policies)
✅ disputes table created
✅ dispute_messages table created
✅ Dispute RLS policies created (5 policies)
✅ Indexes created (9 indexes)
✅ Triggers created (1 trigger)
```

---

## ⚙️ **Option 2: Run Individual Migration Files**

If you prefer to run migrations separately (not recommended unless debugging):

### **Order of Execution:**

1. `add-service-bookings-order-id.sql` ← Service bookings integration
2. `add-escrow-rls-policies.sql` ← Escrow security
3. `add-disputes-table.sql` ← Dispute system
4. `add-dispute-messages-table.sql` ← Dispute communications
5. `add-dispute-rls-policies.sql` ← Dispute security

**⚠️ Important:** Must run in this exact order due to dependencies!

---

## 🔍 **Verification Steps**

After running the migration, verify everything is set up correctly:

### **1. Check Service Bookings Column**
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'service_bookings' 
  AND column_name = 'order_id';
```
**Expected:** 1 row returned (order_id, uuid, YES)

### **2. Check Escrow Policies**
```sql
SELECT policyname, cmd, roles 
FROM pg_policies 
WHERE tablename = 'escrows';
```
**Expected:** 3 policies
- Authenticated users can view their related escrows
- Service role can insert escrows
- Service role can update escrows

### **3. Check Disputes Table**
```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'disputes'
ORDER BY ordinal_position;
```
**Expected:** 14 columns including id, order_id, complainant_id, etc.

### **4. Check Dispute Messages Table**
```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'dispute_messages'
ORDER BY ordinal_position;
```
**Expected:** 7 columns including id, dispute_id, sender_id, etc.

### **5. Check All Policies**
```sql
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename IN ('escrows', 'disputes', 'dispute_messages')
ORDER BY tablename, policyname;
```
**Expected:** 8 total policies
- 3 for escrows
- 3 for disputes
- 2 for dispute_messages

### **6. Check Indexes**
```sql
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('service_bookings', 'disputes', 'dispute_messages')
ORDER BY tablename, indexname;
```
**Expected:** 9+ indexes total

---

## 🔄 **Rollback (If Needed)**

If something goes wrong and you need to undo the migration:

```sql
-- WARNING: This will delete ALL data in these tables!

-- Drop tables (cascade deletes related data)
DROP TABLE IF EXISTS public.dispute_messages CASCADE;
DROP TABLE IF EXISTS public.disputes CASCADE;

-- Drop escrow policies
DROP POLICY IF EXISTS "Authenticated users can view their related escrows" ON public.escrows;
DROP POLICY IF EXISTS "Service role can insert escrows" ON public.escrows;
DROP POLICY IF EXISTS "Service role can update escrows" ON public.escrows;

-- Remove service_bookings column
ALTER TABLE public.service_bookings DROP COLUMN IF EXISTS order_id CASCADE;

-- Drop indexes
DROP INDEX IF EXISTS idx_service_bookings_order_id;
DROP INDEX IF EXISTS idx_disputes_order_id;
DROP INDEX IF EXISTS idx_disputes_complainant_id;
DROP INDEX IF EXISTS idx_disputes_respondent_id;
DROP INDEX IF EXISTS idx_disputes_status;
DROP INDEX IF EXISTS idx_disputes_created_at;
DROP INDEX IF EXISTS idx_dispute_messages_dispute_id;
DROP INDEX IF EXISTS idx_dispute_messages_sender_id;
DROP INDEX IF EXISTS idx_dispute_messages_created_at;
```

**⚠️ Use rollback only in development/staging, NEVER in production with live data!**

---

## 🧪 **Testing After Migration**

### **1. Test Escrow RLS**
```sql
-- As a test user, try to view escrows
SET LOCAL role = authenticated;
SET LOCAL request.jwt.claims = '{"sub":"<user-id>"}';

SELECT * FROM escrows WHERE order_id IN (
  SELECT id FROM orders WHERE buyer_id = '<user-id>'
);
-- Should return only user's escrows
```

### **2. Test Dispute Creation**
Use the API:
```bash
curl -X POST https://api.freti.com/disputes \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "<order-id>",
    "disputeType": "item_not_received",
    "reason": "Test dispute",
    "evidence": []
  }'
```

### **3. Test Service Booking Link**
```sql
-- Check if service bookings can link to orders
SELECT sb.id, sb.order_id, o.order_number, o.source
FROM service_bookings sb
LEFT JOIN orders o ON sb.order_id = o.id
LIMIT 5;
-- Should show service bookings with their order references
```

---

## ❓ **Troubleshooting**

### **Issue: "relation already exists"**
**Solution:** Tables were already created. Either:
- Run rollback and try again
- Manually check which parts failed and run only those

### **Issue: "permission denied"**
**Solution:** You need service_role key or admin privileges
- Use service role key in Supabase SQL editor (automatically applied)
- Don't run these migrations from client-side code

### **Issue: "foreign key violation"**
**Solution:** Ensure parent tables exist:
- `orders` table must exist before running migration
- `user_profiles` table must exist
- `escrows` table must exist

### **Issue: RLS policies not working**
**Solution:** 
- Verify RLS is enabled: `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;`
- Check policy syntax
- Test with actual JWT token, not anonymous

---

## 📊 **Migration Summary**

| Component | Action | Count |
|-----------|--------|-------|
| Tables | Created | 2 (disputes, dispute_messages) |
| Columns | Added | 1 (service_bookings.order_id) |
| Indexes | Created | 9 |
| RLS Policies | Created | 8 |
| Triggers | Created | 1 |
| Foreign Keys | Added | 3 |

**Total Changes:** 24 database objects

---

## ✅ **Success Checklist**

- [ ] Migration file executed without errors
- [ ] All verification queries return expected results
- [ ] RLS policies active (check pg_policies)
- [ ] Indexes created (check pg_indexes)
- [ ] Foreign keys enforced (try inserting invalid data - should fail)
- [ ] Backend service restarts successfully
- [ ] API endpoints respond correctly
- [ ] Test dispute creation works
- [ ] Test escrow RLS works (users can't see others' escrows)

---

## 🚀 **After Migration**

1. **Restart Backend Service**
   ```bash
   pm2 restart fretiko-backend
   # or
   npm run start:prod
   ```

2. **Run Backend Tests**
   ```bash
   npm test
   ```

3. **Test Critical Paths**
   - Place an order
   - Create a dispute
   - Check workspace analytics
   - Verify admin dashboard

4. **Monitor Logs**
   - Check for migration-related errors
   - Verify escrow creation works
   - Check dispute system functional

---

## 📞 **Need Help?**

If you encounter issues:
1. Check error messages in Supabase logs
2. Verify table schemas match expected structure
3. Test RLS policies manually
4. Check foreign key constraints
5. Review rollback section above

**Database is now ready for the escrow system!** 🎉

