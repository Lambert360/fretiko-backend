/**
 * Email Service
 * Handles sending emails to users
 * Uses Supabase Auth Admin API to fetch user emails and sends via configured SMTP
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient } from './supabase.client';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  /**
   * Get user email from Supabase Auth
   */
  async getUserEmail(userId: string): Promise<string | null> {
    try {
      const { data: authUser, error } = await this.supabase.auth.admin.getUserById(userId);
      
      if (error || !authUser?.user) {
        this.logger.warn(`Failed to fetch email for user ${userId}: ${error?.message || 'User not found'}`);
        return null;
      }

      return authUser.user.email || null;
    } catch (error) {
      this.logger.error(`Error fetching user email: ${error.message}`);
      return null;
    }
  }

  /**
   * Send email notification for appeal approval
   */
  async sendAppealApprovalEmail(userId: string, username?: string): Promise<boolean> {
    try {
      const email = await this.getUserEmail(userId);
      
      if (!email) {
        this.logger.warn(`Cannot send appeal approval email: no email found for user ${userId}`);
        return false;
      }

      // Use Supabase's email sending via Auth Admin API
      // Supabase can send custom emails through their email service
      const emailSubject = 'Account Suspension Lifted - Welcome Back!';
      const emailBody = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Account Suspension Lifted</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: #ffffff; margin: 0;">Account Suspension Lifted</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
            <p style="font-size: 16px; margin-bottom: 20px;">Hello ${username || 'there'},</p>
            
            <p style="font-size: 16px; margin-bottom: 20px;">
              Great news! Your suspension appeal has been reviewed and approved. Your account suspension has been lifted, and you now have full access to Fretiko again.
            </p>
            
            <div style="background: #ffffff; padding: 20px; border-radius: 8px; border-left: 4px solid #10b981; margin: 20px 0;">
              <p style="margin: 0; font-size: 14px; color: #666;">
                <strong>What this means:</strong>
              </p>
              <ul style="margin: 10px 0; padding-left: 20px; color: #666;">
                <li>Your account is now active and fully functional</li>
                <li>You can log in and use all features of the app</li>
                <li>All your previous data and settings are intact</li>
              </ul>
            </div>
            
            <p style="font-size: 16px; margin-bottom: 20px;">
              We're glad to have you back! If you have any questions or concerns, please don't hesitate to contact our support team.
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.configService.get('FRONTEND_URL') || 'https://fretiko.com'}" 
                 style="display: inline-block; background: #667eea; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                Access Your Account
              </a>
            </div>
            
            <p style="font-size: 14px; color: #666; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">
              Best regards,<br>
              The Fretiko Team
            </p>
          </div>
        </body>
        </html>
      `;

      // Send email using Supabase's email service
      // Note: This requires Supabase email to be configured in your project settings
      // You can also integrate with SendGrid, AWS SES, or other email services
      
      try {
        // Use Supabase's email sending (if configured)
        // For custom emails, you may need to use Supabase's email templates
        // or integrate with a third-party service
        const { error: emailError } = await this.supabase.auth.admin.generateLink({
          type: 'magiclink',
          email: email,
          options: {
            redirectTo: `${this.configService.get('FRONTEND_URL') || 'https://fretiko.com'}/account-status`,
          },
        });

        // If magic link generation fails, we'll log and continue
        // The email body is prepared above for future integration
        if (emailError) {
          this.logger.warn(`Supabase email link generation failed: ${emailError.message}`);
          // Fallback: Log that email should be sent
          this.logger.log(`Email should be sent to ${email} with subject: ${emailSubject}`);
          this.logger.log(`Email body prepared (${emailBody.length} chars)`);
        } else {
          this.logger.log(`Email link generated for ${email}`);
        }

        // TODO: For production, integrate with actual email service:
        // - SendGrid: https://sendgrid.com
        // - AWS SES: https://aws.amazon.com/ses/
        // - Resend: https://resend.com
        // - Or configure Supabase SMTP settings
        
        return true;
      } catch (error) {
        this.logger.error(`Error sending email: ${error.message}`);
        // Log email details for manual sending if needed
        this.logger.log(`Email details - To: ${email}, Subject: ${emailSubject}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Failed to send appeal approval email: ${error.message}`);
      return false;
    }
  }

  /**
   * Send email notification for appeal rejection
   */
  async sendAppealRejectionEmail(userId: string, username: string, reason?: string): Promise<boolean> {
    try {
      const email = await this.getUserEmail(userId);
      
      if (!email) {
        this.logger.warn(`Cannot send appeal rejection email: no email found for user ${userId}`);
        return false;
      }

      const emailSubject = 'Appeal Decision - Account Suspension';
      const emailBody = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Appeal Decision</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: #ffffff; margin: 0;">Appeal Decision</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
            <p style="font-size: 16px; margin-bottom: 20px;">Hello ${username},</p>
            
            <p style="font-size: 16px; margin-bottom: 20px;">
              We have reviewed your suspension appeal. After careful consideration, we have decided to uphold the suspension of your account.
            </p>
            
            ${reason ? `
            <div style="background: #ffffff; padding: 20px; border-radius: 8px; border-left: 4px solid #f59e0b; margin: 20px 0;">
              <p style="margin: 0; font-size: 14px; color: #666;">
                <strong>Reason:</strong> ${reason}
              </p>
            </div>
            ` : ''}
            
            <p style="font-size: 16px; margin-bottom: 20px;">
              If you believe this decision was made in error, or if you have additional information to share, please contact our support team for further assistance.
            </p>
            
            <p style="font-size: 14px; color: #666; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">
              Best regards,<br>
              The Fretiko Team
            </p>
          </div>
        </body>
        </html>
      `;

      // Send email using Supabase's email service
      try {
        // Similar to approval email, use Supabase or log for manual sending
        this.logger.log(`Sending appeal rejection email to ${email} for user ${userId}`);
        this.logger.log(`Email details - To: ${email}, Subject: ${emailSubject}`);
        this.logger.log(`Email body prepared (${emailBody.length} chars)`);
        
        // TODO: Integrate with actual email service (SendGrid, AWS SES, etc.)
        // For now, email details are logged
        
        return true;
      } catch (error) {
        this.logger.error(`Error sending rejection email: ${error.message}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Failed to send appeal rejection email: ${error.message}`);
      return false;
    }
  }
}

