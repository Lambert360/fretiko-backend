export interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  cloudFrontDomain?: string;
}

export const s3Config: S3Config = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  region: process.env.AWS_REGION || 'us-east-1',
  bucket: process.env.AWS_S3_BUCKET || 'fretiko-videos',
  cloudFrontDomain: process.env.AWS_CLOUDFRONT_DOMAIN || ''
};

// Validate required environment variables
export function validateS3Config(): { isValid: boolean; missing: string[] } {
  const missing: string[] = [];
  
  if (!s3Config.accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
  if (!s3Config.secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
  if (!s3Config.region) missing.push('AWS_REGION');
  if (!s3Config.bucket) missing.push('AWS_S3_BUCKET');
  
  return {
    isValid: missing.length === 0,
    missing
  };
}
