#!/usr/bin/env node

// Load environment variables
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { videoProcessingService } = require('./dist/src/services/videoProcessingService');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

// The problematic video URL from the logs
const problematicVideoUrl = 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/media/3b5284d5-ddeb-49fe-80eb-af72de75afd7/1756928977216-13hzp.mp4';

async function fixExistingVideo() {
  try {
    console.log('=== FIXING EXISTING HEVC VIDEO ===');
    console.log('Target URL:', problematicVideoUrl);
    
    // Step 1: Find all services that use this video
    console.log('\n1. Searching for services with this video...');
    const { data: services, error: serviceError } = await supabase
      .from('services')
      .select('*')
      .or(`videos.cs.{${problematicVideoUrl}},primary_media_url.eq.${problematicVideoUrl}`);
    
    if (serviceError) {
      console.error('Error finding services:', serviceError);
      return;
    }
    
    console.log(`Found ${services.length} service(s) using this video:`);
    services.forEach(service => {
      console.log(`  - ${service.name} (ID: ${service.id})`);
    });
    
    if (services.length === 0) {
      console.log('No services found with this video URL.');
      return;
    }
    
    // Step 2: Process the video
    console.log('\n2. Processing video for Android compatibility...');
    
    // Download and process the video
    const https = require('https');
    const fs = require('fs');
    const path = require('path');
    
    const downloadVideo = (url) => {
      return new Promise((resolve, reject) => {
        const fileName = `fix_video_${Date.now()}.mp4`;
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
    };
    
    const inputPath = await downloadVideo(problematicVideoUrl);
    console.log('Video downloaded to:', inputPath);
    
    try {
      const result = await videoProcessingService.processVideo({
        inputPath,
        platform: 'android',
        quality: 'medium',
        generateThumbnail: true
      });
      
      if (!result.success) {
        console.error('Video processing failed:', result.error);
        return;
      }
      
      console.log('Video processing successful!');
      console.log('Processed URL:', result.outputPath);
      
      // Step 3: Update all services to use the processed video
      console.log('\n3. Updating services with processed video...');
      
      for (const service of services) {
        console.log(`Updating service: ${service.name}`);
        
        let updateData = {};
        
        // Update primary_media_url if it matches
        if (service.primary_media_url === problematicVideoUrl) {
          updateData.primary_media_url = result.outputPath;
        }
        
        // Update videos array if it contains the problematic URL
        if (service.videos && service.videos.includes(problematicVideoUrl)) {
          const updatedVideos = service.videos.map(url => 
            url === problematicVideoUrl ? result.outputPath : url
          );
          updateData.videos = updatedVideos;
        }
        
        if (Object.keys(updateData).length > 0) {
          const { error: updateError } = await supabase
            .from('services')
            .update(updateData)
            .eq('id', service.id);
          
          if (updateError) {
            console.error(`Failed to update service ${service.id}:`, updateError);
          } else {
            console.log(`  - Updated primary_media_url: ${updateData.primary_media_url ? 'YES' : 'NO'}`);
            console.log(`  - Updated videos array: ${updateData.videos ? 'YES' : 'NO'}`);
          }
        }
      }
      
      console.log('\n=== FIX COMPLETE ===');
      console.log('The video has been processed and all references updated.');
      console.log('The video should now play on Android devices without errors.');
      console.log('\nProcessed video URL:', result.outputPath);
      console.log('Original video URL:', problematicVideoUrl);
      
    } finally {
      // Cleanup
      if (fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
        console.log('Cleaned up temporary file');
      }
    }
    
  } catch (error) {
    console.error('Fix failed:', error);
  }
}

// Run the fix
fixExistingVideo();
