import { Router } from 'express';
import { videoProcessingController } from '../controllers/videoProcessingController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

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
