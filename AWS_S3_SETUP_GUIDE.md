# 🗄️ AWS S3 + CloudFront Setup Guide

## 📋 Overview

This guide sets up production-ready video storage with AWS S3 and CloudFront CDN for optimal video delivery.

## 🛠️ **Step 1: Create S3 Bucket**

### 1.1 AWS Console Setup
1. Go to [AWS S3 Console](https://console.aws.amazon.com/s3/)
2. Click "Create bucket"
3. Configure bucket settings:

```
Bucket name: fretiko-videos  (or your preferred name)
Region: us-east-1           (or closest to users)
Block public access: Block all public access
Bucket Versioning: Disabled
Default encryption: Enabled (SSE-S3)
```

### 1.2 Bucket Configuration
```yaml
# CORS Configuration (Optional, for direct uploads)
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD", "PUT", "POST"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

## 🔐 **Step 2: Create IAM User**

### 2.1 Create IAM User
1. Go to [AWS IAM Console](https://console.aws.amazon.com/iam/)
2. Users → Create user
3. User name: `fretiko-video-uploader`
4. Access type: Programmatic access

### 2.2 Attach Policies
Create and attach this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::fretiko-videos",
        "arn:aws:s3:::fretiko-videos/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation",
        "cloudfront:ListInvalidations"
      ],
      "Resource": "*"
    }
  ]
}
```

### 2.3 Generate Access Keys
- Save Access Key ID and Secret Access Key
- **These are your AWS credentials!**

## ☁️ **Step 3: Create CloudFront Distribution**

### 3.1 CloudFront Setup
1. Go to [AWS CloudFront Console](https://console.aws.amazon.com/cloudfront/)
2. Create distribution → Web
3. Origin settings:

```
Origin domain: fretiko-videos.s3.amazonaws.com
Origin access: Origin Access Control (recommended)
Origin access identity: Create new OAC
```

### 3.2 Distribution Settings
```yaml
# Basic Settings
Price class: Use North America & Europe
HTTP version: HTTP/2 (recommended)
IPv6: On
Alternate domain names: (optional) videos.fretiko.com

# Default cache behavior
Path pattern: Default
Viewer protocol: Redirect HTTP to HTTPS
Allowed HTTP methods: GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE
Cached methods: GET, HEAD, OPTIONS
Cache policy: CachingOptimized
Origin request policy: AllViewer
Compress: Yes (recommended)
```

### 3.3 Cache Behaviors
```yaml
# Video files
Path pattern: *.mp4
Cache TTL: 86400 (24 hours)
Compress: Yes

# HLS files  
Path pattern: *.m3u8
Cache TTL: 300 (5 minutes)
Compress: Yes

# Thumbnail files
Path pattern: *.jpg
Cache TTL: 604800 (7 days)
Compress: Yes
```

## 🔧 **Step 4: Update Environment Variables**

Add these to your Render environment:

```bash
# AWS S3 Configuration
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_REGION=us-east-1
AWS_S3_BUCKET=fretiko-videos

# CloudFront Configuration
AWS_CLOUDFRONT_DOMAIN=d123456789.cloudfront.net
AWS_CLOUDFRONT_DISTRIBUTION_ID=E123456789EXAMPLE
```

## 📦 **Step 5: Install AWS SDK**

```bash
cd /Volumes/Isaacmark_B/Personal\ Works/Fretiko/fretiko-backend
npm install aws-sdk
```

## 🔧 **Step 6: Update Video Processing Service**

Replace Supabase storage calls with S3:

```typescript
// In videoProcessingService.ts
import { s3StorageService } from './services/s3StorageService';

// Replace uploadFile method
const uploadResult = await s3StorageService.uploadFile(
  fileBuffer, 
  fileName, 
  'video/mp4'
);

// Replace uploadHLSDirectory method
const hlsResult = await s3StorageService.uploadHLSDirectory(
  hlsDir, 
  `videos/hls/${qualityName}`, 
  hlsFiles
);
```

## 🧪 **Step 7: Test Setup**

### 7.1 Test S3 Upload
```bash
# Create test file
echo "test" > test.txt

# Test upload (using your new service)
curl -X POST https://your-app.onrender.com/api/video-processing/test-upload
```

### 7.2 Test CloudFront Delivery
```bash
# Test file access via CloudFront
curl -I https://d123456789.cloudfront.net/test-file.txt

# Should return 200 OK with proper headers
```

## 📊 **Cost Optimization**

### S3 Storage Costs (2024 pricing):
- **Standard Storage**: $0.023/GB/month
- **Intelligent-Tiering**: Saves 40-60% automatically
- **Lifecycle Policy**: Move to Glacier after 30 days

### CloudFront Costs:
- **Data Transfer**: $0.085/GB (first 10TB free)
- **Requests**: $0.0075/10k HTTPS requests
- **Invalidate**: Free 1000 paths/month

### Estimated Monthly Costs:
```
100GB video storage: $2.30
500GB transfer: $42.50
1M requests: $0.75
Total: ~$45.55/month
```

## 🔒 **Security Best Practices**

### S3 Security:
- ✅ Block all public access
- ✅ Use CloudFront OAC (Origin Access Control)
- ✅ Enable server-side encryption
- ✅ Use IAM roles instead of root keys

### CloudFront Security:
- ✅ Enforce HTTPS
- ✅ Use WAF if needed
- ✅ Set proper cache headers
- ✅ Restrict allowed methods

## 🚀 **Production Deployment**

### Before Going Live:
- [ ] S3 bucket created and configured
- [ ] IAM user with proper policies
- [ ] CloudFront distribution active
- [ ] Environment variables set in Render
- [ ] AWS SDK installed
- [ ] VideoProcessingService updated to use S3
- [ ] Test uploads and playback
- [ ] Monitor costs for first week

### Rollout Plan:
1. **Deploy S3 configuration** to staging
2. **Test video upload and processing**
3. **Verify CloudFront delivery**
4. **Monitor performance and costs**
5. **Deploy to production**

## 🎯 **Expected Results**

After setup:
- ✅ **Unlimited video storage** (no 50MB limits)
- ✅ **Global CDN delivery** via CloudFront
- ✅ **Cost-effective scaling** (pay-per-use)
- ✅ **Professional video streaming**
- ✅ **HLS adaptive bitrate support**
- ✅ **Fast video loading worldwide**

**Your video system will be enterprise-grade!** 🎉
