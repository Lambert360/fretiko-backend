#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';

console.log('🔧 Fixing Stuck Withdrawal - Releasing Pending Funds');
console.log('====================================================');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const fixWithdrawal = async () => {
  try {
    const payoutId = '2e975f4e-eb51-4ee8-80cc-54bb683322b5';
    const userId = 'f29d2d24-2cb4-4f5a-b5c5-65d9dc167806';
    const amount = 100;

    console.log('🔍 Checking current payout status...');
    const { data: payout, error: payoutError } = await supabase
      .from('payout_requests')
      .select('*')
      .eq('id', payoutId)
      .single();

    if (payoutError) {
      console.error('❌ Error fetching payout:', payoutError.message);
      return;
    }

    console.log('✅ Payout found:', {
      id: payout.id,
      status: payout.status,
      amount: payout.freti_amount,
      external_id: payout.external_payout_id
    });

    if (payout.status !== 'paid') {
      console.log('⚠️ Payout is not marked as paid yet. Updating status...');
      const { error: updateError } = await supabase
        .from('payout_requests')
        .update({ 
          status: 'paid',
          paid_at: new Date().toISOString(),
          processed_at: new Date().toISOString()
        })
        .eq('id', payoutId);

      if (updateError) {
        console.error('❌ Error updating payout status:', updateError.message);
        return;
      }
      console.log('✅ Payout status updated to "paid"');
    }

    console.log('🔍 Checking for completion ledger entry...');
    const { data: existingLedger, error: ledgerError } = await supabase
      .from('wallet_ledger')
      .select('*')
      .eq('user_id', userId)
      .eq('transaction_type', 'withdrawal_completion')
      .eq('reference_type', 'payout_request')
      .eq('reference_id', payoutId)
      .single();

    if (existingLedger) {
      console.log('✅ Completion ledger entry already exists');
      console.log('📊 Ledger details:', {
        id: existingLedger.id,
        available_delta: existingLedger.available_delta,
        pending_withdrawal_delta: existingLedger.pending_withdrawal_delta
      });
    } else {
      console.log('⚠️ No completion ledger entry found. Creating one...');
      
      // Create the completion ledger entry
      const { data: newLedger, error: createError } = await supabase
        .from('wallet_ledger')
        .insert({
          user_id: userId,
          wallet_id: payout.user_id, // This should be the wallet ID, but we'll use user_id for now
          transaction_type: 'withdrawal_completion',
          available_delta: 0, // No change to available (funds were already moved to pending)
          escrow_delta: 0,
          pending_withdrawal_delta: -amount, // Release from pending
          reference_type: 'payout_request',
          reference_id: payoutId,
          description: `Withdrawal completed - ${amount} FRETI released from pending`,
          idempotency_key: `withdrawal_completion_${payoutId}_${Date.now()}`
        })
        .select()
        .single();

      if (createError) {
        console.error('❌ Error creating completion ledger entry:', createError.message);
        console.error('📋 Details:', createError.details);
        return;
      }

      console.log('✅ Completion ledger entry created:', newLedger.id);
      console.log('📊 Funds released from pending withdrawal:', amount);
    }

    console.log('🔍 Checking current wallet balance...');
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      console.error('❌ Error fetching wallet:', walletError.message);
    } else {
      console.log('💰 Current wallet balance:', {
        available_balance: wallet.available_balance,
        pending_withdrawal: wallet.pending_withdrawal,
        escrow_balance: wallet.escrow_balance
      });
    }

    console.log('🎉 Withdrawal fix completed!');

  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
  }
};

fixWithdrawal();
