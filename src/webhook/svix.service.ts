import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Svix, Webhook } from 'svix';

@Injectable()
export class SvixService {
  private readonly logger = new Logger(SvixService.name);
  private readonly svix: Svix;

  constructor(private configService: ConfigService) {
    const svixApiKey = this.configService.get<string>('SVIX_API_KEY');
    
    if (!svixApiKey) {
      this.logger.warn('⚠️ SVIX_API_KEY not configured. Svix features will be disabled.');
      return;
    }

    this.svix = new Svix(svixApiKey);
    this.logger.log('✅ Svix service initialized');
  }

  /**
   * Create a new Svix application for webhook management
   */
  async createApplication(name: string, uid?: string) {
    try {
      if (!this.svix) {
        throw new Error('Svix not initialized - missing API key');
      }

      const application = await this.svix.application.create({
        name,
        uid: uid || name.toLowerCase().replace(/\s+/g, '-'),
      });

      this.logger.log(`✅ Svix application created: ${application.id}`);
      return application;
    } catch (error: any) {
      this.logger.error(`❌ Failed to create Svix application: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create a webhook endpoint for an application
   */
  async createWebhookEndpoint(applicationId: string, url?: string) {
    try {
      if (!this.svix) {
        throw new Error('Svix not initialized - missing API key');
      }

      const webhookUrl = url || `${this.configService.get<string>('SVIX_WEBHOOK_URL')}/wallet/webhooks/flutterwave`;
      const webhookSecret = this.configService.get<string>('SVIX_WEBHOOK_SECRET');

      if (!webhookSecret) {
        throw new Error('SVIX_WEBHOOK_SECRET not configured');
      }

      const endpoint = await this.svix.endpoint.create(applicationId, {
        url: webhookUrl,
        secret: webhookSecret,
        description: 'Flutterwave webhook for Fretiko wallet transactions',
        version: 1,
      });

      this.logger.log(`✅ Svix webhook created: ${endpoint.id} -> ${webhookUrl}`);
      return endpoint;
    } catch (error: any) {
      this.logger.error(`❌ Failed to create Svix webhook: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify incoming Flutterwave webhook payload using Flutterwave signature
   */
  async verifyFlutterwaveWebhook(payload: string, signature: string): Promise<boolean> {
    try {
      const webhookSecret = this.configService.get<string>('FLW_WEBHOOK_SECRET');
      
      if (!webhookSecret) {
        this.logger.warn('⚠️ FLW_WEBHOOK_SECRET not configured. Webhook verification skipped.');
        return true; // Allow if not configured (for development)
      }

      if (!signature) {
        this.logger.warn('⚠️ No flutterwave-signature provided in webhook request');
        return false;
      }

      // Use Flutterwave's HMAC-SHA256 signature verification
      const crypto = require('crypto');
      const hash = crypto
        .createHmac('sha256', webhookSecret)
        .update(payload)
        .digest('base64');
      
      const isValid = hash === signature;
      
      if (isValid) {
        this.logger.log('✅ Flutterwave webhook signature verified successfully');
      } else {
        this.logger.error('❌ Flutterwave webhook signature verification failed');
      }
      
      return isValid;
    } catch (error: any) {
      this.logger.error(`❌ Flutterwave webhook verification failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Verify incoming Svix webhook payload using Svix
   */
  async verifyWebhook(payload: string, signature: string): Promise<boolean> {
    try {
      const webhookSecret = this.configService.get<string>('SVIX_WEBHOOK_SECRET');
      
      if (!webhookSecret) {
        this.logger.warn('⚠️ SVIX_WEBHOOK_SECRET not configured. Webhook verification skipped.');
        return true; // Allow if not configured (for development)
      }

      if (!signature) {
        this.logger.warn('⚠️ No signature provided in webhook request');
        return false;
      }

      // Use Svix Webhook for verification
      const wh = new Webhook(webhookSecret);
      const headers = { 'svix-signature': signature };
      wh.verify(payload, headers);
      
      this.logger.log('✅ Svix webhook signature verified successfully');
      return true;
    } catch (error: any) {
      this.logger.error(`❌ Svix webhook signature verification failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get webhook status and details
   */
  async getWebhookStatus(applicationId: string, endpointId: string) {
    try {
      if (!this.svix) {
        throw new Error('Svix not initialized - missing API key');
      }

      const endpoint = await this.svix.endpoint.get(applicationId, endpointId);
      return endpoint;
    } catch (error: any) {
      this.logger.error(`❌ Failed to get webhook status: ${error.message}`);
      throw error;
    }
  }

  /**
   * List all webhooks for an application
   */
  async listWebhooks(applicationId: string) {
    try {
      if (!this.svix) {
        throw new Error('Svix not initialized - missing API key');
      }

      const endpoints = await this.svix.endpoint.list(applicationId);
      return endpoints;
    } catch (error: any) {
      this.logger.error(`❌ Failed to list webhooks: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete a webhook endpoint
   */
  async deleteWebhook(applicationId: string, endpointId: string) {
    try {
      if (!this.svix) {
        throw new Error('Svix not initialized - missing API key');
      }

      await this.svix.endpoint.delete(applicationId, endpointId);
      this.logger.log(`✅ Webhook deleted: ${endpointId}`);
    } catch (error: any) {
      this.logger.error(`❌ Failed to delete webhook: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get application by UID or name
   */
  async getApplication(uid: string) {
    try {
      if (!this.svix) {
        throw new Error('Svix not initialized - missing API key');
      }

      // Try to get by UID first, then by name if that fails
      try {
        const application = await this.svix.application.get(uid);
        return application;
      } catch (uidError) {
        // If UID lookup fails, try listing and finding by name
        const applications = await this.svix.application.list();
        const app = applications.data.find(app => app.uid === uid || app.name === uid);
        
        if (!app) {
          throw new Error(`Application with UID or name '${uid}' not found`);
        }
        
        return app;
      }
    } catch (error: any) {
      this.logger.error(`❌ Failed to get application: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if Svix is properly configured
   */
  isConfigured(): boolean {
    return !!this.svix;
  }

  /**
   * Get webhook retry attempts and status
   */
  async getWebhookAttempts(applicationId: string, endpointId: string) {
    try {
      if (!this.svix) {
        throw new Error('Svix not initialized - missing API key');
      }

      // Use the correct API for message attempts
      const attempts = await this.svix.messageAttempt.listByEndpoint(applicationId, endpointId);
      return attempts;
    } catch (error: any) {
      this.logger.error(`❌ Failed to get webhook attempts: ${error.message}`);
      throw error;
    }
  }
}
