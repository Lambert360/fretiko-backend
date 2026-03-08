-- =====================================================
-- UPDATE EMAIL TEMPLATES FOR TOKEN VERIFICATION
-- =====================================================
-- Purpose: Update Supabase email templates to show 6-digit tokens
-- Run this in Supabase SQL Editor

-- =====================================================
-- STEP 1: CHECK CURRENT TEMPLATES
-- =====================================================

-- View current email templates
SELECT 'Current email templates:' as info, template_name, subject, content
FROM auth.mails 
WHERE template_name = 'confirm_signup';

-- =====================================================
-- STEP 2: UPDATE CONFIRM SIGNUP TEMPLATE
-- =====================================================

-- Update the confirm signup template to show tokens
UPDATE auth.mails 
SET 
  subject = 'Verify Your Fretiko Account',
  content = '
<h2>Verify Your Email Address</h2>
<p>Thank you for signing up for Fretiko! Your verification code is:</p>
<div style="background: #f0f0f0; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
  <span style="font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #333;">{{.Token}}</span>
</div>
<p>This code will expire in 24 hours.</p>
<p>Enter this code in the Fretiko app to complete your registration.</p>
<p>If you didn''t request this code, please ignore this email.</p>
<hr>
<p style="font-size: 12px; color: #666;">
  © 2026 Fretiko. All rights reserved.
</p>
'
WHERE template_name = 'confirm_signup';

-- =====================================================
-- STEP 3: VERIFY UPDATE
-- =====================================================

-- Verify the template was updated
SELECT 'Updated template:' as info, template_name, subject, content
FROM auth.mails 
WHERE template_name = 'confirm_signup';

-- =====================================================
-- STEP 4: ADD RESEND TEMPLATE (OPTIONAL)
-- =====================================================

-- Add a template for resending tokens
INSERT INTO auth.mails (template_name, subject, content)
VALUES (
  'resend_verification_token',
  'New Verification Code - Fretiko',
  '
<h2>New Verification Code</h2>
<p>You requested a new verification code for your Fretiko account:</p>
<div style="background: #f0f0f0; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
  <span style="font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #333;">{{.Token}}</span>
</div>
<p>This code will expire in 24 hours.</p>
<p>Enter this code in the Fretiko app to complete your registration.</p>
<p>If you didn''t request this code, please ignore this email.</p>
<hr>
<p style="font-size: 12px; color: #666;">
  © 2026 Fretiko. All rights reserved.
</p>
'
)
ON CONFLICT (template_name) DO UPDATE SET
  subject = EXCLUDED.subject,
  content = EXCLUDED.content;

-- =====================================================
-- STEP 5: FINAL VERIFICATION
-- =====================================================

-- Show all verification-related templates
SELECT 'All verification templates:' as info, template_name, subject
FROM auth.mails 
WHERE template_name IN ('confirm_signup', 'resend_verification_token')
ORDER BY template_name;

COMMIT;
