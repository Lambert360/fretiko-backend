import express from 'express';
import { backgroundVideoProcessor } from '../services/backgroundVideoProcessor';
import { JwtService } from '@nestjs/jwt';

const authenticateToken = async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers?.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.replace('Bearer ', '');
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    const jwtService = new JwtService({ secret: jwtSecret });
    const decoded: any = jwtService.verify(token);

    if (!decoded?.sub) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = {
      sub: decoded.sub,
      id: decoded.sub,
      email: decoded.email,
      type: decoded.type,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

const router = express.Router();

// Add video to processing queue
router.post('/queue-video', authenticateToken, async (req, res) => {
  try {
    const { videoUrl, platform, priority } = req.body;
    const userId = req.user?.sub;

    if (!videoUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'Video URL is required' 
      });
    }

    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        error: 'User authentication required' 
      });
    }

    // Add to processing queue
    const jobId = await backgroundVideoProcessor.addVideoToQueue(videoUrl, userId, {
      platform,
      priority
    });

    res.json({
      success: true,
      jobId,
      message: 'Video added to processing queue'
    });

  } catch (error) {
    console.error('Queue video error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add video to processing queue'
    });
  }
});

// Get job status
router.get('/job-status/:jobId', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user?.sub;

    const job = backgroundVideoProcessor.getJobStatus(jobId);
    
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    // Ensure user can only see their own jobs
    if (job.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      job: {
        id: job.id,
        status: job.status,
        priority: job.priority,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        result: job.result
      }
    });

  } catch (error) {
    console.error('Get job status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get job status'
    });
  }
});

// Get user's processing jobs
router.get('/my-jobs', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.sub;
    
    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        error: 'User authentication required' 
      });
    }
    
    const jobs = backgroundVideoProcessor.getUserJobs(userId);

    res.json({
      success: true,
      jobs: jobs.map(job => ({
        id: job.id,
        status: job.status,
        priority: job.priority,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        result: job.result
      }))
    });

  } catch (error) {
    console.error('Get user jobs error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user jobs'
    });
  }
});

// Get processing statistics (admin only)
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const stats = backgroundVideoProcessor.getStats();
    
    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get processing statistics'
    });
  }
});

export default router;
