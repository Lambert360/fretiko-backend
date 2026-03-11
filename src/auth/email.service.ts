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

      console.log('🔍 Email Service Debug:');
      console.log('- RESEND_API_KEY exists:', !!resendApiKey);
      console.log('- RESEND_FROM_EMAIL:', resendFromEmail);
      console.log('- Sending email to:', email);
      console.log('- Token:', token);

      if (resendApiKey && resendFromEmail) {
        console.log('✅ Attempting to send via Resend...');
        const result = await this.sendViaResend(email, token, resendApiKey, resendFromEmail);
        console.log('- Send result:', result);
        return result;
      } else {
        console.log('❌ Missing Resend configuration');
        console.log('- RESEND_API_KEY:', resendApiKey);
        console.log('- RESEND_FROM_EMAIL:', resendFromEmail);
        return false;
      }
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
        signal: AbortSignal.timeout(30000), // 30 seconds timeout
      });

      console.log('📧 Resend API Response:');
      console.log('- Status:', response.status);
      console.log('- OK:', response.ok);
      
      const result = await response.json();
      console.log('- Response data:', result);
      
      if (!response.ok) {
        console.error('❌ Resend API Error:', result);
        return false;
      }
      
      console.log('✅ Email sent successfully via Resend');
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
            
            <p><strong>This code will expire in 15 minutes.</strong></p>
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
            
            <p><strong>This code will expire in 15 minutes.</strong></p>
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

  async sendPasswordResetEmail(email: string, token: string): Promise<boolean> {
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
          subject: 'Password Reset Code - Fretiko',
          html: this.generatePasswordResetEmailContent(token),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to send password reset email: ${errorData.message}`);
      }

      return true;
    } catch (error) {
      console.error('Error sending password reset email:', error);
      return false;
    }
  }

  private generatePasswordResetEmailContent(token: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Password Reset - Fretiko</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f4f4f4;
        }
        .container {
            background-color: white;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .token-box {
            background-color: #f8f9fa;
            border: 2px dashed #007bff;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
            margin: 20px 0;
        }
        .token {
            font-size: 32px;
            font-weight: bold;
            letter-spacing: 3px;
            color: #007bff;
            font-family: 'Courier New', monospace;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            color: #666;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔐 Password Reset - Fretiko</h1>
        </div>
        <div class="content">
            <h2>Reset Your Password</h2>
            <p>You requested to reset your password. Your reset code is:</p>
            
            <div class="token-box">
                <div class="token">${token}</div>
            </div>
            
            <p><strong>This code will expire in 1 hour.</strong></p>
            <p>Enter this code in the Fretiko app to reset your password.</p>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
            
            <p style="color: #666; font-size: 14px;">
                If you didn't request this password reset, please ignore this email. Your account remains secure.
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
