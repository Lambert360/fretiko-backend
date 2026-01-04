# Phase 7: Testing Guide
## Platform Commission and Wallet System

This guide provides instructions for running the Phase 7 tests.

---

## Test Components

### 1. Database Verification Scripts ✅ Ready to Run
**File**: `test/database-verification.sql`

**Purpose**: Verify database setup and integrity

**How to Run**:
```bash
# Using psql (PostgreSQL client)
psql -h <your-db-host> -U <username> -d <database> -f test/database-verification.sql

# Or copy queries and run in Supabase SQL Editor
# Or run via your database client (pgAdmin, DBeaver, etc.)
```

**What it checks**:
- Platform user exists in auth.users
- Platform user profile exists
- Platform wallet exists
- Auction commission rate (10%)
- Order source enum includes 'wishlist'
- Commission collection summary
- Platform wallet balance
- Bank accounts and withdrawal requests

**Status**: ✅ Ready - No code changes needed

---

### 2. Manual Testing Checklist ✅ Ready to Use
**File**: `test/manual-testing-checklist.md`

**Purpose**: Step-by-step guide for manual UI testing

**How to Use**:
1. Open the checklist file
2. Follow each test step by step
3. Check off items as you complete them
4. Fill in notes and results
5. Document any issues found

**What it tests**:
- Admin panel UI (Platform Wallet tab)
- Bank account management UI
- Withdrawal request UI
- User experience and error handling

**Status**: ✅ Ready - Print or keep open while testing

---

### 3. Integration Tests 📝 Template/Guide
**File**: `test/platform-wallet-integration.test.ts`

**Purpose**: Automated API endpoint testing

**Status**: ⚠️ Requires Setup

**What's needed**:
1. Test environment configuration
2. Admin JWT token setup
3. Test database access
4. Optional: Test data setup

**Current State**: 
- Test structure is defined
- Tests need authentication setup
- Some helper functions need implementation

**How to Set Up**:

#### Option A: Run as Integration Tests (Recommended)
1. Set up test environment variables:
   ```env
   # .env.test
   SUPABASE_URL=your-test-supabase-url
   SUPABASE_SERVICE_KEY=your-test-service-key
   JWT_SECRET=your-jwt-secret
   ```

2. Implement `getAdminToken()` function:
   ```typescript
   async function getAdminToken(): Promise<string> {
     // Login as admin user and get JWT token
     const loginResponse = await request(app.getHttpServer())
       .post('/auth/login')
       .send({
         email: 'admin@example.com',
         password: 'admin-password'
       });
     return loginResponse.body.accessToken;
   }
   ```

3. Run tests:
   ```bash
   npm run test platform-wallet-integration
   ```

#### Option B: Use as API Testing Guide
- Copy test cases to Postman/Insomnia
- Use as reference for manual API testing
- Follow the test structure for API validation

---

## Recommended Testing Approach

### Step 1: Database Verification (5-10 minutes)
✅ **Run SQL verification script**
- Quick verification that migrations worked
- Confirms database structure is correct
- No code execution needed

### Step 2: Manual UI Testing (30-60 minutes)
✅ **Follow manual testing checklist**
- Test admin panel functionality
- Verify user experience
- Document any UI issues

### Step 3: API Testing (Optional - 30-60 minutes)
⚠️ **Set up integration tests OR use Postman**
- If integration tests are set up: Run automated tests
- If not: Use test file as guide for manual API testing
- Verify all endpoints work correctly

### Step 4: End-to-End Flow Testing (20-30 minutes)
✅ **Manual end-to-end test**
- Create test order
- Verify commission calculation
- Verify platform wallet credit
- Test withdrawal process

---

## Quick Start Testing

### Fastest Path (30 minutes)

1. **Database Check** (5 min)
   ```sql
   -- Run these key queries:
   SELECT id FROM wallets WHERE user_id = '00000000-0000-4000-8000-000000000002';
   SELECT column_default FROM information_schema.columns WHERE table_name = 'auctions' AND column_name = 'commission_rate';
   ```

2. **Admin Panel UI** (15 min)
   - Log in to admin panel
   - Navigate to Finance → Platform Wallet
   - Verify balance cards display
   - Try adding a test bank account
   - Verify forms work

3. **API Quick Check** (10 min)
   - Use browser DevTools Network tab
   - Navigate to Platform Wallet tab
   - Verify API calls return 200 OK
   - Check response data structure

---

## Test Results Documentation

After completing tests, document results in:

1. **Manual Testing Checklist** - Fill in the summary section
2. **Create test results document**:
   - List of tests run
   - Pass/fail status
   - Issues found
   - Recommendations

---

## Troubleshooting

### Database Verification Fails
- **Issue**: Platform user not found
- **Solution**: Run migration 088 again
- **Check**: Verify migrations ran successfully

### Admin Panel Access Denied
- **Issue**: Cannot access Platform Wallet tab
- **Solution**: Verify admin user has `view_revenue` permission
- **Check**: User role and permissions in database

### API Tests Fail
- **Issue**: 401 Unauthorized
- **Solution**: Verify JWT token is valid and user is admin
- **Check**: Token expiration and user permissions

### Integration Tests Won't Run
- **Issue**: Tests require setup
- **Solution**: Use manual testing checklist instead
- **Alternative**: Use Postman/Insomnia for API testing

---

## Next Steps After Testing

1. ✅ Review test results
2. ✅ Fix any critical issues found
3. ✅ Re-test failed test cases
4. ✅ Document known issues/limitations
5. ✅ Proceed to Phase 8 (Documentation)

---

## Questions?

If you encounter issues during testing:
1. Check this guide first
2. Review the test files for detailed test cases
3. Check database setup if database tests fail
4. Verify permissions if API tests fail

---

**End of Testing Guide**

