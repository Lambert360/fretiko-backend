// Simplified test - just test signup for now
const axios = require('axios');

async function testSignup() {
  try {
    console.log('🚀 Testing Fretiko Signup...\n');

    const baseURL = 'http://localhost:3000';
    
    // Generate unique email each time
    const timestamp = Date.now();
    const testEmail = `user${timestamp}@gmail.com`;
    
    console.log('Testing signup with email:', testEmail);
    
    const signupData = {
      email: testEmail,
      password: 'testpass123',
      firstName: 'Test',
      lastName: 'User'
    };

    const response = await axios.post(`${baseURL}/auth/signup`, signupData);
    
    console.log('\n✅ Signup successful!');
    console.log('📧 Email:', response.data.user.email);
    console.log('👤 Name:', response.data.user.firstName, response.data.user.lastName);
    console.log('🆔 User ID:', response.data.user.id);
    console.log('🔑 Got access token:', response.data.accessToken ? 'Yes' : 'No');
    console.log('🔄 Got refresh token:', response.data.refreshToken ? 'Yes' : 'No');
    
    console.log('\n🎉 Your auth service is working perfectly!');
    console.log('\n💡 Note: To test signin, you may need to confirm email in Supabase first');
    console.log('   Or disable email confirmation in Supabase → Auth → Settings');

  } catch (error) {
    console.error('\n❌ Test failed:', error.response?.data?.message || error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\n💡 Make sure your server is running: npm run start:dev');
    }
  }
}

testSignup();