const bcrypt = require('bcrypt');

// Password to hash
const password = 'Admin123!@#';

// Generate bcrypt hash
bcrypt.hash(password, 10, (err, hash) => {
  if (err) {
    console.error('Error hashing password:', err);
    return;
  }

  console.log('\n==============================================');
  console.log('SUPER ADMIN SETUP SQL');
  console.log('==============================================\n');
  console.log('Copy and paste this SQL into your Supabase SQL Editor:\n');
  console.log('-- Delete existing super admin (if any)');
  console.log(`DELETE FROM public.staff_accounts WHERE email = 'superadmin@fretiko.com';\n`);
  console.log('-- Create super admin with proper password hash');
  console.log(`INSERT INTO public.staff_accounts (
    staff_id,
    email,
    password_hash,
    full_name,
    department_id,
    role,
    is_active,
    must_change_password,
    created_by
) VALUES (
    'FTK-2025-0001',
    'superadmin@fretiko.com',
    '${hash}',
    'Super Administrator',
    NULL,
    'super_admin',
    true,
    true,
    NULL
);`);
  console.log('\n==============================================');
  console.log('LOGIN CREDENTIALS');
  console.log('==============================================');
  console.log('Email: superadmin@fretiko.com');
  console.log('Password: Admin123!@#');
  console.log('==============================================\n');
});
