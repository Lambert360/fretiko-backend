// Comprehensive Supabase auth diagnosis
require('dotenv').config({ path: './.env' });
const { createClient } = require('@supabase/supabase-js');

async function diagnoseSupabaseAuth() {
  console.log('🚀 Comprehensive Supabase Auth Diagnosis\n');

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('📋 Configuration:');
  console.log('  URL:', supabaseUrl);
  console.log('  Anon Key:', anonKey?.substring(0, 20) + '...');
  console.log('  Service Key:', serviceKey?.substring(0, 20) + '...\n');

  // Test 1: Basic connectivity
  console.log('🔍 Test 1: Basic Connectivity');
  try {
    const supabase = createClient(supabaseUrl, anonKey);
    const { data, error } = await supabase.from('non_existent_table').select('*').limit(1);

    if (error?.message.includes('relation "public.non_existent_table" does not exist')) {
      console.log('✅ Database connection working (expected error for non-existent table)');
    } else {
      console.log('❌ Unexpected database response:', error?.message);
    }
  } catch (err) {
    console.log('❌ Database connection failed:', err.message);
  }

  // Test 2: Auth service availability
  console.log('\n🔍 Test 2: Auth Service Check');
  try {
    const supabase = createClient(supabaseUrl, anonKey);

    // Try to get auth settings (this should work even without valid credentials)
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: {
        'apikey': anonKey,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const settings = await response.json();
      console.log('✅ Auth service responding');
      console.log('  Sign up enabled:', settings.external?.email !== false);
      console.log('  Email confirmation:', settings.email?.enable_confirmations || false);
      console.log('  Auto confirm:', settings.email?.enable_signup || false);
    } else {
      console.log('❌ Auth service error:', response.status, response.statusText);
    }
  } catch (err) {
    console.log('❌ Auth service unreachable:', err.message);
  }

  // Test 3: Try signin with known bad credentials (should get specific error)
  console.log('\n🔍 Test 3: Signin Error Analysis');
  try {
    const supabase = createClient(supabaseUrl, anonKey);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: 'nonexistent@test.com',
      password: 'wrongpassword'
    });

    console.log('📋 Signin attempt result:');
    console.log('  Error message:', error?.message);
    console.log('  Error code:', error?.status);
    console.log('  Data received:', !!data);

    if (error?.message === 'Invalid login credentials') {
      console.log('✅ Normal auth error - credentials validation working');
    } else if (error?.message.includes('Database error')) {
      console.log('❌ Database error - project configuration issue');
    } else {
      console.log('⚠️ Unexpected error pattern');
    }
  } catch (err) {
    console.log('❌ Signin test failed:', err.message);
  }

  // Test 4: Check project settings with service role
  console.log('\n🔍 Test 4: Project Settings (Service Role)');
  try {
    const serviceSupabase = createClient(supabaseUrl, serviceKey);

    // Try to list auth users (this requires service role)
    const { data: users, error } = await serviceSupabase.auth.admin.listUsers({
      page: 1,
      perPage: 1
    });

    if (error) {
      console.log('❌ Service role error:', error.message);
      if (error.message.includes('Database error')) {
        console.log('🔧 DIAGNOSIS: Your Supabase project has database connectivity issues');
        console.log('   This affects both user creation AND existing user authentication');
      }
    } else {
      console.log('✅ Service role working');
      console.log('  Users found:', users?.length || 0);
      if (users?.length > 0) {
        console.log('  Sample user exists - signin should work if credentials are correct');
      }
    }
  } catch (err) {
    console.log('❌ Service role test failed:', err.message);
  }

  // Test 5: Create a user with admin API to bypass normal restrictions
  console.log('\n🔍 Test 5: Admin User Creation Test');
  try {
    const serviceSupabase = createClient(supabaseUrl, serviceKey);
    const testEmail = `admin-test-${Date.now()}@example.com`;

    const { data, error } = await serviceSupabase.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123',
      email_confirm: true, // Skip email confirmation
      user_metadata: {
        first_name: 'Admin',
        last_name: 'Test'
      }
    });

    if (error) {
      console.log('❌ Admin user creation failed:', error.message);
      console.log('🔧 CRITICAL: Even admin API failing - Supabase project has serious issues');
    } else {
      console.log('✅ Admin user creation successful');
      console.log('  User ID:', data.user?.id);

      // Now try to sign in with this user
      console.log('\n  🔍 Testing signin with admin-created user...');
      const { data: signInData, error: signInError } = await serviceSupabase.auth.signInWithPassword({
        email: testEmail,
        password: 'TestPassword123'
      });

      if (signInError) {
        console.log('  ❌ Signin failed even with admin-created user:', signInError.message);
        console.log('  🔧 DIAGNOSIS: Signin functionality is broken in your project');
      } else {
        console.log('  ✅ Signin successful with admin-created user');
        console.log('  🔧 DIAGNOSIS: Normal signup is blocked, but signin works');
      }
    }
  } catch (err) {
    console.log('❌ Admin test failed:', err.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log('🎯 DIAGNOSIS SUMMARY');
  console.log('='.repeat(60));
}

diagnoseSupabaseAuth().catch(console.error);