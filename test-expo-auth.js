// Test script for Expo SDK 54 authentication issues
// Run this with: node test-expo-auth.js

const axios = require('axios');

// API Configuration
const API_CONFIG = {
  BASE_URL: 'http://192.168.43.135:3000',
  TIMEOUT: 30000,
};

// Create axios instance
const api = axios.create({
  baseURL: API_CONFIG.BASE_URL,
  timeout: API_CONFIG.TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
  },
});

async function testConnection() {
  console.log('🔍 Testing backend connection...');
  try {
    const response = await api.get('/');
    console.log('✅ Backend connection successful:', response.data);
    return true;
  } catch (error) {
    console.error('❌ Backend connection failed:', error.message);
    return false;
  }
}

async function testSignup() {
  console.log('🔍 Testing signup endpoint...');
  try {
    const testUser = {
      email: `testuser${Date.now()}@test.com`,
      password: 'test123456',
      firstName: 'Test',
      lastName: 'User'
    };

    const response = await api.post('/auth/signup', testUser);
    console.log('✅ Signup successful!');
    console.log('📋 Response structure:', Object.keys(response.data));
    console.log('🔑 Has accessToken:', !!response.data.accessToken);
    console.log('🔑 Has refreshToken:', !!response.data.refreshToken);
    console.log('👤 Has user:', !!response.data.user);

    if (response.data.accessToken) {
      console.log('🔍 Token length:', response.data.accessToken.length);
      console.log('🔍 Token starts with:', response.data.accessToken.substring(0, 20) + '...');
    }

    return response.data;
  } catch (error) {
    console.error('❌ Signup failed:', error.response?.data?.message || error.message);
    return null;
  }
}

async function testSignin() {
  console.log('🔍 Testing signin endpoint...');
  try {
    const credentials = {
      email: 'test@test.com',
      password: 'test123'
    };

    const response = await api.post('/auth/signin', credentials);
    console.log('✅ Signin successful!');
    console.log('📋 Response structure:', Object.keys(response.data));
    console.log('🔑 Has accessToken:', !!response.data.accessToken);
    console.log('🔑 Has refreshToken:', !!response.data.refreshToken);
    console.log('👤 Has user:', !!response.data.user);

    if (response.data.accessToken) {
      console.log('🔍 Token length:', response.data.accessToken.length);
      console.log('🔍 Token starts with:', response.data.accessToken.substring(0, 20) + '...');
    }

    return response.data;
  } catch (error) {
    console.error('❌ Signin failed:', error.response?.data?.message || error.message);
    return null;
  }
}

async function testAuthenticatedRequest(accessToken) {
  console.log('🔍 Testing authenticated request...');
  try {
    const response = await api.get('/users/profile', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    console.log('✅ Authenticated request successful!');
    return true;
  } catch (error) {
    console.error('❌ Authenticated request failed:', error.response?.data?.message || error.message);
    return false;
  }
}

async function runTests() {
  console.log('🚀 Starting Expo SDK 54 Authentication Tests...\n');

  // Test 1: Backend connection
  const connected = await testConnection();
  if (!connected) {
    console.log('❌ Cannot proceed - backend is not running');
    return;
  }

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 2: Signup
  const signupResult = await testSignup();

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 3: Signin
  const signinResult = await testSignin();

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 4: Authenticated request (if we have a token)
  if (signupResult?.accessToken) {
    await testAuthenticatedRequest(signupResult.accessToken);
  } else if (signinResult?.accessToken) {
    await testAuthenticatedRequest(signinResult.accessToken);
  } else {
    console.log('⚠️  No access token available for authenticated request test');
  }

  console.log('\n' + '='.repeat(50) + '\n');
  console.log('🎯 Test Summary:');
  console.log(`  Backend Connection: ${connected ? '✅' : '❌'}`);
  console.log(`  Signup: ${signupResult ? '✅' : '❌'}`);
  console.log(`  Signin: ${signinResult ? '✅' : '❌'}`);
  console.log(`  Token Available: ${(signupResult?.accessToken || signinResult?.accessToken) ? '✅' : '❌'}`);
}

// Run the tests
runTests().catch(console.error);