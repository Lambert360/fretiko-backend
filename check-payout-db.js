#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';

console.log('🔍 Checking Database for Payout Records');
console.log('=====================================');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const checkPayout = async () => {
  try {
    // Check by payout ID (reference)
    console.log('🔍 Checking by payout ID: b900b3c6-4e88-41fd-843d-c3d832f59c85');
    const { data: payoutById, error: error1 } = await supabase
      .from('payout_requests')
      .select('*')
      .eq('id', 'b900b3c6-4e88-41fd-843d-c3d832f59c85')
      .single();

    if (payoutById) {
      console.log('✅ Found payout by ID:', payoutById);
      console.log('   Status:', payoutById.status);
      console.log('   External ID:', payoutById.external_payout_id);
      console.log('   Amount:', payoutById.freti_amount);
    } else {
      console.log('❌ Not found by ID, error:', error1?.message);
    }

    // Check by external payout ID
    console.log('\n🔍 Checking by external payout ID: 2121132');
    const { data: payoutByExtId, error: error2 } = await supabase
      .from('payout_requests')
      .select('*')
      .eq('external_payout_id', '2121132')
      .single();

    if (payoutByExtId) {
      console.log('✅ Found payout by external ID:', payoutByExtId);
      console.log('   Status:', payoutByExtId.status);
      console.log('   Payout ID:', payoutByExtId.id);
      console.log('   Amount:', payoutByExtId.freti_amount);
    } else {
      console.log('❌ Not found by external ID, error:', error2?.message);
    }

    // List all recent payouts
    console.log('\n📋 Recent payouts:');
    const { data: allPayouts } = await supabase
      .from('payout_requests')
      .select('id, external_payout_id, status, freti_amount, created_at')
      .eq('user_id', 'f29d2d24-2cb4-4f5a-b5c5-65d9dc167806')
      .order('created_at', 'desc')
      .limit(5);

    allPayouts?.forEach(payout => {
      console.log(`   ${payout.id}: ${payout.external_payout_id} (${payout.status}) - ${payout.freti_amount} FRETI`);
    });

  } catch (error) {
    console.error('❌ Database error:', error.message);
  }
};

checkPayout();
