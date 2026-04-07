import { Router } from 'express';
import { videoProcessingController } from '../controllers/videoProcessingController';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConfigService } from '@nestjs/config';

const router = Router();

// Create auth middleware
const configService = new ConfigService();
const jwtAuthGuard = new JwtAuthGuard(configService);

const authenticateToken = async (req: any, res: any, next: any) => {
  try {
    const canActivate = await jwtAuthGuard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as any);
    
    if (!canActivate) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

// All routes require authentication
router.use(authenticateToken);

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
