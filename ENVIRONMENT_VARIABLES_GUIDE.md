# Environment Variables Guide - Flutterwave Integration

## Overview

This guide explains what values to use for each environment variable in your `.env` file.

## Flutterwave Credentials

### FLW_PUBLIC_KEY
**What it is**: Your Flutterwave Public Key (starts with `FLWPUBK-`)

**Where to get it**:
1. Log in to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Go to **Settings** → **API Keys**
3. Copy the **Public Key**

**Example**:
```env
FLW_PUBLIC_KEY=FLWPUBK-xxxxxxxxxxxxxxxxxxxxx
```

**Note**: Use test keys for sandbox/testing, production keys for live payments

---

### FLW_SECRET_KEY
**What it is**: Your Flutterwave Secret Key (starts with `FLWSECK-`)

**Where to get it**:
1. Log in to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Go to **Settings** → **API Keys**
3. Copy the **Secret Key**

**Example**:
```env
FLW_SECRET_KEY=FLWSECK-xxxxxxxxxxxxxxxxxxxxx
```

**⚠️ Security**: Never commit this to version control! Keep it secret.

---

### FLW_ENCRYPTION_KEY
**What it is**: Your Flutterwave Encryption Key (32-character string)

**Where to get it**:
1. Log in to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Go to **Settings** → **API Keys**
3. Copy the **Encryption Key**

**Example**:
```env
FLW_ENCRYPTION_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

### FLW_WEBHOOK_SECRET
**What it is**: Secret key for verifying webhook signatures from Flutterwave

**Where to get it**:
1. Log in to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Go to **Settings** → **Webhooks**
3. Create or select a webhook
4. Copy the **Webhook Secret** (or set a custom secret)

**Example**:
```env
FLW_WEBHOOK_SECRET=your_custom_webhook_secret_here
```

**Note**: You can set a custom secret when creating the webhook in Flutterwave dashboard

---

## Application URLs

### FRONTEND_URL
**What it is**: The base URL of your frontend application (mobile app or web app)

**What it's used for**:
- Redirect URL after payment completion
- Flutterwave redirects users back to this URL after they complete payment
- Used in the `redirect_url` parameter when initializing payments

**Development (Local Testing)**:
```env
FRONTEND_URL=http://localhost:3000
```

**For Mobile App (React Native)**:
Since mobile apps don't have a traditional URL, you have two options:

**Option 1: Deep Link URL (Recommended)**
```env
FRONTEND_URL=fretiko://wallet/deposit/callback
```
- This uses a custom URL scheme (deep link)
- You'll need to configure deep linking in your React Native app
- When Flutterwave redirects, it opens your app via the deep link

**Option 2: Web Fallback URL**
```env
FRONTEND_URL=https://your-website.com/wallet/deposit/callback
```
- If you have a web version of your app
- Or a landing page that redirects to the mobile app

**Production (Mobile App)**:
```env
FRONTEND_URL=fretiko://wallet/deposit/callback
# OR
FRONTEND_URL=https://app.fretiko.com/wallet/deposit/callback
```

**Production (Web App)**:
```env
FRONTEND_URL=https://app.fretiko.com
```

**How to find your frontend URL**:
- **Web app**: The domain where your frontend is hosted (e.g., `https://app.fretiko.com`)
- **Mobile app**: Use deep link scheme (e.g., `fretiko://`) or your app's website URL

---

### API_URL
**What it is**: The base URL of your backend API server

**What it's used for**:
- Webhook callback URL (Flutterwave sends webhooks to this URL)
- Used in the `callback_url` parameter when initiating transfers
- Must be publicly accessible from the internet

**Development (Local Testing)**:
```env
API_URL=http://localhost:3000
```

**⚠️ Important for Local Development**:
- Flutterwave **cannot** send webhooks to `localhost`
- You need to expose your local server to the internet
- Use **ngrok** (recommended for Flutterwave webhooks)

**Using ngrok (Recommended)**:
```bash
# Install ngrok: https://ngrok.com/download
# Expose your local server
ngrok http 3000

# You'll get a URL like: https://abc123.ngrok.io
# Use this for API_URL:
API_URL=https://abc123.ngrok.io
```

**Development with ngrok**:
```env
API_URL=https://abc123.ngrok.io
```

**Production**:
```env
API_URL=https://api.fretiko.com
# OR
API_URL=https://backend.fretiko.com
```

**How to find your API URL**:
- **Development**: Use ngrok URL (e.g., `https://abc123.ngrok.io`)
- **Production**: Your backend server's domain (e.g., `https://api.fretiko.com`)

---

## Complete Example Configurations

### Development (Local with ngrok)
```env
# Flutterwave (Sandbox/Test Keys)
FLW_PUBLIC_KEY=FLWPUBK_TEST-xxxxxxxxxxxxxxxxxxxxx
FLW_SECRET_KEY=FLWSECK_TEST-xxxxxxxxxxxxxxxxxxxxx
FLW_ENCRYPTION_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FLW_WEBHOOK_SECRET=test_webhook_secret_123

# Application URLs
FRONTEND_URL=fretiko://wallet/deposit/callback
API_URL=https://abc123.ngrok.io
```

### Production
```env
# Flutterwave (Production Keys)
FLW_PUBLIC_KEY=FLWPUBK-xxxxxxxxxxxxxxxxxxxxx
FLW_SECRET_KEY=FLWSECK-xxxxxxxxxxxxxxxxxxxxx
FLW_ENCRYPTION_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FLW_WEBHOOK_SECRET=production_webhook_secret_xyz

# Application URLs
FRONTEND_URL=https://app.fretiko.com
API_URL=https://api.fretiko.com
```

---

## Setting Up Deep Linking (For Mobile Apps)

If you're using `fretiko://` as your `FRONTEND_URL`, you need to configure deep linking:

### React Native (Expo)
1. Add to `app.json`:
```json
{
  "expo": {
    "scheme": "fretiko",
    "ios": {
      "bundleIdentifier": "com.fretiko.app"
    },
    "android": {
      "package": "com.fretiko.app"
    }
  }
}
```

2. Handle deep links in your app:
```typescript
import * as Linking from 'expo-linking';

// Listen for deep links
Linking.addEventListener('url', (event) => {
  const { url } = event;
  if (url.includes('wallet/deposit/callback')) {
    // Handle payment completion
    // Check deposit status, show success message, etc.
  }
});
```

### React Native (Bare)
1. Configure in `android/app/src/main/AndroidManifest.xml`:
```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="fretiko" />
</intent-filter>
```

2. Configure in `ios/[AppName]/Info.plist`:
```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>fretiko</string>
    </array>
  </dict>
</array>
```

---

## Webhook URL Configuration

When setting up the webhook in Flutterwave dashboard:

**Webhook URL Format**:
```
{API_URL}/wallet/webhooks/flutterwave
```

**Examples**:
- Development: `https://abc123.ngrok.io/wallet/webhooks/flutterwave`
- Production: `https://api.fretiko.com/wallet/webhooks/flutterwave`

**Steps**:
1. Copy your `API_URL` from `.env`
2. Append `/wallet/webhooks/flutterwave`
3. Paste into Flutterwave dashboard → Settings → Webhooks → Webhook URL
4. Select events: `charge.completed`, `charge.failed`, `transfer.completed`, `transfer.failed`
5. Save the webhook

---

## Quick Reference

| Variable | Purpose | Example (Dev) | Example (Prod) |
|----------|---------|---------------|----------------|
| `FLW_PUBLIC_KEY` | Flutterwave public key | `FLWPUBK_TEST-...` | `FLWPUBK-...` |
| `FLW_SECRET_KEY` | Flutterwave secret key | `FLWSECK_TEST-...` | `FLWSECK-...` |
| `FLW_ENCRYPTION_KEY` | Flutterwave encryption key | `32-char string` | `32-char string` |
| `FLW_WEBHOOK_SECRET` | Webhook verification secret | `test_secret_123` | `prod_secret_xyz` |
| `FRONTEND_URL` | Frontend app URL (redirect after payment) | `fretiko://wallet/deposit/callback` | `https://app.fretiko.com` |
| `API_URL` | Backend API URL (webhook endpoint) | `https://abc123.ngrok.io` | `https://api.fretiko.com` |

---

## Troubleshooting

### "Webhook not receiving events"
- ✅ Check `API_URL` is publicly accessible (not localhost)
- ✅ Verify webhook URL in Flutterwave dashboard matches `{API_URL}/wallet/webhooks/flutterwave`
- ✅ Check webhook is active in Flutterwave dashboard
- ✅ Verify `FLW_WEBHOOK_SECRET` matches the secret in Flutterwave dashboard

### "Payment redirect not working"
- ✅ Check `FRONTEND_URL` is correct
- ✅ Verify deep linking is configured (for mobile apps)
- ✅ Test the redirect URL manually

### "Cannot connect to Flutterwave API"
- ✅ Verify `FLW_PUBLIC_KEY` and `FLW_SECRET_KEY` are correct
- ✅ Check you're using test keys for sandbox, production keys for live
- ✅ Verify network connectivity

---

## Security Best Practices

1. **Never commit `.env` file** to version control
2. **Use different keys** for development and production
3. **Rotate secrets** periodically
4. **Use environment-specific configs** (dev, staging, prod)
5. **Restrict API access** in production (use firewall rules)

---

## Need Help?

- **Flutterwave Support**: support@flutterwave.com
- **Flutterwave Docs**: https://developer.flutterwave.com/docs
- **Check server logs** for detailed error messages

