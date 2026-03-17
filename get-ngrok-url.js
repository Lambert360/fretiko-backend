const http = require('http');

// Try to get ngrok URL from their API
async function getNgrokUrl() {
  try {
    console.log('🔧 Checking ngrok status...');
    
    // Try different methods to get ngrok URL
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
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
            const httpTunnel = tunnels.tunnels.find(t => t.proto === 'https');
            if (httpTunnel) {
              resolve(httpTunnel.public_url);
            } else {
              reject(new Error('No HTTPS tunnel found'));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });

    console.log(`✅ Ngrok HTTPS URL: ${response}`);
    return response;
  } catch (error) {
    console.log('❌ Could not get ngrok URL automatically');
    console.log('🔧 Please check ngrok output and manually copy the HTTPS URL');
    console.log('🔧 It should look like: https://random-string.ngrok.io');
    return null;
  }
}

getNgrokUrl();
