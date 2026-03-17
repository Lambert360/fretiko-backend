const http = require('http');

// Test webhook payload (replace with actual from webhook.site)
const testPayload = {
  "event": "charge.completed",
  "data": {
    "id": "chg_test123",
    "tx_ref": "test_deposit_123",
    "flw_ref": "FLW-TEST-123",
    "amount": 1000,
    "currency": "NGN",
    "status": "successful",
    "payment_type": "card",
    "created_at": "2026-03-16T02:00:00.000Z",
    "customer": {
      "id": "cus_test123",
      "email": "test@example.com",
      "name": "Test User"
    }
  }
};

console.log('🔧 Testing webhook forwarding to backend...');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/wallet/webhooks/flutterwave',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'svix-signature': 'test-signature', // This will fail verification but test the endpoint
    'Content-Length': Buffer.byteLength(JSON.stringify(testPayload))
  }
};

const req = http.request(options, (res) => {
  console.log(`📊 Backend response status: ${res.statusCode}`);
  
  let body = '';
  res.on('data', chunk => {
    body += chunk.toString();
  });

  res.on('end', () => {
    console.log('📄 Backend response:', body);
    console.log('✅ Test completed');
  });
});

req.on('error', (error) => {
  console.error('❌ Request failed:', error);
});

req.write(JSON.stringify(testPayload));
req.end();

console.log('📤 Webhook sent to backend');
console.log('🔍 Check backend logs for processing details');
