// Simple test script to verify your auth service works
// Run this with: node test-auth.js

const axios = require('axios');

async function testAuth() {
  const baseURL = 'http://localhost:3000';
  
  try {
    console.log('🚀 Testing Fretiko Auth Service...\n');

    // Test 1: Server health check
    console.log('1. Testing server connection...');
    const pingResponse = await axios.get(`${baseURL}`);
    console.log('✅ Server is running!\n');

    // Test 2: Sign up a new user
    console.log('2. Testing user signup...');
    const signupData = {
      email: 'testuser@gmail.com',
      password: 'testpass123',
      firstName: 'Test',
      lastName: 'User'
    };

    const signupResponse = await axios.post(`${baseURL}/auth/signup`, signupData);
    console.log('✅ User signup successful!');
    console.log('User ID:', signupResponse.data.user.id);
    console.log('Access Token (first 20 chars):', signupResponse.data.accessToken.substring(0, 20) + '...\n');

    // Test 3: Sign in with the same user
    console.log('3. Testing user signin...');
    const signinData = {
      email: 'testuser@gmail.com',
      password: 'testpass123'
    };

    const signinResponse = await axios.post(`${baseURL}/auth/signin`, signinData);
    console.log('✅ User signin successful!');
    console.log('Welcome back:', signinResponse.data.user.firstName, signinResponse.data.user.lastName);

    console.log('\n🎉 All tests passed! Your auth service is working perfectly.');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data?.message || error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\n💡 Make sure to start your server first:');
      console.log('   npm run start:dev');
    }
    
    if (error.response?.data?.message?.includes('Supabase')) {
      console.log('\n💡 Make sure to update your .env file with real Supabase credentials');
    }
  }
}

testAuth();