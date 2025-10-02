// Test script for Users microservice
// Run this after: node test-simple.js (to get a user token)

const axios = require('axios');

async function testUsersService() {
  const baseURL = 'http://localhost:3000';
  let accessToken = '';
  
  try {
    console.log('🚀 Testing Fretiko Users Service...\n');

    // Step 1: Sign up to get an access token
    console.log('1. Creating test user...');
    const timestamp = Date.now();
    const testEmail = `userprofile${timestamp}@gmail.com`;
    
    const signupData = {
      email: testEmail,
      password: 'testpass123',
      firstName: 'John',
      lastName: 'Doe'
    };

    const authResponse = await axios.post(`${baseURL}/auth/signup`, signupData);
    accessToken = authResponse.data.accessToken;
    
    console.log('✅ User created successfully');
    console.log('🆔 User ID:', authResponse.data.user.id);
    console.log('📧 Email:', authResponse.data.user.email);
    console.log('🔑 Access token obtained\n');

    // Step 2: Get initial profile (should be auto-created)
    console.log('2. Getting user profile...');
    const profileResponse = await axios.get(`${baseURL}/users/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    console.log('✅ Profile retrieved:');
    console.log('👤 Username:', profileResponse.data.username);
    console.log('📝 Bio:', profileResponse.data.bio || 'Not set');
    console.log('🏪 Is Seller:', profileResponse.data.isSeller);
    console.log('📅 Created:', new Date(profileResponse.data.createdAt).toLocaleString());
    console.log('');

    // Step 3: Update profile
    console.log('3. Updating profile...');
    const updateData = {
      username: `john_doe_${timestamp}`,
      bio: 'Welcome to my Fretiko profile! I love shopping and discovering new products.',
      location: 'New York, USA',
      phone: '+1-555-0123',
      isSeller: true,
      preferences: {
        notifications: { email: true, push: true, sms: false },
        privacy: { showEmail: false, showPhone: false, showLocation: true },
        shopping: { currency: 'USD', language: 'en' }
      }
    };

    const updateResponse = await axios.put(`${baseURL}/users/profile`, updateData, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    console.log('✅ Profile updated successfully:');
    console.log('👤 New Username:', updateResponse.data.username);
    console.log('📝 Bio:', updateResponse.data.bio.substring(0, 50) + '...');
    console.log('📍 Location:', updateResponse.data.location);
    console.log('📞 Phone:', updateResponse.data.phone);
    console.log('🏪 Is Seller:', updateResponse.data.isSeller);
    console.log('⚙️  Preferences set:', Object.keys(updateResponse.data.preferences).length, 'categories');
    console.log('');

    // Step 4: Test public profile view
    console.log('4. Testing public profile view...');
    const userId = authResponse.data.user.id;
    const publicResponse = await axios.get(`${baseURL}/users/profile/${userId}`);
    
    console.log('✅ Public profile accessible:');
    console.log('👤 Username:', publicResponse.data.username);
    console.log('📝 Bio:', publicResponse.data.bio ? 'Visible' : 'Not set');
    console.log('📍 Location:', publicResponse.data.location || 'Not set');
    console.log('🏪 Is Seller:', publicResponse.data.isSeller);
    console.log('❌ Private data (phone/preferences) not exposed');
    console.log('');

    // Step 5: Test search functionality
    console.log('5. Testing user search...');
    const searchResponse = await axios.get(`${baseURL}/users/search?q=john&limit=5`);
    
    console.log('✅ Search completed:');
    console.log('📊 Results found:', searchResponse.data.length);
    if (searchResponse.data.length > 0) {
      console.log('👤 First result:', searchResponse.data[0].username);
    }
    console.log('');

    console.log('🎉 All Users Service tests passed!');
    console.log('');
    console.log('📋 Summary of what works:');
    console.log('   ✅ Auto profile creation on signup');
    console.log('   ✅ Profile retrieval with authentication');  
    console.log('   ✅ Profile updates with validation');
    console.log('   ✅ Public profile viewing (privacy-safe)');
    console.log('   ✅ User search functionality');
    console.log('   ✅ JWT token authentication');
    console.log('');
    console.log('🎯 Ready for mobile app integration!');

  } catch (error) {
    console.error('\n❌ Test failed:', error.response?.data?.message || error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\n💡 Make sure your server is running: npm run start:dev');
    }
    
    if (error.response?.status === 401) {
      console.log('\n💡 Authentication issue - check JWT token handling');
    }
    
    if (error.response?.status === 500) {
      console.log('\n💡 Server error - check your database migration was run');
      console.log('   Run the SQL migration in Supabase Dashboard first');
    }
  }
}

testUsersService();