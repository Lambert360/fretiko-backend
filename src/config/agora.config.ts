/**
 * Agora Configuration
 * 
 * Setup Instructions:
 * 1. Create Agora account at https://www.agora.io
 * 2. Create a project in Agora Console
 * 3. Get your App ID and App Certificate
 * 4. Add to .env file:
 *    AGORA_APP_ID=your_app_id_here
 *    AGORA_APP_CERTIFICATE=your_app_certificate_here
 * 5. Install agora-token:
 *    npm install agora-token
 * 6. Enable HLS extension in Agora Console
 */

export interface AgoraConfig {
  appId: string;
  appCertificate: string;
  tokenExpirationInSeconds: number;
  hlsEnabled: boolean;
  cloudRecordingEnabled: boolean;
}

export const getAgoraConfig = (): AgoraConfig => {
  const appId = process.env.AGORA_APP_ID || '';
  const appCertificate = process.env.AGORA_APP_CERTIFICATE || '';

  if (!appId || !appCertificate) {
    console.warn('⚠️  Agora credentials not configured. Live streaming will not work.');
    console.warn('   Add AGORA_APP_ID and AGORA_APP_CERTIFICATE to your .env file.');
  }

  return {
    appId,
    appCertificate,
    tokenExpirationInSeconds: 86400, // 24 hours
    hlsEnabled: true, // Enable HLS for viewers (Expo Go compatible)
    cloudRecordingEnabled: false, // Enable if you want to save streams
  };
};

/**
 * Agora HLS Configuration
 * 
 * When a vendor starts broadcasting, Agora can automatically transcode
 * the RTC stream to HLS format for viewers to watch via HTTP.
 */
export const agoraHLSConfig = {
  // HLS transcoding settings
  width: 720,
  height: 1280,
  videoBitrate: 1500, // kbps
  videoFramerate: 30,
  videoGop: 2, // seconds
  audioSampleRate: 48000,
  audioBitrate: 128, // kbps
  audioChannels: 2,

  // HLS output settings
  hlsLifeCycle: 60, // seconds
  hlsWindow: 5, // segments
};

/**
 * Token Roles
 */
export enum AgoraRole {
  PUBLISHER = 1, // Can publish audio/video (vendor)
  SUBSCRIBER = 2, // Can only subscribe (viewer, but we use HLS instead)
}

/**
 * Example usage in live-sales.service.ts:
 * 
 * const { RtcTokenBuilder, RtcRole } = require('agora-token');
 * import { getAgoraConfig, AgoraRole } from '../config/agora.config';
 * 
 * const config = getAgoraConfig();
 * const token = RtcTokenBuilder.buildTokenWithUid(
 *   config.appId,
 *   config.appCertificate,
 *   channelName,
 *   uid,
 *   AgoraRole.PUBLISHER,
 *   privilegeExpiredTs
 * );
 */

export default getAgoraConfig;

