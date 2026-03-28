import express from 'express';
import { videoProcessingService } from '../services/videoProcessingService';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// Define custom user interface for our JWT payload
interface AuthenticatedUser {
  sub: string;
  email: string;
  isAdmin?: boolean;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const authenticateToken = new JwtAuthGuard(require('@nestjs/config').ConfigService).canActivate.bind(new JwtAuthGuard(require('@nestjs/config').ConfigService));

const router = express.Router();

// Process single video for compatibility
router.post('/process-video', authenticateToken, async (req, res) => {
  try {
    const { videoUrl, platform = 'android', quality = 'medium' } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'Video URL is required' 
      });
    }

    // Download video from URL
    const inputPath = await downloadVideo(videoUrl);
    
    // Process video for compatibility
    const result = await videoProcessingService.processVideo({
      inputPath,
      platform,
      quality
    });

    if (result.success) {
      res.json({
        success: true,
        processedVideoUrl: result.outputPath,
        metadata: result.metadata,
        message: 'Video processed successfully for cross-platform compatibility'
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }

  } catch (error) {
    console.error('Video processing error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during video processing'
    });
  }
});

// Validate video format without processing
router.post('/validate-video', authenticateToken, async (req, res) => {
  try {
    const { videoUrl } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'Video URL is required' 
      });
    }

    // Download video for analysis
    const inputPath = await downloadVideo(videoUrl);
    
    // Get metadata without conversion
    const metadata = await videoProcessingService.getVideoMetadata(inputPath);
    
    if (!metadata) {
      return res.status(400).json({
        success: false,
        error: 'Could not analyze video file'
      });
    }

    // Check compatibility
    const needsConversion = videoProcessingService.needsConversion(metadata, req.body.platform || 'android');
    
    res.json({
      success: true,
      isCompatible: !needsConversion,
      metadata,
      recommendations: needsConversion ? {
        codec: 'Convert to H.264 (AVC)',
        resolution: 'Maximum 1920x1080 for Android',
        bitrate: 'Maximum 5 Mbps for Android',
        action: 'Automatic conversion recommended'
      } : null
    });

  } catch (error) {
    console.error('Video validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during video validation'
    });
  }
});

// Helper function to download video from URL
async function downloadVideo(url: string): Promise<string> {
  const https = require('https');
  const fs = require('fs');
  const path = require('path');
  
  return new Promise((resolve, reject) => {
    const fileName = `temp_${Date.now()}.mp4`;
    const filePath = path.join('/tmp', fileName);
    
    const file = fs.createWriteStream(filePath);
    
    https.get(url, (response) => {
      response.pipe(file);
    }).on('error', reject).on('end', () => {
      file.close();
      resolve(filePath);
    });
  });
}

export default router;
