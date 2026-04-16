// Test script for the new authentication system
const { createClient } = require('@supabase/supabase-js');

// Configuration
const supabaseUrl = 'https://piytfaopdlxltdczdvtk.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpeXRmYW9wZGx4bHRkY3pkdnRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzExNTQ2OCwiZXhwIjoyMDg4NDc1NDY4fQ.Eu6IayuDOthau9AVroriCgBXm7Mmst55i1VHyfh-msw';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function testNewAuthSystem() {
  console.log('🧪 Testing New Authentication System...\n');

  try {
    // Test 1: Check if refresh_tokens table exists
    console.log('1️⃣ Testing refresh_tokens table...');
    const { data: refreshTokens, error: refreshError } = await supabase
      .from('refresh_tokens')
      .select('count')
      .limit(1);

    if (refreshError) {
      console.log('❌ refresh_tokens table error:', refreshError.message);
      console.log('📝 Running migration...');
      
      // Try to create the table manually
      const { error: createError } = await supabase.rpc('exec_sql', {
        sql: `
          CREATE TABLE IF NOT EXISTS refresh_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
            token_hash VARCHAR(255) NOT NULL UNIQUE,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            is_revoked BOOLEAN DEFAULT FALSE,
            device_info JSONB DEFAULT '{}',
            ip_address INET
          );
        `
      });
      
      if (createError) {
        console.log('❌ Manual table creation failed:', createError.message);
      } else {
        console.log('✅ refresh_tokens table created');
      }
    } else {
      console.log('✅ refresh_tokens table exists');
    }

    // Test 2: Check if user_activity_log table exists
    console.log('\n2️⃣ Testing user_activity_log table...');
    const { data: activityLog, error: activityError } = await supabase
      .from('user_activity_log')
      .select('count')
      .limit(1);

    if (activityError) {
      console.log('❌ user_activity_log table error:', activityError.message);
      console.log('📝 Creating user_activity_log table...');
      
      const { error: createActivityError } = await supabase.rpc('exec_sql', {
        sql: `
          CREATE TABLE IF NOT EXISTS user_activity_log (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
            activity_type VARCHAR(50) NOT NULL,
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            metadata JSONB DEFAULT '{}'
          );
        `
      });
      
      if (createActivityError) {
        console.log('❌ Manual activity table creation failed:', createActivityError.message);
      } else {
        console.log('✅ user_activity_log table created');
      }
    } else {
      console.log('✅ user_activity_log table exists');
    }

    // Test 3: Test token service functions
    console.log('\n3️⃣ Testing database functions...');
    
    // Test log_user_activity function
    const { error: logError } = await supabase.rpc('log_user_activity', {
      p_user_id: '00000000-0000-0000-0000-000000000000',
      p_activity_type: 'test',
      p_metadata: { test: true }
    });

    if (logError) {
      console.log('❌ log_user_activity function error:', logError.message);
    } else {
      console.log('✅ log_user_activity function works');
    }

    // Test is_user_inactive function
    const { data: inactiveData, error: inactiveError } = await supabase.rpc('is_user_inactive', {
      p_user_id: '00000000-0000-0000-0000-000000000000'
    });

    if (inactiveError) {
      console.log('❌ is_user_inactive function error:', inactiveError.message);
    } else {
      console.log('✅ is_user_inactive function works');
    }

    console.log('\n🎉 Authentication system test completed!');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testNewAuthSystem();
