#!/usr/bin/env node

// Test script for password reset functionality
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testPasswordResetFunctions() {
  console.log('🧪 Testing Password Reset Functions...\n');

  try {
    // Test 1: Generate reset token
    console.log('📝 Test 1: Generating reset token...');
    const { data: tokenData, error: tokenError } = await supabase
      .rpc('generate_password_reset_token');

    if (tokenError) {
      console.error('❌ Token generation failed:', tokenError);
      return;
    }

    const resetToken = tokenData[0]?.message;
    console.log('✅ Generated token:', resetToken);

    // Test 2: Save reset token (simulating email lookup)
    console.log('\n💾 Test 2: Saving reset token...');
    const testEmail = 'test@example.com';
    const { data: saveData, error: saveError } = await supabase
      .rpc('save_reset_token', {
        user_email: testEmail,
        token: resetToken,
        expires_hours: 1
      });

    if (saveError || !saveData?.[0]?.success) {
      console.error('❌ Save token failed:', saveError);
      return;
    }

    console.log('✅ Token saved successfully');

    // Test 3: Verify reset token
    console.log('\n🔍 Test 3: Verifying reset token...');
    const { data: verifyData, error: verifyError } = await supabase
      .rpc('verify_reset_token_func', {
        email: testEmail,
        token: resetToken
      });

    if (verifyError) {
      console.error('❌ Token verification failed:', verifyError);
      return;
    }

    if (!verifyData?.[0]?.valid) {
      console.error('❌ Token verification returned invalid:', verifyData?.[0]);
      return;
    }

    console.log('✅ Token verified successfully');
    console.log('   User ID:', verifyData?.[0]?.user_id);

    // Test 4: Update password
    console.log('\n🔐 Test 4: Updating password...');
    const newPassword = 'NewTestPassword123!';
    const { data: updateData, error: updateError } = await supabase
      .rpc('update_user_password', {
        user_email: testEmail,
        new_password: newPassword
      });

    if (updateError || !updateData?.[0]?.success) {
      console.error('❌ Password update failed:', updateError);
      return;
    }

    console.log('✅ Password updated successfully');
    console.log('   User ID:', updateData?.[0]?.user_id);

    // Test 5: Clear reset token
    console.log('\n🧹 Test 5: Clearing reset token...');
    const { data: clearData, error: clearError } = await supabase
      .rpc('clear_reset_token', {
        profile_id: verifyData?.[0]?.user_id
      });

    if (clearError) {
      console.error('❌ Clear token failed:', clearError);
      return;
    }

    console.log('✅ Reset token cleared successfully');

    console.log('\n🎉 All password reset functions are working correctly!');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testPasswordResetFunctions()
  .then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
