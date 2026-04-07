# 🚀 Render Deployment Guide with FFmpeg

## 📋 Overview

This guide ensures your Fretiko backend has FFmpeg installed on Render for video processing.

## 🛠️ **Option 1: Using render.yaml (Recommended)**

### Step 1: Add render.yaml to your project
The `render.yaml` file is already created in your project root.

### Step 2: Deploy to Render
1. Go to your Render dashboard
2. Connect your GitHub repository
3. Render will automatically detect `render.yaml`
4. Click "Deploy"

### What render.yaml does:
```yaml
buildCommand: |
  apt-get update && apt-get install -y ffmpeg  # Install FFmpeg
  npm install                               # Install dependencies  
  npm run build                            # Build app
```

## 🐳 **Option 2: Using Dockerfile**

### Step 1: Use the Dockerfile
The `Dockerfile` is already created with FFmpeg installation.

### Step 2: Configure Render
1. In Render dashboard → Web Service → Environment
2. Set "Docker" as runtime
3. Connect your repo
4. Render will use the Dockerfile

## 🔍 **Verify FFmpeg Installation**

After deployment, test these endpoints:

### Basic Health Check
```bash
curl https://your-app.onrender.com/health
```

### FFmpeg Status
```bash
curl https://your-app.onrender.com/health/ffmpeg
```

### Video Processing Status  
```bash
curl https://your-app.onrender.com/health/video-processing
```

## ⚠️ **Important Notes**

### Render Environment
- **Base OS**: Ubuntu (Debian-based)
- **Package Manager**: `apt-get`
- **FFmpeg Version**: Latest from Ubuntu repos
- **Node.js**: Version specified in your app

### Build Process
1. Render spins up Ubuntu container
2. Installs FFmpeg via apt-get
3. Installs Node.js dependencies
4. Builds your NestJS app
5. Starts the server

### Troubleshooting

**FFmpeg Not Found**:
```bash
# Check build logs in Render dashboard
# Look for FFmpeg installation errors
```

**Build Timeout**:
- Free Render tier has 15-minute build limit
- FFmpeg installation takes ~2-3 minutes
- Should be within limits

**Memory Issues**:
- FFmpeg video processing is memory-intensive
- Consider upgrading to paid Render tier for production

## 🎯 **Production Checklist**

Before going live with video processing:

- [ ] Deploy with render.yaml or Dockerfile
- [ ] Verify `/health/ffmpeg` returns FFmpeg version
- [ ] Test video upload and processing
- [ ] Verify H.265 → H.264 conversion works
- [ ] Check HLS generation functionality
- [ ] Monitor memory usage during processing

## 🚨 **Critical for Video Processing**

**Without FFmpeg installation, your video processing will fail with:**
```
Error: Command failed: ffmpeg -i input.mp4 ...
```

**With proper installation, you'll see:**
```
✅ FFmpeg available: ffmpeg version 4.4.0
🎬 Video processing successful!
```

## 📞 **Support**

If you encounter issues:
1. Check Render build logs
2. Verify `apt-get install ffmpeg` succeeded
3. Test `/health/ffmpeg` endpoint
4. Ensure environment variables are set

**Your video processing system is ready for production once FFmpeg is installed on Render!** 🎉
