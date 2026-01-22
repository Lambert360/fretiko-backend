# Agora Console Configuration Checklist

## Overview
After setting up AWS S3, you need to verify a few things in Agora Console to ensure Cloud Recording works.

## Step 1: Verify Your Project Settings

1. **Go to Agora Console**: https://console.agora.io/
2. **Select your project** (the one with your App ID)
3. **Check these values** (you'll need them):
   - **App ID**: `bddd5379afeb4f9bbc2cf2ec1459eca8` (you already have this)
   - **App Certificate**: (check if you have this set)

## Step 1b: **CRITICAL** - Generate Customer ID & Customer Secret for Cloud Recording

**This is required for Cloud Recording API authentication!**

1. In Agora Console → Your Project → **"Developer Toolkit"** → **"RESTful API"**
2. Click **"Add a secret"** or **"Generate"**
3. You will get:
   - **Customer ID** (this is NOT the same as App ID)
   - **Customer Secret** (this is NOT the same as App Certificate)
4. **Save these immediately** - you'll only see the secret once!
5. Add them to your `.env` file:
   ```
   AGORA_CUSTOMER_ID=your_customer_id_here
   AGORA_CUSTOMER_SECRET=your_customer_secret_here
   ```

**Without these credentials, you will get 401 Unauthorized errors when trying to start Cloud Recording.**

## Step 2: Enable Cloud Recording (If Not Already Enabled)

1. In your project dashboard, look for **"Products & Usage"** or **"Features"**
2. Find **"Cloud Recording"** or **"Duration / Cloud Recording"**
3. **Enable it** if it's not already enabled
4. Note: Some accounts have it enabled by default, so this step may not be necessary

## Step 3: Get REST API Credentials (Optional - For Advanced Usage)

**Note**: You're currently using **App ID** and **App Certificate** for authentication, which should work. But if you encounter authentication errors, you may need Customer ID and Customer Secret.

1. In Agora Console → Your Project → **"RESTful API"** tab
2. Click **"Add Secret"** or **"Generate"** to create:
   - **Customer ID**
   - **Customer Secret**
3. **Save these** (you'll only see the secret once)

**Current Implementation**: Your code uses App ID + App Certificate, which works for most cases. Only get Customer ID/Secret if you get authentication errors.

## Step 4: Verify Your Current Setup

Your code is already configured with:
- ✅ App ID: `bddd5379afeb4f9bbc2cf2ec1459eca8`
- ✅ App Certificate: (from your env vars)
- ✅ S3 Storage Config: (from your env vars)

## Step 5: Test Recording

1. **Start a live stream** from your app
2. **Check backend logs** for:
   ```
   ✅ Cloud Recording (HLS) started for stream {id}, storing to S3: fretiko-agora-hls
   ```
3. If you see errors, check:
   - Is Cloud Recording enabled in Console?
   - Are App ID and Certificate correct?
   - Are S3 credentials correct?

## Common Issues & Solutions

### Error: "Cloud Recording not enabled"
- **Solution**: Enable Cloud Recording in Agora Console → Project → Features

### Error: "Invalid credentials"
- **Solution**: Verify App ID and App Certificate in your `.env` file match Console

### Error: "Recording failed to start"
- **Solution**: 
  - Check S3 bucket name matches exactly
  - Verify S3 region is correct (`eu-north-1`)
  - Check IAM user has correct permissions

### Error: "Upload failed"
- **Solution**:
  - Verify S3 bucket exists
  - Check IAM access keys are correct
  - Ensure bucket region matches (`eu-north-1`)

## What You DON'T Need to Do

❌ **No need to configure storage in Agora Console** - Storage is configured via API (which we do in code)  
❌ **No need to set up webhooks** - Optional, not required  
❌ **No need to configure recording templates** - We configure everything in the API call

## Quick Verification Checklist

- [ ] Cloud Recording is enabled in Agora Console (if option exists)
- [ ] App ID is correct: `bddd5379afeb4f9bbc2cf2ec1459eca8`
- [ ] App Certificate is set in your `.env` file
- [ ] S3 bucket exists: `fretiko-agora-hls`
- [ ] S3 region is correct: `eu-north-1`
- [ ] IAM user has access keys created
- [ ] `.env` file has all credentials

## Testing

After verifying everything:

1. **Restart your backend server**
2. **Start a test live stream**
3. **Wait 10-15 seconds** (recording starts after 10 seconds)
4. **Check logs** for recording start confirmation
5. **End the stream**
6. **Check S3 bucket** for `.m3u8` and `.ts` files

## Next Steps

If everything is configured correctly:
- ✅ Recording should start automatically when stream goes live
- ✅ Files will be uploaded to S3 automatically
- ✅ HLS URL will be available after stream ends

If you encounter any errors, check the logs and refer to the troubleshooting section above.

