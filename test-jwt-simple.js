// Simple JWT test - just check if auth tokens work
const axios = require('axios');

async function testJWT() {
  const baseURL = 'http://localhost:3000';
  
  try {
    console.log('🔐 Testing JWT Authentication...\n');

    // Step 1: Sign up to get a token
    console.log('1. Creating test user...');
    const timestamp = Date.now();
    const testEmail = `jwttest${timestamp}@gmail.com`;
    
    const authResponse = await axios.post(`${baseURL}/auth/signup`, {
      email: testEmail,
      password: 'testpass123',
      firstName: 'JWT',
      lastName: 'Test'
    });
    
    const token = authResponse.data.accessToken;
    console.log('✅ User created');
    console.log('🔑 Token (first 20 chars):', token.substring(0, 20) + '...');
    console.log('👤 User ID:', authResponse.data.user.id);

    // Step 2: Test token with users endpoint
    console.log('\n2. Testing token with /users/profile...');
    try {
      const profileResponse = await axios.get(`${baseURL}/users/profile`, {
        headers: { 
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('✅ Token works! Profile loaded:');
      console.log('👤 Username:', profileResponse.data.username);
      console.log('🆔 Profile ID:', profileResponse.data.id);
      
    } catch (profileError) {
      console.log('❌ Token failed:', profileError.response?.status);
      console.log('📝 Error:', profileError.response?.data?.message);
      console.log('📋 Headers sent:', profileError.config?.headers);
    }

    // Step 3: Test a simple update
    console.log('\n3. Testing profile update...');
    try {
      const updateResponse = await axios.put(`${baseURL}/users/profile`, {
        bio: 'JWT test bio'
      }, {
        headers: { 
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('✅ Profile update works!');
      console.log('📝 Bio updated:', updateResponse.data.bio);
      
    } catch (updateError) {
      console.log('❌ Update failed:', updateError.response?.status);
      console.log('📝 Error:', updateError.response?.data?.message);
    }

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\n💡 Make sure your backend is running: npm run start:dev');
    }
  }
}

testJWT();