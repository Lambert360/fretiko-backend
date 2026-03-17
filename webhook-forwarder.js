const http = require('http');
const https = require('https');

// This script will forward webhooks from webhook.site to your backend
console.log('🔧 Setting up webhook forwarding...');

// Create a simple server that forwards requests to your backend
const server = http.createServer((req, res) => {
  console.log('📥 Received webhook request');
  console.log(`📊 Method: ${req.method}`);
  console.log(`🔗 URL: ${req.url}`);
  console.log(`📋 Headers:`, req.headers);

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    console.log('📄 Body:', body);

    // Forward to your backend
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/wallet/webhooks/flutterwave',
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'svix-signature': req.headers['svix-signature'] || '',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const proxyReq = http.request(options, (proxyRes) => {
      console.log(`📤 Backend response status: ${proxyRes.statusCode}`);
      
      let proxyBody = '';
      proxyRes.on('data', chunk => {
        proxyBody += chunk.toString();
      });

      proxyRes.on('end', () => {
        console.log('📄 Backend response:', proxyBody);
        
        // Send response back to webhook.site
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(proxyBody)
        });
        res.end(proxyBody);
      });
    });

    proxyReq.on('error', (error) => {
      console.error('❌ Proxy request failed:', error);
      res.writeHead(500);
      res.end('Proxy request failed');
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`🚀 Webhook forwarder running on port ${PORT}`);
  console.log(`📋 Update your webhook.site endpoint to: http://localhost:3001/webhook`);
  console.log(`🔗 Or use ngrok to expose this port publicly`);
});

// For testing with webhook.site, you'll need to:
// 1. Use ngrok: ngrok http 3001
// 2. Update the Svix endpoint to use the ngrok HTTPS URL
// 3. Test the full flow
