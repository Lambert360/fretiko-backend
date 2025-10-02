// Test Supabase connection using service role key for user creation
require('dotenv').config({ path: './.env' });
const { createClient } = require('@supabase/supabase-js');

async function testSupabaseServiceRole() {
  console.log('🔍 Testing Supabase with service role key...');

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('📡 Supabase URL:', supabaseUrl);
  console.log('🔑 Service Role Key starts with:', serviceRoleKey?.substring(0, 20) + '...');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('❌ Missing Supabase service role credentials in .env file');
    return;
  }

  try {
    // Create service role client (bypasses RLS)
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    console.log('✅ Supabase service role client created successfully');

    // Test basic connection
    console.log('🔍 Testing auth with service role...');

    // Try to create a test user with service role key
    const testEmail = `test-service-${Date.now()}@example.com`;
    console.log('🔍 Attempting signup with service role key:', testEmail);

    const { data, error } = await supabase.auth.admin.createUser({
      email: testEmail,
      password: 'TestPassword123',
      user_metadata: {
        first_name: 'Test',
        last_name: 'User'
      },
      email_confirm: true // Skip email confirmation
    });

    if (error) {
      console.log('❌ Service role signup error:', error.message);
      console.log('🔍 Error details:', error);
    } else {
      console.log('✅ Service role signup successful!');
      console.log('👤 User ID:', data.user?.id);
      console.log('📧 Email:', data.user?.email);
      console.log('✅ Email confirmed:', data.user?.email_confirmed_at ? 'Yes' : 'No');
    }

    return { success: !error, error, data };

  } catch (error) {
    console.error('❌ Service role test failed:', error.message);
    return { success: false, error: error.message };
  }
}

async function testSupabaseAnonKey() {
  console.log('\n🔍 Testing Supabase with anon key...');

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_KEY;

  try {
    // Create anon client
    const supabase = createClient(supabaseUrl, anonKey);
    console.log('✅ Supabase anon client created successfully');

    // Try to create a test user with anon key
    const testEmail = `test-anon-${Date.now()}@example.com`;
    console.log('🔍 Attempting signup with anon key:', testEmail);

    const { data, error } = await supabase.auth.signUp({
      email: testEmail,
      password: 'TestPassword123',
      options: {
        data: {
          first_name: 'Test',
          last_name: 'User'
        }
      }
    });

    if (error) {
      console.log('❌ Anon key signup error:', error.message);
      console.log('🔍 Error details:', error);
    } else {
      console.log('✅ Anon key signup successful!');
      console.log('👤 User ID:', data.user?.id);
      console.log('🔑 Session available:', !!data.session);
      console.log('📧 Email confirmation required:', !data.session);
    }

    return { success: !error, error, data };

  } catch (error) {
    console.error('❌ Anon key test failed:', error.message);
    return { success: false, error: error.message };
  }
}

async function runTests() {
  console.log('🚀 Starting Supabase Key Comparison Tests...\n');

  // Test 1: Service Role Key
  const serviceResult = await testSupabaseServiceRole();

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 2: Anon Key
  const anonResult = await testSupabaseAnonKey();

  console.log('\n' + '='.repeat(50) + '\n');
  console.log('🎯 Test Summary:');
  console.log(`  Service Role Key: ${serviceResult.success ? '✅' : '❌'}`);
  console.log(`  Anon Key: ${anonResult.success ? '✅' : '❌'}`);

  if (serviceResult.success && !anonResult.success) {
    console.log('\n💡 SOLUTION: Backend should use service role key for user creation!');
  } else if (!serviceResult.success && !anonResult.success) {
    console.log('\n⚠️ Both keys failed - check Supabase dashboard configuration');
  }
}

// Run the tests
runTests().catch(console.error);