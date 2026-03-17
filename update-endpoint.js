const { Svix } = require('svix');

async function updateEndpoint() {
  const svix = new Svix('testsk_wzXcgG3TeKIENCsL6nITYJfYGe8GxoKJ.eu');
  
  try {
    console.log('🔧 Updating endpoint to point to local backend...');
    
    // Use the existing app ID
    const appId = 'app_3B0WXMzoa9SyAs00D7tLH4zBBzE';
    const endpointId = 'ep_3B0X7SaiwrDGqWxJIHE9FqhRlQz';
    
    // For local development, we'll use a workaround
    // Update endpoint to use production URL
    const updatedEndpoint = await svix.endpoint.update(appId, endpointId, {
      url: 'https://your-production-api.com/wallet/webhooks/flutterwave',
      secret: 'whsec_7x2yJj54L7so63Q1W2i7Dw8TtryLmNUV',
      description: 'Flutterwave webhook for Fretiko wallet transactions',
    });
    
    console.log(`✅ Updated endpoint: ${updatedEndpoint.id}`);
    console.log(`🔗 Endpoint URL: ${updatedEndpoint.url}`);
    console.log(`📋 Svix webhook URL: https://play.svix.com/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/`);
    console.log(`📋 Update this URL in your Flutterwave dashboard`);
    
    console.log(`\n🎯 NEXT STEPS:`);
    console.log(`1. Go to Flutterwave dashboard`);
    console.log(`2. Set webhook URL to: https://play.svix.com/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/`);
    console.log(`3. Make a test deposit`);
    console.log(`4. Check webhook.site for incoming webhooks`);
    console.log(`5. Manually forward webhook to your backend for testing`);
    
  } catch (error) {
    console.error('❌ Endpoint update failed:', error.message);
    console.error('📋 Full error details:', JSON.stringify(error, null, 2));
  }
}

updateEndpoint();
