#!/usr/bin/env ts-node

/**
 * Svix Webhook Setup Script
 * 
 * This script sets up Svix webhooks for Flutterwave integration
 * It creates the application and webhook endpoints needed for
 * reliable webhook processing
 */

import { ConfigService } from '@nestjs/config';
import { SvixService } from '../src/webhook/svix.service';

async function setupWebhooks() {
  console.log('🚀 Starting Svix webhook setup for Fretiko wallet...');
  
  try {
    // Initialize configuration
    const configService = new ConfigService();
    const svixService = new SvixService(configService);
    
    // Check if Svix is configured
    if (!svixService.isConfigured()) {
      console.error('❌ Svix not configured. Please set SVIX_API_KEY in your environment.');
      console.log('💡 Get your API key from: https://dashboard.svix.com/');
      process.exit(1);
    }
    
    console.log('✅ Svix service initialized');
    
    // Create application
    const appName = 'fretiko-wallet';
    const appUid = 'fretiko-wallet';
    
    console.log(`📱 Creating Svix application: ${appName}`);
    
    try {
      const application = await svixService.createApplication(appName, appUid);
      console.log(`✅ Application created: ${application.id} (${application.name})`);
      
      // Create webhook endpoint
      const webhookUrl = `${configService.get<string>('API_URL') || 'http://localhost:3000'}/wallet/webhooks/flutterwave`;
      
      console.log(`🔗 Creating webhook endpoint: ${webhookUrl}`);
      
      const webhook = await svixService.createWebhookEndpoint(application.id, webhookUrl);
      
      console.log(`✅ Webhook created successfully!`);
      console.log(`📡 Webhook URL: ${webhook.url}`);
      console.log(`🔑 Webhook ID: ${webhook.id}`);
      console.log(`📝 Webhook Description: ${webhook.description}`);
      
      // Display webhook secret (for Flutterwave configuration)
      const webhookSecret = configService.get<string>('SVIX_WEBHOOK_SECRET');
      if (webhookSecret) {
        console.log(`🔐 Webhook Secret: ${webhookSecret.substring(0, 10)}...${webhookSecret.substring(webhookSecret.length - 5)}`);
        console.log(`💡 Use this secret in your Flutterwave webhook configuration`);
      }
      
      // Test webhook endpoint
      console.log(`🧪 Testing webhook endpoint accessibility...`);
      
      const testUrl = webhook.url;
      const testResponse = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (testResponse.ok) {
        const testResult = await testResponse.json();
        console.log(`✅ Webhook endpoint is accessible: ${testResult.message}`);
      } else {
        console.warn(`⚠️ Webhook endpoint returned status: ${testResponse.status}`);
        console.log(`💡 Make sure your server is running and accessible at: ${configService.get<string>('API_URL')}`);
      }
      
      // List all webhooks for verification
      console.log(`📋 Listing all webhooks for application...`);
      
      const webhooks = await svixService.listWebhooks(application.id);
      
      console.log(`📊 Total webhooks: ${webhooks.data.length}`);
      webhooks.data.forEach((wh, index) => {
        console.log(`  ${index + 1}. ${wh.description || 'No description'} (${wh.url})`);
      });
      
      console.log(`\n🎉 Svix webhook setup completed successfully!`);
      console.log(`\n📝 Next steps:`);
      console.log(`1. Update your Flutterwave dashboard with the webhook URL: ${webhookUrl}`);
      console.log(`2. Use the webhook secret for signature verification`);
      console.log(`3. Test webhook delivery with a sample transaction`);
      console.log(`4. Monitor webhook delivery in the Svix dashboard`);
      
    } catch (error: any) {
      if (error.message.includes('already exists')) {
        console.log(`ℹ️ Application '${appName}' already exists. Checking webhooks...`);
        
        // Get existing application
        const existingApp = await svixService.getApplication(appUid);
        console.log(`✅ Found existing application: ${existingApp.name}`);
        
        // List existing webhooks
        const existingWebhooks = await svixService.listWebhooks(existingApp.id);
        
        if (existingWebhooks.data.length > 0) {
          console.log(`📋 Existing webhooks:`);
          existingWebhooks.data.forEach((wh, index) => {
            console.log(`  ${index + 1}. ${wh.description || 'No description'} (${wh.url})`);
          });
          
          console.log(`\n💡 If you need to update the webhook URL, delete the existing endpoint first:`);
          console.log(`   svix endpoint delete ${existingApp.id} <endpoint-id>`);
        } else {
          console.log(`ℹ️ No existing webhooks found. Creating new one...`);
          
          const currentWebhookUrl = `${configService.get<string>('API_URL') || 'http://localhost:3000'}/wallet/webhooks/flutterwave`;
          const webhook = await svixService.createWebhookEndpoint(existingApp.id, currentWebhookUrl);
          console.log(`✅ New webhook created: ${webhook.url}`);
        }
      } else {
        throw error;
      }
    }
    
  } catch (error: any) {
    console.error('❌ Webhook setup failed:', error.message);
    
    if (error.message.includes('401')) {
      console.log(`💡 Authentication failed. Please check your SVIX_API_KEY.`);
      console.log(`   Get your API key from: https://dashboard.svix.com/`);
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
      console.log(`💡 Network error. Please check your internet connection.`);
    } else if (error.message.includes('SVIX_WEBHOOK_SECRET')) {
      console.log(`💡 Please set SVIX_WEBHOOK_SECRET in your environment variables.`);
    } else {
      console.log(`💡 Check the error message above and try again.`);
    }
    
    process.exit(1);
  }
}

// Run the setup
if (require.main === module) {
  setupWebhooks()
    .then(() => {
      console.log('\n✅ Setup completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Setup failed:', error);
      process.exit(1);
    });
}

export { setupWebhooks };
