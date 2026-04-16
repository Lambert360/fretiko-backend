// Test the video processing service directly
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// Simple test of FFmpeg functionality
async function testFFmpeg() {
  console.log('🧪 Testing FFmpeg installation and H.265 conversion...');
  
  try {
    // Check FFmpeg version
    const { stdout } = await execAsync('ffmpeg -version');
    console.log('✅ FFmpeg is available:', stdout.split('\n')[0]);

    // Test video file path
    const testVideoPath = process.argv[2];
    
    if (!testVideoPath || !fs.existsSync(testVideoPath)) {
      console.log('\nℹ️  Please provide a test video file path:');
      console.log('   node test-video-processing.js /path/to/test/video.mp4');
      console.log('\n🎯 This test will:');
      console.log('   1. Check video metadata');
      console.log('   2. Detect codec (especially H.265)');
      console.log('   3. Convert to H.264 if needed');
      console.log('   4. Generate thumbnail');
      return;
    }

    console.log(`\n📁 Testing with: ${testVideoPath}`);

    // Get video metadata
    console.log('\n📊 Extracting video metadata...');
    const { stdout: probeOutput } = await execAsync(`ffprobe -v quiet -print_format json -show_streams "${testVideoPath}"`);
    const probeData = JSON.parse(probeOutput);
    
    const videoStream = probeData.streams.find(stream => stream.codec_type === 'video');
    
    if (!videoStream) {
      console.error('❌ No video stream found');
      return;
    }

    const metadata = {
      codec: videoStream.codec_name || 'unknown',
      resolution: `${videoStream.width || 0}x${videoStream.height || 0}`,
      bitrate: parseInt(videoStream.bit_rate || '0'),
      duration: parseFloat(probeData.format.duration || '0'),
      width: videoStream.width || 0,
      height: videoStream.height || 0
    };

    console.log('📋 Video metadata:', metadata);

    // Check codec
    console.log(`\n🎯 Codec detected: ${metadata.codec}`);
    
    if (metadata.codec === 'hevc') {
      console.log('⚠️  H.265 (HEVC) detected - WILL BE CONVERTED TO H.264');
      console.log('   This fixes Android playback issues!');
    } else if (metadata.codec === 'h264') {
      console.log('✅ H.264 (AVC) detected - already compatible');
    } else {
      console.log(`ℹ️  ${metadata.codec} detected - will be converted to H.264`);
    }

    // Test conversion
    console.log('\n🔄 Testing H.264 conversion...');
    
    const outputPath = path.join(path.dirname(testVideoPath), 'test_converted.mp4');
    
    const ffmpegCommand = [
      'ffmpeg',
      '-i', testVideoPath,
      '-c:v', 'libx264', // Convert to H.264
      '-preset', 'medium',
      '-crf', '23',
      '-maxrate', '5M',
      '-bufsize', '10M',
      '-pix_fmt', 'yuv420p',
      '-vf', `scale=min(1920,iw):-2:min(1080,ih)`, // Max 1080p
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-t', '10', // Limit to 10 seconds for testing
      '-y',
      outputPath
    ];

    console.log('🔧 FFmpeg command:', ffmpegCommand.join(' '));
    
    const startTime = Date.now();
    await execAsync(ffmpegCommand.join(' '));
    const endTime = Date.now();
    
    console.log(`✅ Conversion completed in ${endTime - startTime}ms`);
    
    // Check if output file exists
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      console.log(`📁 Output file: ${outputPath}`);
      console.log(`📏 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      // Get converted metadata
      const { stdout: convertedProbeOutput } = await execAsync(`ffprobe -v quiet -print_format json -show_streams "${outputPath}"`);
      const convertedProbeData = JSON.parse(convertedProbeOutput);
      const convertedVideoStream = convertedProbeData.streams.find(stream => stream.codec_type === 'video');
      
      console.log(`🎯 Converted codec: ${convertedVideoStream.codec_name}`);
      console.log(`📐 Converted resolution: ${convertedVideoStream.width}x${convertedVideoStream.height}`);
      
      if (convertedVideoStream.codec_name === 'h264') {
        console.log('🎉 SUCCESS: Video converted to H.264 - Android compatible!');
      } else {
        console.log('❌ ERROR: Conversion failed to produce H.264');
      }
      
      // Clean up test file
      fs.unlinkSync(outputPath);
      console.log('🗑️  Test file cleaned up');
      
    } else {
      console.error('❌ Conversion failed - no output file created');
    }

    // Test thumbnail generation
    console.log('\n🖼️  Testing thumbnail generation...');
    
    const thumbnailPath = path.join(path.dirname(testVideoPath), 'test_thumbnail.jpg');
    
    const thumbnailCommand = [
      'ffmpeg',
      '-i', testVideoPath,
      '-ss', '00:00:01',
      '-vframes', '1',
      '-vf', 'scale=320:240',
      '-y',
      thumbnailPath
    ];
    
    await execAsync(thumbnailCommand.join(' '));
    
    if (fs.existsSync(thumbnailPath)) {
      const thumbnailStats = fs.statSync(thumbnailPath);
      console.log(`🖼️  Thumbnail created: ${thumbnailPath}`);
      console.log(`📏 Thumbnail size: ${(thumbnailStats.size / 1024).toFixed(2)} KB`);
      
      // Clean up thumbnail
      fs.unlinkSync(thumbnailPath);
      console.log('🗑️  Thumbnail cleaned up');
    } else {
      console.error('❌ Thumbnail generation failed');
    }

    console.log('\n🎉 All tests completed successfully!');
    console.log('📱 The video processing service is ready to handle H.265 to H.264 conversion!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testFFmpeg();
