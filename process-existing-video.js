#!/usr/bin/env node

// Load environment variables
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { StorageClient } = require('@supabase/storage-js');

// Initialize Supabase clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const storageClient = new StorageClient(
  process.env.SUPABASE_URL + '/storage/v1',
  {
    apikey: process.env.SUPABASE_ANON_KEY || '',
  }
);

// The problematic video URL
const originalVideoUrl = 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/media/3b5284d5-ddeb-49fe-80eb-af72de75afd7/1756928977216-13hzp.mp4';

async function processExistingVideo() {
  try {
    console.log('🎥 Processing existing problematic video...');
    console.log('Original URL:', originalVideoUrl);
    
    // Step 1: Find the video in database
    const { data: fileData, error: fetchError } = await supabase
      .from('chat_file_uploads')
      .select('*')
      .eq('public_url', originalVideoUrl)
      .single();
    
    if (fetchError || !fileData) {
      console.error('❌ Could not find video in database:', fetchError);
      return;
    }
    
    console.log('✅ Found video in database:', fileData.id);
    console.log('File type:', fileData.file_type);
    console.log('Message ID:', fileData.message_id);
    
    // Step 2: Add to background processing queue
    const { backgroundVideoProcessor } = require('./dist/src/services/backgroundVideoProcessor');
    
    const jobId = await backgroundVideoProcessor.addVideoToQueue(originalVideoUrl, fileData.uploader_id, {
      serviceId: fileData.message_id,
      platform: 'android',
      priority: 'high'
    });
    
    console.log('✅ Video added to processing queue with job ID:', jobId);
    
    // Step 3: Check job status after a delay
    console.log('⏳ Waiting 10 seconds for processing to start...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    const jobStatus = backgroundVideoProcessor.getJobStatus(jobId);
    console.log('📊 Job status:', jobStatus);
    
    if (jobStatus && jobStatus.status === 'completed') {
      console.log('✅ Video processing completed!');
      console.log('Processed video URL:', jobStatus.result.processedVideoUrl);
      
      // Update the database with the new URL
      const { error: updateError } = await supabase
        .from('chat_file_uploads')
        .update({
          public_url: jobStatus.result.processedVideoUrl,
          metadata: {
            ...fileData.metadata,
            videoProcessing: {
              processing: false,
              processed: true,
              processedVideoUrl: jobStatus.result.processedVideoUrl,
              processedAt: new Date().toISOString(),
              originalCodec: 'hevc',
              jobId: jobId
            }
          }
        })
        .eq('id', fileData.id);
      
      if (updateError) {
        console.error('❌ Failed to update database:', updateError);
      } else {
        console.log('✅ Database updated with processed video URL');
      }
    } else if (jobStatus && jobStatus.status === 'processing') {
      console.log('⏳ Video is still being processed...');
      console.log('Check back later for the processed version.');
    } else if (jobStatus && jobStatus.status === 'failed') {
      console.error('❌ Video processing failed:', jobStatus.error);
    } else {
      console.error('❌ Job not found');
    }
    
  } catch (error) {
    console.error('💥 Process failed:', error);
  }
}

// Run the process
processExistingVideo();
