import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class LogisticsNotificationService {
  private readonly logger = new Logger(LogisticsNotificationService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Send company application received email
   */
  async sendCompanyApplicationReceived(email: string, companyName: string, trackingId: string): Promise<void> {
    this.logger.log(`Sending application received email to ${email}`);

    const subject = `Your Fretiko Partnership Application Has Been Received`;
    const htmlBody = this.generateApplicationReceivedEmailContent(companyName, trackingId);

    try {
      const resendApiKey = this.configService.get<string>('RESEND_API_KEY');
      const resendFromEmail = this.configService.get<string>('RESEND_FROM_EMAIL');

      if (!resendApiKey || !resendFromEmail) {
        this.logger.error('Missing Resend configuration for logistics email');
        return;
      }

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: resendFromEmail,
          to: [email],
          subject,
          html: htmlBody,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const result = await response.json();
        this.logger.error('Failed to send application received email via Resend:', result);
        return;
      }

      this.logger.log(`Application received email sent to ${email}`);
    } catch (error) {
      this.logger.error('Error sending application received email:', error);
    }
  }

  private generateApplicationReceivedEmailContent(companyName: string, trackingId: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Fretiko Partnership Application</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #000; color: white; padding: 20px; text-align: center; }
          .content { padding: 30px 20px; background: #f9f9f9; }
          .tracking-id { background: #e8f5e8; padding: 15px; margin: 20px 0; text-align: center; }
          .tracking-id strong { font-size: 24px; color: #34c759; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚚 Fretiko Logistics Partnership</h1>
          </div>
          <div class="content">
            <h2>Thank you for your interest in partnering with Fretiko!</h2>
            <p>Dear <strong>${companyName}</strong>,</p>
            <p>We have received your partnership application. Your application is now being reviewed by our team.</p>
            
            <div class="tracking-id">
              <p>Your Tracking ID:</p>
              <strong>${trackingId}</strong>
            </div>
            
            <p><strong>What happens next?</strong></p>
            <ul>
              <li>Our team will review your application within 3-5 business days</li>
              <li>You can track your application status using the tracking ID above</li>
              <li>You'll receive an email notification when there's an update</li>
            </ul>
            
            <p>If you have any questions, please contact us at partnerships@fretiko.com</p>
          </div>
          <div class="footer">
            <p>&copy; 2026 Fretiko. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Send company under review email
   */
  async sendCompanyUnderReview(email: string, companyName: string): Promise<void> {
    this.logger.log(`Sending under review email to ${email}`);

    const subject = `Your Fretiko Partnership Application is Under Review`;
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Application Under Review</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #000; color: white; padding: 20px; text-align: center; }
          .content { padding: 30px 20px; background: #f9f9f9; }
          .status { background: #fff3e0; padding: 15px; margin: 20px 0; text-align: center; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚚 Fretiko Logistics Partnership</h1>
          </div>
          <div class="content">
            <h2>Application Status Update</h2>
            <p>Dear <strong>${companyName}</strong>,</p>
            <p>Your partnership application is now under review by our verification team.</p>
            
            <div class="status">
              <p><strong>Status:</strong> Under Review</p>
              <p>We're currently verifying your documents and business information.</p>
            </div>
            
            <p>This process typically takes 3-5 business days. You'll receive another email once a decision has been made.</p>
          </div>
          <div class="footer">
            <p>&copy; 2024 Fretiko. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const { error } = await this.supabase.functions.invoke('send-email', {
        body: {
          to: email,
          subject,
          htmlBody,
        },
      });

      if (error) {
        this.logger.error('Failed to send under review email:', error);
        throw error;
      }

      this.logger.log(`Under review email sent to ${email}`);
    } catch (error) {
      this.logger.error('Error sending under review email:', error);
    }
  }

  /**
   * Send company verified email with password setup instructions
   */
  async sendCompanyVerifiedWithPasswordSetup(email: string, companyName: string, username: string): Promise<void> {
    this.logger.log(`Sending verification email with password setup to ${email}`);

    const subject = `🎉 Welcome to Fretiko! Set Up Your Partner Dashboard Access`;
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Partner Dashboard Access</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { padding: 30px 20px; background: #f9f9f9; border-radius: 0 0 10px 10px; }
          .success { background: #ECFDF5; border: 2px solid #10B981; padding: 20px; margin: 20px 0; border-radius: 8px; text-align: center; }
          .credentials { background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 20px; margin: 20px 0; border-radius: 4px; }
          .steps { background: #F3F4F6; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .steps ol { margin: 0; padding-left: 20px; }
          .steps li { margin: 10px 0; }
          .username { background: #f0f0f0; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; color: #10B981; border-radius: 5px; margin: 15px 0; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; background: #F9FAFB; border-radius: 10px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚚 Fretiko Logistics Partner</h1>
            <p>Welcome to the Partner Network!</p>
          </div>
          <div class="content">
            <h2>Your Partnership Application Has Been Approved!</h2>
            <p>Dear <strong>${companyName}</strong>,</p>
            <p>We are thrilled to welcome you to the Fretiko logistics network!</p>
            
            <div class="success">
              <p><strong>✅ Application Status: Approved</strong>
              <p>Your company is now a verified Fretiko logistics partner.</p>
            </div>
            
            <div class="credentials">
              <h3>🔑 Your Partner Dashboard Credentials</h3>
              <p>Your partner dashboard username is:</p>
              <div class="username">${username}</div>
              <p><strong>⚠️ Important:</strong> You need to set up your password before accessing the dashboard.</p>
            </div>

            <div class="steps">
              <h3>📋 To Set Up Your Password:</h3>
              <ol>
                <li>Go to the Fretiko Partner Dashboard login page</li>
                <li>Enter your username: <strong>${username}</strong></li>
                <li>Click "Forgot Password" to set up your password</li>
                <li>Enter your email address (${email}) to receive a password reset code</li>
                <li>Use the code to set your secure password</li>
                <li>Login to your dashboard and start managing your logistics operations</li>
              </ol>
            </div>
            
            <div class="steps">
              <h3>🚀 What's Next?</h3>
              <ol>
                <li><strong>Set Up Your Password:</strong> Follow the steps above to secure your account</li>
                <li><strong>Access Partner Dashboard:</strong> Monitor your analytics and manage riders</li>
                <li><strong>Onboard Your Riders:</strong> Have your riders download the Fretiko mobile app</li>
                <li><strong>Start Receiving Orders:</strong> You'll begin receiving delivery requests</li>
              </ol>
            </div>
            
            <p>Welcome aboard! We're excited to grow together with you.</p>
          </div>
          <div class="footer">
            <p>© 2026 Fretiko. All rights reserved.</p>
            <p>This is an automated message. Please do not reply to this email.</p>
            <p>Fretiko Logistics Partner Portal</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const resendApiKey = this.configService.get<string>('RESEND_API_KEY');
      const resendFromEmail = this.configService.get<string>('RESEND_FROM_EMAIL');

      if (!resendApiKey || !resendFromEmail) {
        this.logger.error('Missing Resend configuration for logistics email');
        return;
      }

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: resendFromEmail,
          to: [email],
          subject,
          html: htmlBody,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const result = await response.json();
        this.logger.error('Failed to send verification email via Resend:', result);
        return;
      }

      this.logger.log(`Verification email with password setup sent to ${email}`);
    } catch (error) {
      this.logger.error('Error sending verification email:', error);
    }
  }

  /**
   * Send company rejected email
   */
  async sendCompanyRejected(email: string, companyName: string, reason: string): Promise<void> {
    this.logger.log(`Sending rejection email to ${email}`);

    const subject = `Regarding Your Fretiko Partnership Application`;
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Application Not Approved</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ff3b30; color: white; padding: 20px; text-align: center; }
          .content { padding: 30px 20px; background: #f9f9f9; }
          .rejection { background: #ffe8e8; padding: 20px; margin: 20px 0; text-align: center; }
          .reason { background: #f0f0f0; padding: 20px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Application Update</h1>
          </div>
          <div class="content">
            <h2>Regarding Your Partnership Application</h2>
            <p>Dear <strong>${companyName}</strong>,</p>
            <p>Thank you for your interest in partnering with Fretiko.</p>
            <p>After careful review, we regret to inform you that your application was not approved at this time.</p>
            
            <div class="rejection">
              <p><strong>❌ Application Status: Not Approved</strong></p>
            </div>
            
            <div class="reason">
              <h3>Reason for Rejection:</h3>
              <p><em>${reason}</em></p>
            </div>
            
            <p>We encourage you to address the mentioned points and consider reapplying in the future.</p>
            <p>We appreciate your understanding and wish you the best in your logistics endeavors.</p>
          </div>
          <div class="footer">
            <p>&copy; 2024 Fretiko. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const { error } = await this.supabase.functions.invoke('send-email', {
        body: {
          to: email,
          subject,
          htmlBody,
        },
      });

      if (error) {
        this.logger.error('Failed to send rejection email:', error);
        throw error;
      }

      this.logger.log(`Rejection email sent to ${email}`);
    } catch (error) {
      this.logger.error('Error sending rejection email:', error);
    }
  }

  /**
   * Send rider verification under review email
   */
  async sendRiderUnderReview(email: string, riderName: string): Promise<void> {
    this.logger.log(`Sending rider under review email to ${email}`);

    const subject = `Your Fretiko Rider Verification is Under Review`;
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Fretiko Rider Verification</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #000; color: white; padding: 20px; text-align: center; }
          .content { padding: 30px 20px; background: #f9f9f9; }
          .status { background: #fff3cd; padding: 20px; margin: 20px 0; text-align: center; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚚 Fretiko Rider Verification</h1>
          </div>
          <div class="content">
            <h2>Your Verification is Under Review</h2>
            <p>Dear <strong>${riderName}</strong>,</p>
            <p>Thank you for submitting your rider verification. Your application is now being reviewed by our team.</p>
            
            <div class="status">
              <p><strong>⏳ Verification Status: Under Review</strong></p>
              <p>We'll review your documents and get back to you within 2-3 business days.</p>
            </div>
            
            <p><strong>What happens next?</strong></p>
            <ul>
              <li>Our team will review your submitted documents</li>
              <li>We'll verify your information and vehicle details</li>
              <li>You'll receive an email with the verification decision</li>
            </ul>
            
            <p>If you have any questions, feel free to contact our support team.</p>
          </div>
          <div class="footer">
            <p>&copy; 2024 Fretiko. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const { error } = await this.supabase.functions.invoke('send-email', {
        body: {
          to: email,
          subject,
          htmlBody,
        },
      });

      if (error) {
        this.logger.error(`Failed to send rider under review email: ${error.message}`);
      } else {
        this.logger.log(`Rider under review email sent to ${email}`);
      }
    } catch (error) {
      this.logger.error(`Exception in sendRiderUnderReview: ${error.message}`);
    }
  }

  /**
   * Send rider verification received email
   */
  async sendRiderApplicationReceived(email: string, riderName: string): Promise<void> {
    this.logger.log(`Sending rider verification received email to ${email}`);

    const subject = `Your Fretiko Rider Verification Has Been Received`;
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Rider Verification Received</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #007aff; color: white; padding: 20px; text-align: center; }
          .content { padding: 30px 20px; background: #f9f9f9; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🏍️ Fretiko Rider Verification</h1>
          </div>
          <div class="content">
            <h2>Verification Request Received</h2>
            <p>Dear <strong>${riderName}</strong>,</p>
            <p>We have received your rider verification request. Your application is now being reviewed by our verification team.</p>
            
            <p><strong>What happens next?</strong></p>
            <ul>
              <li>Our team will review your documents and information</li>
              <li>Verification typically takes 1-3 business days</li>
              <li>You'll receive an email notification once a decision has been made</li>
              <li>You can check your status in the Fretiko mobile app</li>
            </ul>
            
            <p>If you have any questions, please contact us at riders@fretiko.com</p>
          </div>
          <div class="footer">
            <p>&copy; 2024 Fretiko. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const { error } = await this.supabase.functions.invoke('send-email', {
        body: {
          to: email,
          subject,
          htmlBody,
        },
      });

      if (error) {
        this.logger.error('Failed to send rider verification received email:', error);
        throw error;
      }

      this.logger.log(`Rider verification received email sent to ${email}`);
    } catch (error) {
      this.logger.error('Error sending rider verification received email:', error);
    }
  }

  /**
   * Send rider verified email
   */
  async sendRiderVerified(email: string, riderName: string): Promise<void> {
    this.logger.log(`Sending rider verification email to ${email}`);

    const subject = `✅ Congratulations! Your Rider Verification Has Been Approved`;
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Rider Verification Approved</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #34c759; color: white; padding: 20px; text-align: center; }
          .content { padding: 30px 20px; background: #f9f9f9; }
          .success { background: #e8f5e8; padding: 20px; margin: 20px 0; text-align: center; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Congratulations!</h1>
            <p>You're Now a Verified Fretiko Rider</p>
          </div>
          <div class="content">
            <h2>Your Rider Verification Has Been Approved!</h2>
            <p>Dear <strong>${riderName}</strong>,</p>
            <p>Congratulations! You are now a verified rider on the Fretiko platform.</p>
            
            <div class="success">
              <p><strong>✅ Verification Status: Approved</strong></p>
              <p>You can now start receiving delivery requests through the Fretiko app.</p>
            </div>
            
            <p><strong>What's next?</strong></p>
            <ul>
              <li>Start accepting delivery requests in your area</li>
              <li>Build your reputation with excellent service</li>
              <li>Track your earnings and performance in the app</li>
              <li>Grow your business with the Fretiko network</li>
            </ul>
            
            <p>Welcome to the team! We're excited to have you on board.</p>
          </div>
          <div class="footer">
            <p>&copy; 2024 Fretiko. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const { error } = await this.supabase.functions.invoke('send-email', {
        body: {
          to: email,
          subject,
          htmlBody,
        },
      });

      if (error) {
        this.logger.error('Failed to send rider verification email:', error);
        throw error;
      }

      this.logger.log(`Rider verification email sent to ${email}`);
    } catch (error) {
      this.logger.error('Error sending rider verification email:', error);
    }
  }

  /**
   * Send rider rejected email
   */
  async sendRiderRejected(email: string, riderName: string, reason: string): Promise<void> {
    this.logger.log(`Sending rider rejection email to ${email}`);

    const subject = `Regarding Your Fretiko Rider Verification`;
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Rider Verification Not Approved</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ff3b30; color: white; padding: 20px; text-align: center; }
          .content { padding: 30px 20px; background: #f9f9f9; }
          .rejection { background: #ffe8e8; padding: 20px; margin: 20px 0; text-align: center; }
          .reason { background: #f0f0f0; padding: 20px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Verification Update</h1>
          </div>
          <div class="content">
            <h2>Regarding Your Rider Verification</h2>
            <p>Dear <strong>${riderName}</strong>,</p>
            <p>Thank you for your interest in becoming a verified Fretiko rider.</p>
            <p>After careful review, we regret to inform you that your verification request was not approved at this time.</p>
            
            <div class="rejection">
              <p><strong>❌ Verification Status: Not Approved</strong></p>
            </div>
            
            <div class="reason">
              <h3>Reason for Rejection:</h3>
              <p><em>${reason}</em></p>
            </div>
            
            <p>We encourage you to address the mentioned points and consider reapplying in the future.</p>
            <p>If you have any questions about this decision, please contact us at riders@fretiko.com</p>
          </div>
          <div class="footer">
            <p>&copy; 2024 Fretiko. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const { error } = await this.supabase.functions.invoke('send-email', {
        body: {
          to: email,
          subject,
          htmlBody,
        },
      });

      if (error) {
        this.logger.error('Failed to send rider rejection email:', error);
        throw error;
      }

      this.logger.log(`Rider rejection email sent to ${email}`);
    } catch (error) {
      this.logger.error('Error sending rider rejection email:', error);
    }
  }
}
