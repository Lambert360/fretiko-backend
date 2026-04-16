-- Update About Content Image URLs to Full Supabase URLs
-- This script updates existing about_content records with proper Supabase storage URLs

UPDATE about_content 
SET image = 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/website-content/about-content/mission-image.jpg'
WHERE section = 'mission';

UPDATE about_content 
SET image = 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/website-content/about-content/vision-image.jpg'
WHERE section = 'vision';

UPDATE about_content 
SET image = 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/website-content/about-content/team-image.jpg'
WHERE section = 'team';

UPDATE about_content 
SET image = 'https://piytfaopdlxltdczdvtk.supabase.co/storage/v1/object/public/website-content/about-content/achievements-image.jpg'
WHERE section = 'achievements';

-- Verify the updates
SELECT section, title, image FROM about_content ORDER BY order_num;
