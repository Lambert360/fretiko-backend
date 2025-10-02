// Quick script to debug profile issues
const axios = require('axios');

async function debugProfiles() {
  const baseURL = 'http://192.168.43.135:3000';
  
  try {
    console.log('🔍 Debugging profile issues...\n');

    // Step 1: Create a fresh user
    console.log('1. Creating fresh test user...');
    const timestamp = Date.now();
    const testEmail = `debug${timestamp}@test.com`;
    
    const authResponse = await axios.post(`${baseURL}/auth/signup`, {
      email: testEmail,
      password: 'testpass123',
      firstName: 'Debug',
      lastName: 'User'
    });
    
    const token = authResponse.data.accessToken;
    const userId = authResponse.data.user.id;
    console.log('✅ User created:', userId);
    console.log('🔑 Token valid for 24 hours now');

    // Step 2: Try to get profile immediately
    console.log('\n2. Getting profile immediately after signup...');
    try {
      const profileResponse = await axios.get(`${baseURL}/users/profile`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log('✅ Profile loaded:', profileResponse.data.username);
      console.log('🏪 Is Seller:', profileResponse.data.isSeller);
      console.log('🏍️ Is Rider:', profileResponse.data.isRider);
    } catch (error) {
      console.log('❌ Profile GET failed:', error.response?.data?.message);
    }

    // Step 3: Try a simple update
    console.log('\n3. Testing profile update...');
    try {
      const updateResponse = await axios.put(`${baseURL}/users/profile`, {
        bio: 'Debug test bio'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      console.log('✅ Profile update successful!');
      console.log('📝 Bio:', updateResponse.data.bio);
      console.log('🏍️ Is Rider:', updateResponse.data.isRider);
      
    } catch (error) {
      console.log('❌ Profile update failed:', error.response?.status);
      console.log('📝 Error:', error.response?.data?.message);
    }

  } catch (error) {
    console.error('\n❌ Debug failed:', error.message);
  }
}

debugProfiles();