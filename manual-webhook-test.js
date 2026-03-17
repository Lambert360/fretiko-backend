const https = require('https');

// Simulate what Flutterwave SHOULD send after a successful payment
const realFlutterwavePayload = {
  "event": "charge.completed",
  "data": {
    "id": "chg_Hq4oBRTJ4r",
    "tx_ref": "your_deposit_id_here", // Replace with actual deposit ID
    "flw_ref": "FLW-MOCK-123456",
    "amount": 1000,
    "currency": "NGN",
    "status": "successful",
    "payment_type": "card",
    "created_at": "2026-03-14T20:21:20.000Z",
    "account_id": 98161,
    "customer": {
      "id": "cus_csm0pcQim4",
      "email": "user@example.com",
      "name": "Test User"
    },
    "processor_response": {
      "code": "00",
      "type": "approved"
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
    'User-Agent': 'Flutterwave-Webhook/1.0'
  }
};

console.log('🔧 Sending manual Flutterwave webhook to Svix...');
console.log(`📡 URL: https://play.svix.com/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/`);
console.log(`💰 Amount: ₦${realFlutterwavePayload.data.amount} ${realFlutterwavePayload.data.currency}`);
console.log(`🎯 Event: ${realFlutterwavePayload.event}`);
console.log(`📝 TX Ref: ${realFlutterwavePayload.data.tx_ref}`);

const req = https.request(options, (res) => {
  console.log(`📊 Status Code: ${res.statusCode}`);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log(`📄 Response: ${data || '(no content)'}`);
    
    if (res.statusCode === 204) {
      console.log('✅ Webhook sent successfully to Svix!');
      console.log('🔍 Check your Svix dashboard - you should see this event');
      console.log('🔍 Check your backend - deposit should complete');
    } else {
      console.log(`❌ Unexpected status: ${res.statusCode}`);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Request failed:', error.message);
});

req.write(JSON.stringify(realFlutterwavePayload));
req.end();

console.log('⏳ Webhook sent...');
