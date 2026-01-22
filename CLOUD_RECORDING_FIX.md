# Cloud Recording 401 Unauthorized - Fix

## Problem Identified

You're getting `401 Unauthorized` when trying to start Cloud Recording because the code was using **App ID** and **App Certificate** for authentication, but Agora Cloud Recording REST API requires **Customer ID** and **Customer Secret**.

## Root Cause

```typescript
// ❌ WRONG (what we were doing):
const customerId = appId;           // Using App ID
const customerSecret = appCertificate;  // Using App Certificate

// ✅ CORRECT (what we need):
const customerId = AGORA_CUSTOMER_ID;      // From Agora Console
const customerSecret = AGORA_CUSTOMER_SECRET;  // From Agora Console
```

## What You Need To Do

### 1. Generate Customer ID & Customer Secret

1. Go to **Agora Console**: https://console.agora.io/
2. Select your project (App ID: `bddd5379afeb4f9bbc2cf2ec1459eca8`)
3. Navigate to: **Developer Toolkit → RESTful API**
4. Click **"Add a secret"** or **"Generate"**
5. You will receive:
   - **Customer ID**
   - **Customer Secret**
6. **SAVE THESE IMMEDIATELY** - the secret is shown only once!

### 2. Add to Your `.env` File

Add these two new lines to `fretiko-backend/.env`:

```env
# Agora Cloud Recording REST API Credentials
AGORA_CUSTOMER_ID=paste_your_customer_id_here
AGORA_CUSTOMER_SECRET=paste_your_customer_secret_here
```

### 3. Restart Backend

```bash
# Stop the current backend process (Ctrl+C)
# Then start it again
npm run start:dev
```

## What Was Fixed

- ✅ Updated `live-sales.service.ts` to use `AGORA_CUSTOMER_ID` and `AGORA_CUSTOMER_SECRET`
- ✅ Added proper error messages when credentials are missing
- ✅ Updated documentation in `AGORA_CONSOLE_SETUP.md`
- ✅ Updated `AWS_CREDENTIALS_SETUP.md` with new Step 5

## Testing After Fix

1. Add the credentials to `.env`
2. Restart backend
3. Start a live stream
4. Check logs - you should see:
   ```
   ✅ Cloud Recording acquired for stream {id}
   ✅ Cloud Recording (HLS) started for stream {id}, storing to S3: fretiko-agora-hls
   ```
5. End the stream
6. Check Agora Console → Cloud Recording Usage (should show recording time)
7. Check S3 bucket for files

## Why This Happened

Agora has multiple APIs:
- **RTC SDK** - uses App ID + App Certificate (for generating tokens)
- **Cloud Recording REST API** - uses Customer ID + Customer Secret (for server-side API calls)

The documentation wasn't clear about this difference, so we used the wrong credentials.

## References

- [Agora Cloud Recording API Authentication](https://docs.agora.io/en/cloud-recording/reference/restful-api)
- [How to Generate Customer Credentials](https://console.agora.io/)

