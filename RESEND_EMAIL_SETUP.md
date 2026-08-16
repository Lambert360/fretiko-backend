# Resend Email Setup for Partner Authentication

This guide ensures that Resend email service is properly configured for partner authentication emails.

## 🚨 Required Environment Variables

Add these to your `.env` file:

```bash
# Resend Email Service (for partner authentication emails)
RESEND_API_KEY=re_your_resend_api_key_here
RESEND_FROM_EMAIL=partners@fretiko.com
```

## 📧 What Emails Use Resend

The partner authentication system uses Resend for these emails:

### 1. Partner Verification Email
- **Trigger**: When admin verifies a partner application
- **Content**: Username + password setup instructions
- **Template**: `sendCompanyVerifiedWithPasswordSetup()`

### 2. Partner Password Reset Email
- **Trigger**: When partner requests password reset
- **Content**: Reset code + company name
- **Template**: `sendPartnerPasswordResetEmail()`

### 3. Admin Password Reset Email
- **Trigger**: When admin requests password reset
- **Content**: Reset code + admin branding
- **Template**: `sendPasswordResetEmail()`

## 🔧 Setup Instructions

### 1. Get Resend API Key

1. Go to [Resend Dashboard](https://resend.com/dashboard)
2. Sign up or login
3. Create a new API key
4. Copy the API key (starts with `re_`)

### 2. Configure Domain

1. In Resend Dashboard, add your domain
2. Verify domain ownership (DNS records)
3. Set up SPF/DKIM records for deliverability

### 3. Update Environment

Add to your `.env` file:
```bash
RESEND_API_KEY=re_your_actual_resend_api_key
RESEND_FROM_EMAIL=partners@yourdomain.com
```

## ✅ Testing the Configuration

### Test Partner Verification Email

```javascript
// Test script to verify email sending
const { ConfigService } = require('@nestjs/config');
const { LogisticsNotificationService } = require('./src/logistics-partners/logistics-notification.service');

async function testEmail() {
  const configService = new ConfigService();
  const emailService = new LogisticsNotificationService(configService);
  
  await emailService.sendCompanyVerifiedWithPasswordSetup(
    'test@example.com',
    'Test Company',
    'testusername123'
  );
}
```

### Test Partner Password Reset

```javascript
// Test password reset email
const { EmailService } = require('./src/auth/email.service');

async function testPasswordReset() {
  const configService = new ConfigService();
  const emailService = new EmailService(configService);
  
  await emailService.sendPartnerPasswordResetEmail(
    'test@example.com',
    '123456',
    'Test Company'
  );
}
```

## 🚨 Common Issues & Solutions

### Issue 1: "Missing Resend configuration"
**Solution**: Ensure both `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set in `.env`

### Issue 2: Email not sending
**Solution**: 
- Check API key is valid
- Verify domain is verified in Resend
- Check email logs in Resend dashboard

### Issue 3: Domain not verified
**Solution**: 
- Add DNS records as suggested by Resend
- Wait for DNS propagation (up to 48 hours)

## 📊 Email Templates Overview

### Partner Verification Email Features:
- ✅ Green logistics theme
- ✅ Username prominently displayed
- ✅ Step-by-step password setup
- ✅ Professional branding
- ✅ Security warnings

### Partner Password Reset Email Features:
- ✅ Company name personalization
- ✅ Large reset code display
- ✅ Step-by-step instructions
- ✅ Security warnings
- ✅ Professional footer

## 🔍 Debug Information

The email services include detailed logging:

```javascript
console.log('🔍 Partner Password Reset Email Debug:');
console.log('- RESEND_API_KEY exists:', !!resendApiKey);
console.log('- RESEND_FROM_EMAIL:', resendFromEmail);
console.log('- Sending partner password reset email to:', email);
console.log('- Company Name:', companyName);
console.log('- Reset token:', token);
```

## 📧 Email Delivery Status

Check email delivery in:
1. **Application Logs**: Look for "✅ Partner password reset email sent"
2. **Resend Dashboard**: View email delivery status
3. **Email Client**: Check spam/promo folders

## 🎯 Production Checklist

- [ ] Resend API key configured
- [ ] Domain verified in Resend
- [ ] SPF/DKIM records set up
- [ ] Test emails sent successfully
- [ ] Email templates render correctly
- [ ] No spam filter issues

## 📞 Support

If emails aren't working:
1. Check Resend dashboard for errors
2. Verify API key is correct
3. Check domain verification status
4. Review application logs for detailed errors

## 🔄 Fallback Option

If Resend fails, the system will:
- Log detailed error messages
- Return success response (for security)
- Allow retry functionality
- Use SMTP backup (if configured)
