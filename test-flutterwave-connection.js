const https = require('https');

// Test if Flutterwave can reach your Svix endpoint
const testSvixEndpoint = 'https://play.svix.com/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/';

// Sample webhook payload (what Flutterwave would send)
const samplePayload = {
  "event": "charge.completed",
  "data": {
    "id": "test_123456",
    "tx_ref": "test_tx_123456",
    "status": "successful",
    "amount": 1000,
    "currency": "NGN",
    "customer": {
      "email": "test@example.com"
    }
  }
};

const options = {
  hostname: 'play.svix.com',
  port: 443,
  path: '/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Flutterwave-Webhook-Test'
  }
};

console.log('🔍 Testing Flutterwave → Svix connection...');
console.log(`📡 Sending test webhook to: ${testSvixEndpoint}`);

const req = https.request(options, (res) => {
  console.log(`📊 Status Code: ${res.statusCode}`);
  console.log(`📋 Headers:`, res.headers);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log(`📄 Response Body: ${data}`);
    
    if (res.statusCode === 200) {
      console.log('✅ Svix endpoint is reachable!');
    } else {
      console.log(`❌ Unexpected status: ${res.statusCode}`);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Connection failed:', error.message);
});

req.write(JSON.stringify(samplePayload));
req.end();

console.log('⏳ Waiting for response...');
