import { Router } from 'express';
import { videoProcessingController } from '../controllers/videoProcessingController';
import { JwtService } from '@nestjs/jwt';

const router = Router();

// All routes require authentication
router.use(async (req, res, next) => {
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
});

/**
 * POST /api/video-processing/submit
 * Submit a video for processing
 */
router.post('/submit', videoProcessingController.submitVideoForProcessing);

/**
 * GET /api/video-processing/status/:job_id
 * Get processing status for a specific job
 */
router.get('/status/:job_id', videoProcessingController.getProcessingStatus);

/**
 * GET /api/video-processing/jobs
 * Get all processing jobs for the current user
 * Query params: status, limit, offset
 */
router.get('/jobs', videoProcessingController.getUserProcessingJobs);

/**
 * DELETE /api/video-processing/cancel/:job_id
 * Cancel a processing job
 */
router.delete('/cancel/:job_id', videoProcessingController.cancelProcessingJob);

/**
 * POST /api/video-processing/retry/:job_id
 * Retry a failed processing job
 */
router.post('/retry/:job_id', videoProcessingController.retryProcessingJob);

export default router;
