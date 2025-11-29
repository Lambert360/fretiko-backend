// Test Staff Authentication with Supabase Auth Admin API
require('dotenv').config({ path: './.env' });
const { createClient } = require('@supabase/supabase-js');

async function testStaffAuth() {
  console.log('🔍 Testing Staff Authentication Setup...\n');

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('📡 Supabase URL:', supabaseUrl);
  console.log('🔑 Service Role Key starts with:', serviceRoleKey?.substring(0, 30) + '...');
  console.log('');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('❌ Missing Supabase credentials in .env file');
    console.error('Required: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return;
  }

  try {
    // Create service role client
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    console.log('✅ Supabase service role client created\n');

    // Test 1: Try to list users (this is what's failing)
    console.log('🔍 Test 1: Listing users (admin API)...');
    const { data: usersList, error: listError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 10,
    });

    if (listError) {
      console.log('❌ Failed to list users:', listError.message);
      console.log('   Status:', listError.status);
      console.log('   Full error:', JSON.stringify(listError, null, 2));
      console.log('\n💡 Possible causes:');
      console.log('   1. Service role key doesn\'t have admin permissions');
      console.log('   2. Supabase Auth admin API is disabled');
      console.log('   3. Service role key is incorrect or expired');
      console.log('   4. Supabase project has restrictions');
    } else {
      console.log('✅ Successfully listed users');
      console.log('   Found', usersList?.users?.length || 0, 'users');
    }

    console.log('');

    // Test 2: Try to create a test user
    console.log('🔍 Test 2: Creating test user (admin API)...');
    const testEmail = `test-staff-${Date.now()}@fretiko.com`;
    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123!',
      email_confirm: true,
      user_metadata: {
        account_type: 'staff',
        staff_id: 'TEST-001',
      },
    });

    if (createError) {
      console.log('❌ Failed to create user:', createError.message);
      console.log('   Status:', createError.status);
      console.log('   Full error:', JSON.stringify(createError, null, 2));
    } else {
      console.log('✅ Successfully created test user');
      console.log('   User ID:', newUser?.user?.id);
      console.log('   Email:', newUser?.user?.email);
      
      // Clean up - delete test user
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

    console.log('');

    // Test 3: Check if we can sign in with password
    console.log('🔍 Test 3: Testing signInWithPassword...');
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: 'superadmin@fretiko.com',
      password: 'test',
    });

    if (signInError) {
      console.log('⚠️  Sign-in failed (expected if user doesn\'t exist):', signInError.message);
    } else {
      console.log('✅ Sign-in successful');
      console.log('   User ID:', signInData?.user?.id);
    }

    console.log('\n' + '='.repeat(60));
    console.log('🎯 DIAGNOSIS SUMMARY');
    console.log('='.repeat(60));
    
    if (listError || createError) {
      console.log('❌ Supabase Auth Admin API is NOT working');
      console.log('\n📋 ACTION REQUIRED:');
      console.log('1. Check Supabase Dashboard → Settings → API');
      console.log('2. Verify SUPABASE_SERVICE_ROLE_KEY is correct');
      console.log('3. Check if Auth Admin API is enabled');
      console.log('4. Verify service role key has admin permissions');
    } else {
      console.log('✅ Supabase Auth Admin API is working correctly');
      console.log('   The issue might be with the specific user or email');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

testStaffAuth().catch(console.error);

