const { Svix } = require('svix');

async function createEndpoint() {
  const svix = new Svix('testsk_wzXcgG3TeKIENCsL6nITYJfYGe8GxoKJ.eu');
  
  try {
    console.log('🔧 Creating endpoint for existing app...');
    
    // Use the existing app ID
    const appId = 'app_3B0WXMzoa9SyAs00D7tLH4zBBzE';
    
    const endpoint = await svix.endpoint.create(appId, {
      url: 'https://webhook.site/0a9e5070-71b4-4cc9-948a-027395193ebb',
      secret: 'whsec_7x2yJj54L7so63Q1W2i7Dw8TtryLmNUV',
      description: 'Flutterwave webhook for Fretiko wallet transactions - TEST',
    });
    
    console.log(`✅ Created endpoint: ${endpoint.id}`);
    console.log(`🔗 Endpoint URL: ${endpoint.url}`);
    console.log(`📋 Svix webhook URL: https://play.svix.com/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/`);
    console.log(`📋 Copy the Svix webhook URL to your Flutterwave dashboard`);
    
  } catch (error) {
    console.error('❌ Endpoint creation failed:', error.message);
    console.error('📋 Full error details:', JSON.stringify(error, null, 2));
    
    // Try to list existing endpoints
    try {
      console.log('🔍 Checking existing endpoints...');
      const appId = 'app_3B0WXMzoa9SyAs00D7tLH4zBBzE';
      const endpoints = await svix.endpoint.list(appId);
      console.log(`📊 Found ${endpoints.data.length} existing endpoints:`);
      
      endpoints.data.forEach((endpoint, index) => {
        console.log(`  ${index + 1}. ID: ${endpoint.id}`);
        console.log(`     URL: ${endpoint.url}`);
        console.log(`     Description: ${endpoint.description}`);
      });
      
      if (endpoints.data.length > 0) {
        const existingEndpoint = endpoints.data[0];
        console.log(`\n✅ Using existing endpoint: ${existingEndpoint.id}`);
        console.log(`🔗 Endpoint URL: ${existingEndpoint.url}`);
        console.log(`📋 Svix webhook URL: https://play.svix.com/in/e_gu28N1N2ZX3RF5u27Qqp4369AVE/`);
        console.log(`📋 Copy the Svix webhook URL to your Flutterwave dashboard`);
      }
    } catch (listError) {
      console.error('❌ Failed to list endpoints:', listError.message);
    }
  }
}

createEndpoint();
