// Comprehensive Supabase Admin API Diagnosis
require('dotenv').config({ path: './.env' });
const { createClient } = require('@supabase/supabase-js');

async function diagnoseAdminAPI() {
  console.log('🔍 Comprehensive Supabase Admin API Diagnosis\n');
  console.log('='.repeat(60));

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_KEY;

  // Step 1: Verify credentials
  console.log('\n📋 Step 1: Verifying Credentials');
  console.log('-'.repeat(60));
  console.log('SUPABASE_URL:', supabaseUrl ? '✅ Set' : '❌ Missing');
  console.log('SUPABASE_SERVICE_ROLE_KEY:', serviceRoleKey ? `✅ Set (${serviceRoleKey.substring(0, 30)}...)` : '❌ Missing');
  console.log('SUPABASE_KEY (anon):', anonKey ? '✅ Set' : '❌ Missing');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('\n❌ Missing required credentials. Cannot proceed.');
    return;
  }

  // Step 2: Test service role client creation
  console.log('\n📋 Step 2: Testing Service Role Client');
  console.log('-'.repeat(60));
  let supabase;
  try {
    supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
    console.log('✅ Service role client created successfully');
  } catch (error) {
    console.error('❌ Failed to create client:', error.message);
    return;
  }

  // Step 3: Test basic database connection (not auth)
  console.log('\n📋 Step 3: Testing Database Connection (Non-Auth)');
  console.log('-'.repeat(60));
  try {
    const { data, error } = await supabase
      .from('staff_accounts')
      .select('id')
      .limit(1);

    if (error) {
      console.log('❌ Database query failed:', error.message);
      console.log('   Code:', error.code);
      console.log('   Details:', error.details);
    } else {
      console.log('✅ Database connection works');
      console.log('   Can query staff_accounts table');
    }
  } catch (error) {
    console.error('❌ Database test error:', error.message);
  }

  // Step 4: Test Auth Admin API - List Users
  console.log('\n📋 Step 4: Testing Auth Admin API - listUsers()');
  console.log('-'.repeat(60));
  try {
    const { data: usersList, error: listError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 10,
    });

    if (listError) {
      console.log('❌ listUsers() failed');
      console.log('   Error:', listError.message);
      console.log('   Status:', listError.status);
      console.log('   Code:', listError.code);
      console.log('   Full error:', JSON.stringify(listError, null, 2));
      
      // Check specific error codes
      if (listError.status === 500) {
        console.log('\n   💡 Status 500 indicates:');
        console.log('      - Supabase Auth service internal error');
        console.log('      - Database connection issue in Auth service');
        console.log('      - Auth database might be corrupted');
      }
      if (listError.code === 'unexpected_failure') {
        console.log('\n   💡 Code "unexpected_failure" indicates:');
        console.log('      - Generic Supabase error');
        console.log('      - Could be infrastructure issue');
        console.log('      - Check Supabase Dashboard → Logs');
      }
    } else {
      console.log('✅ listUsers() works!');
      console.log('   Found', usersList?.users?.length || 0, 'users');
      if (usersList?.users && usersList.users.length > 0) {
        console.log('   Sample user:', {
          id: usersList.users[0].id,
          email: usersList.users[0].email,
        });
      }
    }
  } catch (error) {
    console.error('❌ listUsers() exception:', error.message);
    console.error('   Stack:', error.stack);
  }

  // Step 5: Test Auth Admin API - Create User
  console.log('\n📋 Step 5: Testing Auth Admin API - createUser()');
  console.log('-'.repeat(60));
  const testEmail = `test-admin-api-${Date.now()}@fretiko-test.com`;
  try {
    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123!',
      email_confirm: true,
      user_metadata: {
        test: true,
      },
    });

    if (createError) {
      console.log('❌ createUser() failed');
      console.log('   Error:', createError.message);
      console.log('   Status:', createError.status);
      console.log('   Code:', createError.code);
      console.log('   Full error:', JSON.stringify(createError, null, 2));
      
      // Check specific error codes
      if (createError.status === 500) {
        console.log('\n   💡 Status 500 indicates:');
        console.log('      - Supabase Auth service cannot write to database');
        console.log('      - Auth database might be full or corrupted');
        console.log('      - Service role key might not have write permissions');
      }
      if (createError.message?.includes('already')) {
        console.log('\n   💡 User already exists - this is actually good!');
        console.log('      Means Admin API can read, but user exists');
      }
    } else {
      console.log('✅ createUser() works!');
      console.log('   Created user:', {
        id: newUser?.user?.id,
        email: newUser?.user?.email,
      });
      
      // Clean up test user
      if (newUser?.user?.id) {
        console.log('\n🧹 Cleaning up test user...');
        const { error: deleteError } = await supabase.auth.admin.deleteUser(newUser.user.id);
        if (deleteError) {
          console.log('⚠️  Failed to delete test user:', deleteError.message);
        } else {
          console.log('✅ Test user deleted');
        }
      }
    }
  } catch (error) {
    console.error('❌ createUser() exception:', error.message);
    console.error('   Stack:', error.stack);
  }

  // Step 6: Test regular Auth API (non-admin)
  console.log('\n📋 Step 6: Testing Regular Auth API (Non-Admin)');
  console.log('-'.repeat(60));
  try {
    // Try to sign in (this doesn't require admin API)
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: 'nonexistent@test.com',
      password: 'wrong',
    });

    if (signInError) {
      if (signInError.message.includes('Invalid login credentials')) {
        console.log('✅ Regular Auth API works (got expected error)');
        console.log('   Auth service is responding correctly');
      } else {
        console.log('⚠️  Unexpected error:', signInError.message);
      }
    } else {
      console.log('⚠️  Sign-in succeeded (unexpected)');
    }
  } catch (error) {
    console.error('❌ Regular Auth API test error:', error.message);
  }

  // Step 7: Check service role key format
  console.log('\n📋 Step 7: Analyzing Service Role Key');
  console.log('-'.repeat(60));
  try {
    // Service role keys are JWTs - decode to check
    const parts = serviceRoleKey.split('.');
    if (parts.length === 3) {
      console.log('✅ Service role key is a valid JWT format');
      console.log('   Has 3 parts (header.payload.signature)');
      
      // Try to decode payload (base64)
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('   Payload decoded successfully');
        console.log('   Role:', payload.role || 'not specified');
        console.log('   Issued at:', payload.iat ? new Date(payload.iat * 1000).toISOString() : 'not specified');
        console.log('   Expires at:', payload.exp ? new Date(payload.exp * 1000).toISOString() : 'never');
      } catch (e) {
        console.log('⚠️  Could not decode payload');
      }
    } else {
      console.log('❌ Service role key is NOT a valid JWT format');
      console.log('   Expected 3 parts, got', parts.length);
    }
  } catch (error) {
    console.error('❌ Key analysis error:', error.message);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('🎯 DIAGNOSIS SUMMARY');
  console.log('='.repeat(60));
  console.log('\n📋 Next Steps:');
  console.log('1. Check Supabase Dashboard → Logs for Auth service errors');
  console.log('2. Verify service role key in Dashboard → Settings → API');
  console.log('3. Check if Auth Admin API is enabled in project settings');
  console.log('4. Check database storage usage (free plan: 500MB limit)');
  console.log('5. Try regenerating service role key if corrupted');
  console.log('6. Contact Supabase support if issue persists');
  console.log('\n');
}

diagnoseAdminAPI().catch(console.error);

