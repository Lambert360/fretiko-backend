# AWS IAM User Setup for Agora S3 Recording

## Step-by-Step Guide

### Step 1: Create IAM User

1. Go to **AWS IAM Console**: https://console.aws.amazon.com/iam/
2. Click **Users** in the left sidebar
3. Click **Create user** button
4. Enter username: `agora-s3-uploader` (or any name you prefer)
5. Click **Next**

### Step 2: Set Permissions

1. Select **"Attach policies directly"**
2. Click **"Create policy"** button (opens in new tab)
3. In the new tab:
   - Click **JSON** tab
   - Paste this policy:
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
   - Click **Next**
   - Policy name: `AgoraS3RecordingPolicy`
   - Description: `Allows Agora Cloud Recording to upload HLS files to S3`
   - Click **Create policy**
4. Go back to the **Create user** tab
5. Click the **refresh** icon (🔄) next to "Create policy"
6. Search for `AgoraS3RecordingPolicy`
7. Check the box next to it
8. Click **Next**
9. Review and click **Create user**

### Step 3: Create Access Keys

1. Click on the user you just created (`agora-s3-uploader`)
2. Click **Security credentials** tab
3. Scroll down to **Access keys** section
4. Click **Create access key**
5. Select **"Application running outside AWS"** (or "Command Line Interface (CLI)")
6. Click **Next**
7. (Optional) Add description: `Agora Cloud Recording S3 Access`
8. Click **Create access key**
9. **IMPORTANT**: Copy both values:
   - **Access key ID**: `AKIA...` (starts with AKIA)
   - **Secret access key**: `wJalr...` (long string)
   - ⚠️ **You can only see the secret key ONCE!** Save it immediately!

### Step 4: Add to Environment Variables

Add these to your `.env` file:

```env
# AWS S3 Configuration for Agora Cloud Recording
AWS_S3_BUCKET=fretiko-agora-hls
AWS_S3_REGION=eu-north-1
AWS_ACCESS_KEY_ID=AKIA...your_access_key_id_here
AWS_SECRET_ACCESS_KEY=wJalr...your_secret_access_key_here
```

### Step 5: Update Region Mapping

Since you're using `eu-north-1` (Stockholm), we need to add it to the region mapping in the code.

The code currently has these mappings:
- us-east-1 → 0
- us-west-1 → 1
- eu-west-1 → 2
- ...

For `eu-north-1`, we need to check Agora's documentation, but it will likely default to region code `0` or we can add it manually.

## Quick Reference

**Bucket Name**: `fretiko-agora-hls`  
**Region**: `eu-north-1` (Stockholm)  
**IAM User**: `agora-s3-uploader`  
**Policy**: `AgoraS3RecordingPolicy`

## Security Best Practices

1. ✅ **Never commit** `.env` file to Git
2. ✅ **Rotate keys** every 90 days
3. ✅ **Use least privilege** (only S3 access, nothing else)
4. ✅ **Enable MFA** on your root account
5. ✅ **Monitor usage** in CloudTrail

## Testing

After setup, test by:
1. Starting a live stream
2. Checking logs for: `✅ Cloud Recording (HLS) started...`
3. Ending the stream
4. Checking S3 bucket for `.m3u8` files

