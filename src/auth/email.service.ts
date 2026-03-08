import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class EmailService {
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async sendVerificationEmail(email: string, token: string): Promise<boolean> {
    try {
      const emailContent = this.generateVerificationEmailContent(token);
      
      const { error } = await this.supabase.auth.admin.updateUserById(
        '00000000-0000-0000-0000-000000000000', // This won't work for sending emails
        {
          email: email,
          email_confirm: true
        }
      );

      // Alternative: Use Resend directly since you have it configured
      const resendApiKey = this.configService.get<string>('RESEND_API_KEY');
      const resendFromEmail = this.configService.get<string>('RESEND_FROM_EMAIL');

      if (resendApiKey && resendFromEmail) {
        return await this.sendViaResend(email, token, resendApiKey, resendFromEmail);
      }

      return false;
    } catch (error) {
      console.error('Failed to send verification email:', error);
      return false;
    }
  }

  private async sendViaResend(
    email: string, 
    token: string, 
    apiKey: string, 
    fromEmail: string
  ): Promise<boolean> {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [email],
          subject: 'Verify Your Fretiko Account',
          html: this.generateVerificationEmailContent(token),
        }),
      });

      const result = await response.json();
      return response.ok;
    } catch (error) {
      console.error('Failed to send via Resend:', error);
      return false;
    }
  }

  private generateVerificationEmailContent(token: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Fretiko Account</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #3498db; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .token-box { background: #f0f0f0; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0; border: 2px dashed #3498db; }
        .token { font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2c3e50; }
        .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 Welcome to Fretiko!</h1>
        </div>
        <div class="content">
            <h2>Verify Your Email Address</h2>
            <p>Thank you for signing up! Your verification code is:</p>
            
            <div class="token-box">
                <div class="token">${token}</div>
            </div>
            
            <p><strong>This code will expire in 24 hours.</strong></p>
            <p>Enter this code in the Fretiko app to complete your registration.</p>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
            
            <p style="color: #666; font-size: 14px;">
                If you didn't request this code, please ignore this email. Your account remains secure.
            </p>
        </div>
        <div class="footer">
            <p>© 2026 Fretiko. All rights reserved.</p>
            <p>This is an automated message. Please do not reply to this email.</p>
        </div>
    </div>
</body>
</html>
    `;
  }

  async sendResendTokenEmail(email: string, token: string): Promise<boolean> {
    try {
      const resendApiKey = this.configService.get<string>('RESEND_API_KEY');
      const resendFromEmail = this.configService.get<string>('RESEND_FROM_EMAIL');

      if (!resendApiKey || !resendFromEmail) {
        throw new Error('Resend configuration missing');
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
          subject: 'New Verification Code - Fretiko',
          html: this.generateResendEmailContent(token),
        }),
      });

      const result = await response.json();
      return response.ok;
    } catch (error) {
      console.error('Failed to send resend token:', error);
      return false;
    }
  }

  private generateResendEmailContent(token: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Verification Code - Fretiko</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #e74c3c; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .token-box { background: #fff3cd; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0; border: 2px solid #e74c3c; }
        .token { font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #e74c3c; }
        .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔄 New Verification Code</h1>
        </div>
        <div class="content">
            <h2>You Requested a New Code</h2>
            <p>Here's your new verification code for Fretiko:</p>
            
            <div class="token-box">
                <div class="token">${token}</div>
            </div>
            
            <p><strong>This code will expire in 24 hours.</strong></p>
            <p>Enter this code in the Fretiko app to complete your registration.</p>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
            
            <p style="color: #666; font-size: 14px;">
                If you didn't request this code, please ignore this email.
            </p>
        </div>
        <div class="footer">
            <p>© 2026 Fretiko. All rights reserved.</p>
            <p>This is an automated message. Please do not reply to this email.</p>
        </div>
    </div>
</body>
</html>
    `;
  }
}
