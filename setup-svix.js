const { Svix } = require('svix');

async function setupSvix() {
  const svix = new Svix('testsk_wzXcgG3TeKIENCsL6nITYJfYGe8GxoKJ.eu');
  
  try {
    console.log('🚀 Setting up Svix application...');
    
    // Create application
    const app = await svix.application.create({
      name: 'fretiko-mobile',
      uid: 'fretiko-mobile'
    });
    
    console.log(`✅ Created application: ${app.id}`);
    
    // Create endpoint
    const endpoint = await svix.endpoint.create(app.id, {
      url: 'http://localhost:3000/wallet/webhooks/flutterwave',
      secret: 'whsec_7x2yJj54L7so63Q1W2i7Dw8TtryLmNUV',
      description: 'Flutterwave webhook for Fretiko wallet transactions',
    });
    
    console.log(`✅ Created endpoint: ${endpoint.id}`);
    console.log(`🔗 Flutterwave webhook URL: ${endpoint.url}`);
    console.log(`📋 Copy this URL to your Flutterwave dashboard webhook settings`);
    
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    console.error('📋 Full error:', error);
    
    // If app already exists, get existing app
    if (error.message.includes('already exists') || error.message.includes('422') || error.code === 409 || error.message.includes('conflict')) {
      console.log('🔄 Application might already exist, getting details...');
      
      try {
        const apps = await svix.application.list();
        const fretikoApp = apps.data.find(app => app.uid === 'fretiko-mobile');
        
        if (fretikoApp) {
          console.log(`✅ Found existing app: ${fretikoApp.id}`);
          
          const endpoints = await svix.endpoint.list(fretikoApp.id);
          if (endpoints.data.length > 0) {
            const endpoint = endpoints.data[0];
            console.log(`✅ Existing endpoint: ${endpoint.id}`);
            console.log(`🔗 Flutterwave webhook URL: ${endpoint.url}`);
            console.log(`📋 Copy this URL to your Flutterwave dashboard webhook settings`);
          } else {
            console.log('🔧 Creating endpoint for existing app...');
            const newEndpoint = await svix.endpoint.create(fretikoApp.id, {
              url: 'http://localhost:3000/wallet/webhooks/flutterwave',
              secret: 'whsec_7x2yJj54L7so63Q1W2i7Dw8TtryLmNUV',
              description: 'Flutterwave webhook for Fretiko wallet transactions',
            });
            console.log(`✅ Created endpoint: ${newEndpoint.id}`);
            console.log(`🔗 Flutterwave webhook URL: ${newEndpoint.url}`);
            console.log(`📋 Copy this URL to your Flutterwave dashboard webhook settings`);
          }
        } else {
          console.log('❌ No existing app found with UID fretiko-mobile');
        }
      } catch (listError) {
        console.error('❌ Failed to list apps:', listError.message);
      }
    }
  }
}

setupSvix();
