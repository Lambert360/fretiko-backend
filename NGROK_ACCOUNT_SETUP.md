# Ngrok Account Setup - Quick Guide

## Why Ngrok Requires an Account

Ngrok now requires a free account to use their service. This is a one-time setup that takes 2 minutes.

## Step-by-Step Setup

### Step 1: Sign Up for Free Account

1. Go to: https://dashboard.ngrok.com/signup
2. Sign up with:
   - Email address
   - Password
   - Or use Google/GitHub sign-in

**It's completely free** - no credit card required!

### Step 2: Get Your Authtoken

1. After signing up, you'll be redirected to the dashboard
2. Go to: https://dashboard.ngrok.com/get-started/your-authtoken
3. Copy your authtoken (looks like: `2abc123def456ghi789jkl012mno345pq_6R7S8T9U0V1W2X3Y4Z5`)

### Step 3: Configure Ngrok

Run this command in your terminal:

```bash
ngrok config add-authtoken YOUR_AUTHTOKEN_HERE
```

Replace `YOUR_AUTHTOKEN_HERE` with the token you copied.

**Example**:
```bash
ngrok config add-authtoken 2abc123def456ghi789jkl012mno345pq_6R7S8T9U0V1W2X3Y4Z5
```

You should see:
```
Authtoken saved to configuration file: C:\Users\YourName\AppData\Local\ngrok\ngrok.yml
```

### Step 4: Test Ngrok

Now try running ngrok again:

```bash
ngrok http 3000
```

You should see:
```
Session Status                online
Account                       Your Name (Plan: Free)
Forwarding                    https://abc123.ngrok.io -> http://localhost:3000
```

✅ Success! Ngrok is now configured.

## Why ngrok?

ngrok is the recommended tool for Flutterwave webhooks because:
- ✅ More stable and reliable than alternatives
- ✅ Better HTTPS support
- ✅ Better for Flutterwave webhooks
- ✅ Web interface for debugging (http://127.0.0.1:4040)
- ✅ Request inspection and replay
- ✅ Free account is sufficient for development

## Next Steps After Setup

1. ✅ Sign up for ngrok account
2. ✅ Add authtoken: `ngrok config add-authtoken YOUR_TOKEN`
3. ✅ Start ngrok: `ngrok http 3000`
4. ✅ Copy the HTTPS URL
5. ✅ Add to `.env`: `API_URL=https://abc123.ngrok.io`
6. ✅ Configure Flutterwave webhook with the ngrok URL

That's it! You're ready to test webhooks.

