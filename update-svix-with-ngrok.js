const { Svix } = require('svix');

async function updateSvixWithNgrok() {
  // Get ngrok URL from user input
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('🔧 Update Svix Endpoint with Ngrok URL');
  console.log('');
  console.log('📋 First, run: ngrok http 3000');
  console.log('📋 Copy the HTTPS URL from ngrok output');
  console.log('📋 It should look like: https://random-string.ngrok.io');
  console.log('');

  return new Promise((resolve) => {
    rl.question('🔗 Enter your ngrok HTTPS URL: ', async (ngrokUrl) => {
      if (!ngrokUrl) {
        console.log('❌ No URL provided');
        rl.close();
        return;
      }

      try {
        const svix = new Svix('testsk_wzXcgG3TeKIENCsL6nITYJfYGe8GxoKJ.eu');
        const appId = 'app_3B0WXMzoa9SyAs00D7tLH4zBBzE';
        const endpointId = 'ep_3B0X7SaiwrDGqWxJIHE9FqhRlQz';
        
        console.log(`🔧 Updating Svix endpoint with: ${ngrokUrl}`);
        
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
        console.error('❌ Update failed:', error.message);
      }
      
      rl.close();
      resolve();
    });
  });
}

updateSvixWithNgrok();
