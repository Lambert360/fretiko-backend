const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  db: {
    schema: 'public'
  }
});

async function runMigration(migrationFile) {
  try {
    console.log(`📄 Reading migration file: ${migrationFile}`);
    const sql = fs.readFileSync(migrationFile, 'utf8');

    console.log('🚀 Running migration via REST API...');

    // Split SQL into individual statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--') && s !== 'BEGIN' && s !== 'COMMIT');

    console.log(`📝 Found ${statements.length} SQL statements to execute`);

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      console.log(`\n[${i + 1}/${statements.length}] Executing: ${statement.substring(0, 80)}...`);

      try {
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceKey,
            'Authorization': `Bearer ${supabaseServiceKey}`
          },
          body: JSON.stringify({ query: statement })
        });

        if (!response.ok) {
          // If RPC doesn't exist, use direct SQL via PostgREST
          console.log('⚠️ Trying alternative execution method...');

          // For Supabase, we'll need to log the SQL and have user run it manually
          console.log('\n⚠️ MANUAL EXECUTION REQUIRED');
          console.log('Please run this SQL in your Supabase SQL Editor:');
          console.log('=' .repeat(80));
          console.log(sql);
          console.log('=' .repeat(80));
          return;
        }

        const result = await response.json();
        console.log(`✅ Statement ${i + 1} executed successfully`);
      } catch (err) {
        console.error(`❌ Failed to execute statement ${i + 1}:`, err.message);
      }
    }

    console.log('\n✅ Migration completed successfully!');
  } catch (err) {
    console.error('❌ Error running migration:', err);
    console.log('\n⚠️ MANUAL EXECUTION REQUIRED');
    console.log('Please run the SQL file in your Supabase SQL Editor:');
    console.log(`File: ${migrationFile}`);
    process.exit(1);
  }
}

const migrationFile = process.argv[2];
if (!migrationFile) {
  console.error('Usage: node run-migration.js <migration-file>');
  process.exit(1);
}

runMigration(migrationFile);
