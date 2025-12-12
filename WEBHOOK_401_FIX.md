# Webhook 401 Unauthorized - Fix Guide

## ✅ Good News: Webhook is Reaching Backend!

The 401 error means:
- ✅ ngrok is working correctly
- ✅ Webhook URL is correct
- ✅ Backend is receiving the webhook
- ❌ **Signature verification is failing**

## Why 401 Unauthorized?

The webhook is being rejected because:
1. **Signature verification failed** - Most likely
2. **Missing signature header** - Less likely
3. **Wrong webhook secret** - Check this

## Fix: Check Webhook Secret

### Step 1: Verify FLW_WEBHOOK_SECRET in .env

**Check your `.env` file:**
```env
FLW_WEBHOOK_SECRET=your_webhook_secret_here
```

### Step 2: Verify in Flutterwave Dashboard

1. Go to Flutterwave Dashboard
2. Settings → Webhooks
3. Check the **Secret Hash** value
4. **It MUST match** your `.env` file exactly

### Step 3: Common Issues

**Issue 1: Secret doesn't match**
- Copy secret from Flutterwave dashboard
- Paste into `.env` file
- Restart backend

**Issue 2: Secret has extra spaces**
- Make sure no leading/trailing spaces
- Copy-paste directly from Flutterwave

**Issue 3: Secret not set**
- If `FLW_WEBHOOK_SECRET` is missing, webhook will be rejected in production
- In development, it might allow (but logs warning)

## Temporary Fix for Testing (Development Only)

If you want to test without signature verification (development only):

**Option 1: Set webhook secret correctly** (Recommended)
- Get secret from Flutterwave dashboard
- Add to `.env`
- Restart backend

**Option 2: Temporarily allow without signature** (Development only)
- This is already done - in development, missing signature is allowed
- But if signature is present and wrong, it's still rejected

## Check Backend Logs

Look for these in your backend logs:
```
🔔 Flutterwave webhook received: charge.completed
🔐 Signature header: present
❌ Invalid webhook signature - rejecting webhook
```

Or:
```
🔔 Flutterwave webhook received: charge.completed
🔐 Signature header: missing
⚠️ No signature header found (allowed in development)
```

## Solution

**Most likely fix:**
1. Go to Flutterwave Dashboard → Settings → Webhooks
2. Copy the **Secret Hash**
3. Update `.env`:
   ```env
   FLW_WEBHOOK_SECRET=paste_secret_here
   ```
4. Restart backend
5. Test again

The webhook should now work! 🎉

