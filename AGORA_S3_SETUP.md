# Agora Cloud Recording with AWS S3 Setup Guide

## Overview
This guide explains how to set up Agora Cloud Recording with AWS S3 for HLS streaming.

## Prerequisites
1. AWS Account with S3 access
2. Agora account with Cloud Recording enabled
3. Environment variables configured

## Step 1: AWS S3 Setup

### 1.1 Create S3 Bucket
1. Go to AWS S3 Console
2. Create a new bucket (e.g., `fretiko-live-recordings`)
3. Choose a region close to your users (e.g., `us-east-1`)
4. Configure bucket settings:
   - **Block Public Access**: Disable if you want public HLS playback
   - **Versioning**: Optional
   - **CORS**: Configure if needed for web playback

### 1.2 Create IAM User
1. Go to AWS IAM Console
2. Create a new user: `agora-recording-user`
3. Attach this policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::fretiko-live-recordings/*",
        "arn:aws:s3:::fretiko-live-recordings"
      ]
    }
  ]
}
```
4. Create Access Key ID and Secret Access Key
5. **Save these credentials securely**

### 1.3 Configure CORS (Optional)
If you need web playback, add this CORS configuration:
```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

## Step 2: Environment Variables

Add these to your `.env` file:

```env
# AWS S3 Configuration for Agora Cloud Recording
AWS_S3_BUCKET=fretiko-live-recordings
AWS_S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_id_here
AWS_SECRET_ACCESS_KEY=your_secret_access_key_here

# Note: These can also use the legacy names (for backward compatibility):
# CLOUD_STORAGE_BUCKET
# CLOUD_STORAGE_ACCESS_KEY
# CLOUD_STORAGE_SECRET_KEY
```

## Step 3: Database Migration

Run the migration to add required columns:

```bash
# Apply migration
psql -U your_user -d your_database -f migrations/095_add_agora_recording_fields.sql
```

Or if using Supabase:
1. Go to Supabase Dashboard → SQL Editor
2. Run the migration file: `095_add_agora_recording_fields.sql`

## Step 4: How It Works

### Recording Flow
1. **Stream Goes Live**: When `updateStreamStatus` is called with `status: 'live'`
   - Automatically calls `startHLSConversion()` after 10 seconds
   - Acquires Agora recording resource
   - Starts Cloud Recording with S3 storage config
   - Stores `agora_resource_id` and `agora_sid` in database

2. **During Stream**: 
   - Video is recorded and uploaded to S3 in real-time
   - Files are stored as: `streams/{streamId}/{timestamp}.m3u8` and `.ts` segments

3. **Stream Ends**: When `updateStreamStatus` is called with `status: 'ended'`
   - Automatically calls `stopHLSRecording()`
   - Stops recording and waits for upload
   - Updates `stream_url` with S3 HLS URL

### HLS URL Retrieval
- `getHLSStreamUrl()` checks:
  1. If `stream_url` is set → Returns S3 URL immediately
  2. If `agora_resource_id` exists → Returns "Recording in progress"
  3. Otherwise → Returns "Recording not started"

## Step 5: Testing

1. **Start a live stream** as host
2. **Check logs** for:
   ```
   ✅ Cloud Recording (HLS) started for stream {id}, storing to S3: {bucket}
   ```
3. **Wait for stream to end** (or manually end it)
4. **Check S3 bucket** for `.m3u8` and `.ts` files
5. **Verify HLS playback** using the S3 URL

## Region Mapping

The service automatically maps AWS regions to Agora region codes:

| AWS Region | Agora Code |
|------------|------------|
| us-east-1 | 0 |
| us-west-1 | 1 |
| eu-west-1 | 2 |
| ap-southeast-1 | 3 |
| ap-northeast-1 | 4 |
| ... | ... |

If your region isn't mapped, it defaults to `0` (us-east-1). You can add more mappings in `startHLSConversion()`.

## Troubleshooting

### Recording Not Starting
- Check AWS credentials are correct
- Verify S3 bucket exists and IAM user has permissions
- Check logs for specific error messages

### HLS URL Not Available
- Recording may still be uploading (wait a few seconds)
- Check S3 bucket for files
- Verify `stream_url` is updated in database

### Upload Failures
- Ensure bucket region matches your server region (or close)
- Check IAM permissions are correct
- Verify bucket name is correct

## Security Notes

1. **Never commit credentials** to version control
2. **Use environment variables** for all sensitive data
3. **Rotate access keys** regularly
4. **Use IAM roles** instead of access keys if possible (future enhancement)
5. **Consider CloudFront** for CDN delivery of HLS files

## Cost Considerations

- **S3 Storage**: ~$0.023 per GB/month
- **S3 PUT Requests**: ~$0.005 per 1,000 requests
- **S3 GET Requests**: ~$0.0004 per 1,000 requests
- **Data Transfer Out**: Varies by region

For a 1-hour stream at 720p (~1 Mbps):
- Recording size: ~450 MB
- Storage cost: ~$0.01
- Transfer cost: Depends on viewers

## Next Steps

1. Set up CloudFront CDN for better HLS delivery
2. Implement signed URLs for private streams
3. Add recording quality settings (720p, 1080p, etc.)
4. Set up automatic cleanup of old recordings

