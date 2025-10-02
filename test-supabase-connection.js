// Test Supabase connection for debugging auth issues
require('dotenv').config({ path: './.env' });
const { createClient } = require('@supabase/supabase-js');

async function testSupabaseConnection() {
  console.log('🔍 Testing Supabase connection...');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  console.log('📡 Supabase URL:', supabaseUrl);
  console.log('🔑 Supabase Key starts with:', supabaseKey?.substring(0, 20) + '...');

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing Supabase credentials in .env file');
    return;
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase client created successfully');

    // Test basic connection
    console.log('🔍 Testing basic auth...');

    // Try to create a test user
    const testEmail = `test-${Date.now()}@example.com`;
    console.log('🔍 Attempting signup with email:', testEmail);

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
      console.log('❌ Supabase signup error:', error.message);
      console.log('🔍 Error details:', error);

      // Check if it's an email confirmation issue
      if (error.message.includes('email') && error.message.includes('confirm')) {
        console.log('🔧 TIP: Email confirmation might be enabled in Supabase. Check your Supabase dashboard Authentication settings.');
      }
    } else {
      console.log('✅ Supabase signup successful!');
      console.log('👤 User ID:', data.user?.id);
      console.log('🔑 Session available:', !!data.session);
      console.log('📧 Email confirmation required:', !data.session);
    }

    return { success: !error, error, data };

  } catch (error) {
    console.error('❌ Supabase connection failed:', error.message);
    return { success: false, error: error.message };
  }
}

testSupabaseConnection()
  .then(result => {
    console.log('\n📊 Test Summary:');
    console.log('  Connection:', result.success ? '✅ SUCCESS' : '❌ FAILED');
    if (result.error) {
      console.log('  Error:', result.error);
    }
  })
  .catch(console.error);