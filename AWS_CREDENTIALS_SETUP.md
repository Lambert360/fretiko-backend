# AWS IAM User Setup - Step by Step

## Your Current Setup
- **Bucket**: `fretiko-agora-hls`
- **Region**: `eu-north-1` (Stockholm)
- **Account Alias**: `agora-s3-uploader`

## Step 1: Create IAM User (If Not Already Created)

1. Go to: https://console.aws.amazon.com/iam/
2. Click **"Users"** in the left sidebar
3. Click **"Create user"** button (top right)
4. **User name**: Enter `agora-s3-uploader`
5. Click **"Next"**

## Step 2: Create and Attach Policy

### Option A: Create Custom Policy (Recommended)

1. In the **"Set permissions"** step, click **"Create policy"** (opens new tab)
2. In the new tab:
   - Click **"JSON"** tab
   - **Delete** the default JSON
   - **Paste** this exact policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "s3:PutObject",
           "s3:GetObject",
           "s3:ListBucket",
           "s3:DeleteObject"
         ],
         "Resource": [
           "arn:aws:s3:::fretiko-agora-hls",
           "arn:aws:s3:::fretiko-agora-hls/*"
         ]
       }
     ]
   }
   ```
3. Click **"Next"**
4. **Policy name**: `AgoraS3RecordingPolicy`
5. **Description**: `Allows Agora Cloud Recording to upload HLS files to S3 bucket`
6. Click **"Create policy"**
7. **Go back** to the "Create user" tab
8. Click the **refresh icon** (🔄) next to "Create policy"
9. **Search** for: `AgoraS3RecordingPolicy`
10. **Check the box** next to the policy
11. Click **"Next"**
12. Click **"Create user"**

### Option B: Use Existing Policy (If Already Created)

1. In **"Set permissions"**, select **"Attach policies directly"**
2. Search for `AgoraS3RecordingPolicy`
3. Check the box
4. Click **"Next"** → **"Create user"**

## Step 3: Create Access Keys (GET YOUR CREDENTIALS)

1. **Click on the user** you just created (`agora-s3-uploader`)
2. Click the **"Security credentials"** tab
3. Scroll down to **"Access keys"** section
4. Click **"Create access key"** button
5. Select **"Application running outside AWS"** (or "Command Line Interface (CLI)")
6. Click **"Next"**
7. (Optional) **Description**: `Agora Cloud Recording S3 Access`
8. Click **"Next"** (skip optional tags)
9. Click **"Create access key"**

## Step 4: SAVE YOUR CREDENTIALS ⚠️

**YOU WILL ONLY SEE THE SECRET KEY ONCE!**

You'll see a screen with:
- **Access key ID**: `AKIA...` (starts with AKIA)
- **Secret access key**: `wJalr...` (long random string)

**DO THIS IMMEDIATELY:**
1. Click **"Download .csv file"** (saves both keys)
2. **OR** copy both values to a secure location (password manager, secure note)
3. **DO NOT** close this page until you've saved them!

## Step 5: Generate Agora Customer ID & Customer Secret

**⚠️ CRITICAL: This is required for Cloud Recording API authentication!**

Without these, you will get 401 Unauthorized errors.

1. Go to **Agora Console**: https://console.agora.io/
2. Select your project (the one with your App ID)
3. Go to **"Developer Toolkit" → "RESTful API"**
4. Click **"Add a secret"** or **"Generate"**
5. You will get:
   - **Customer ID** (this is NOT the same as App ID)
   - **Customer Secret** (this is NOT the same as App Certificate)
6. **SAVE THESE IMMEDIATELY** - you'll only see the secret once!

## Step 6: Add All Credentials to Your .env File

Add these lines to your `fretiko-backend/.env` file:

```env
# AWS S3 Configuration for Agora Cloud Recording
AWS_S3_BUCKET=fretiko-agora-hls
AWS_S3_REGION=eu-north-1
AWS_ACCESS_KEY_ID=AKIA...paste_your_access_key_id_here
AWS_SECRET_ACCESS_KEY=wJalr...paste_your_secret_access_key_here

# Agora Cloud Recording REST API Credentials
AGORA_CUSTOMER_ID=paste_your_customer_id_here
AGORA_CUSTOMER_SECRET=paste_your_customer_secret_here
```

**Replace**:
- `AKIA...` and `wJalr...` with your AWS credentials
- `paste_your_customer_id_here` and `paste_your_customer_secret_here` with your Agora Customer credentials

## Step 7: Verify Setup

1. **Restart your backend server** (to load new env vars)
2. **Start a test live stream**
3. **Check logs** for:
   ```
   ✅ Cloud Recording (HLS) started for stream {id}, storing to S3: fretiko-agora-hls
   ```
4. **End the stream**
5. **Check S3 bucket**:
   - Go to: https://s3.console.aws.amazon.com/s3/buckets/fretiko-agora-hls
   - You should see a folder: `streams/`
   - Inside: `streams/{streamId}/` with `.m3u8` and `.ts` files

## Troubleshooting

### "Access Denied" Error
- Check IAM policy is attached to the user
- Verify bucket name matches exactly: `fretiko-agora-hls`
- Check access keys are correct in `.env`

### "Invalid Region" Error
- Verify region is: `eu-north-1`
- Check the code has been updated (we added eu-north-1 mapping)

### Can't Find Access Keys
- Go to IAM → Users → `agora-s3-uploader` → Security credentials
- If keys exist but secret is lost, **delete old key** and create new one

## Security Reminders

✅ **Never commit** `.env` file to Git  
✅ **Never share** access keys publicly  
✅ **Rotate keys** every 90 days  
✅ **Delete unused keys**  
✅ **Use least privilege** (only S3 access)

## Quick Reference

| Item | Value |
|------|-------|
| Bucket Name | `fretiko-agora-hls` |
| Region | `eu-north-1` |
| IAM User | `agora-s3-uploader` |
| Policy | `AgoraS3RecordingPolicy` |
| Access Key Format | `AKIA...` |
| Secret Key Format | `wJalr...` (long string) |

