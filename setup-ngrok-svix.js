const { Svix } = require('svix');
const https = require('https');

async function setupNgrokSvix() {
  try {
    // Get ngrok public URL
    console.log('🔧 Getting ngrok public URL...');
    
    const ngrokUrl = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: '127.0.0.1',
        port: 4040,
        path: '/api/tunnels',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const tunnels = JSON.parse(data);
            const httpTunnel = tunnels.tunnels.find(t => t.proto === 'http');
            if (httpTunnel) {
              resolve(httpTunnel.public_url);
            } else {
              reject(new Error('No HTTP tunnel found'));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });

    console.log(`✅ Ngrok URL: ${ngrokUrl}`);
    
    // Update Svix endpoint with ngrok URL
    const svix = new Svix('testsk_wzXcgG3TeKIENCsL6nITYJfYGe8GxoKJ.eu');
    const appId = 'app_3B0WXMzoa9SyAs00D7tLH4zBBzE';
    const endpointId = 'ep_3B0X7SaiwrDGqWxJIHE9FqhRlQz';
    
    console.log('🔧 Updating Svix endpoint with ngrok URL...');
    
    const updatedEndpoint = await svix.endpoint.update(appId, endpointId, {
      url: `${ngrokUrl}/wallet/webhooks/flutterwave`,
      secret: 'whsec_7x2yJj54L7so63Q1W2i7Dw8TtryLmNUV',
      description: 'Flutterwave webhook for Fretiko wallet transactions - NGROK',
    });
    
    console.log(`✅ Updated Svix endpoint: ${updatedEndpoint.id}`);
    console.log(`🔗 Endpoint URL: ${updatedEndpoint.url}`);
    console.log(`📋 Svix webhook URL: https://play.svix.com/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/`);
    console.log(`\n🎯 SETUP COMPLETE!`);
    console.log(`1. Flutterwave webhook URL: https://play.svix.com/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/`);
    console.log(`2. Svix will forward webhooks to: ${updatedEndpoint.url}`);
    console.log(`3. Test a deposit - it should work now!`);
    
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    console.log('\n🔧 Make sure ngrok is running: ngrok http 3000');
    console.log('🔧 Then run this script again');
  }
}

setupNgrokSvix();
