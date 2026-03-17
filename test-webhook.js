const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = 3001; // Different port to avoid conflicts

// Middleware to capture raw body for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Webhook endpoint
app.post('/wallet/webhooks/flutterwave', (req, res) => {
  console.log('📥 Webhook received!');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  
  const signature = req.headers['flutterwave-signature'];
  const webhookSecret = 'victor1234567';
  
  if (signature) {
    const hash = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody.toString())
      .digest('base64');
    
    console.log('🔐 Signature verification:', hash === signature ? '✅ VALID' : '❌ INVALID');
    console.log('📝 Expected hash:', hash);
    console.log('📝 Received signature:', signature);
  } else {
    console.log('⚠️ No signature provided');
  }
  
  res.status(200).json({ status: 'success', message: 'Webhook received' });
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Test webhook server running' });
});

app.listen(PORT, () => {
  console.log(`🚀 Test webhook server running on port ${PORT}`);
  console.log(`🔗 Test URL: http://localhost:${PORT}/wallet/webhooks/flutterwave`);
  console.log(`📋 Update Svix endpoint to: http://localhost:${PORT}/wallet/webhooks/flutterwave`);
});
