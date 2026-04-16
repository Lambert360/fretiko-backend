#!/usr/bin/env node

// Load environment variables
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { videoProcessingService } = require('./dist/src/services/videoProcessingService');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// The problematic video URL
const originalVideoUrl = 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/media/3b5284d5-ddeb-49fe-80eb-af72de75afd7/1756928977216-13hzp.mp4';

async function downloadVideo(url) {
  return new Promise((resolve, reject) => {
    const fileName = `temp_video_${Date.now()}.mp4`;
    const filePath = path.join('/tmp', fileName);
    
    const file = fs.createWriteStream(filePath);
    
    const req = https.get(url, (response) => {
      response.pipe(file);
    });
    
    req.on('error', reject);
    
    file.on('finish', () => {
      file.close();
      resolve(filePath);
    });
    
    file.on('error', reject);
  });
}

async function manualProcessVideo() {
  let inputPath = null;
  
  try {
    console.log('🎥 Manually processing problematic video...');
    console.log('Original URL:', originalVideoUrl);
    
    // Step 1: Download the video
    console.log('⬇️ Downloading video...');
    inputPath = await downloadVideo(originalVideoUrl);
    console.log('Downloaded to:', inputPath);
    
    // Step 2: Process the video
    console.log('⚙️ Processing video for Android compatibility...');
    const result = await videoProcessingService.processVideo({
      inputPath,
      platform: 'android',
      quality: 'medium',
      generateThumbnail: true
    });
    
    if (!result.success) {
      console.error('❌ Video processing failed:', result.error);
      return;
    }
    
    console.log('✅ Video processing successful!');
    console.log('Processed video URL:', result.outputPath);
    console.log('Thumbnail URL:', result.thumbnailUrl);
    
    // Step 3: Create a record in chat_file_uploads for the processed video
    const processedFileData = {
      message_id: `manual_${Date.now()}`,
      uploader_id: 'system',
      file_name: '1756928977216-13hzp-processed.mp4',
      file_size: 0, // Will be updated by Supabase trigger
      file_type: 'video',
      mime_type: 'video/mp4',
      storage_path: 'media/processed/1756928977216-13hzp-processed.mp4',
      public_url: result.outputPath,
      metadata: {
        originalVideoUrl: originalVideoUrl,
        videoProcessing: {
          processing: false,
          processed: true,
          processedVideoUrl: result.outputPath,
          processedAt: new Date().toISOString(),
          originalCodec: 'hevc',
          manualProcessing: true
        }
      }
    };
    
    const { data: insertData, error: insertError } = await supabase
      .from('chat_file_uploads')
      .insert(processedFileData)
      .select();
    
    if (insertError) {
      console.error('❌ Failed to create database record:', insertError);
    } else {
      console.log('✅ Database record created for processed video');
      console.log('Record ID:', insertData[0].id);
    }
    
    console.log('\n🎉 SOLUTION SUMMARY:');
    console.log('==================');
    console.log('Original video (HEVC):', originalVideoUrl);
    console.log('Processed video (H.264):', result.outputPath);
    console.log('');
    console.log('The processed video is now Android compatible and should play without errors.');
    console.log('You can update any references to use the new URL.');
    
  } catch (error) {
    console.error('💥 Manual processing failed:', error);
  } finally {
    // Cleanup
    if (inputPath && fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);
      console.log('🗑️ Cleaned up temporary file');
    }
  }
}

// Run the manual process
manualProcessVideo();
