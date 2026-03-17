#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';

console.log('🔍 Testing Withdrawal Transaction Flow Fix');
console.log('==========================================');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const testWithdrawalFlow = async () => {
  try {
    const userId = 'f29d2d24-2cb4-4f5a-b5c5-65d9dc167806';
    
    // Get wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      console.error('❌ Error fetching wallet:', walletError.message);
      return;
    }

    console.log('💰 Current Wallet Balance:');
    console.log(`   Available: ${wallet.available_balance} FRETI`);
    console.log(`   Escrow: ${wallet.escrow_balance} FRETI`);
    console.log(`   Pending Withdrawal: ${wallet.pending_withdrawal_balance || 0} FRETI`);
    console.log('');

    // Get recent withdrawal-related ledger entries
    const { data: ledgerEntries, error: ledgerError } = await supabase
      .from('wallet_ledger')
      .select('*')
      .eq('user_id', userId)
      .in('transaction_type', ['withdrawal_request', 'withdrawal_burn'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (ledgerError) {
      console.error('❌ Error fetching ledger entries:', ledgerError.message);
      return;
    }

    console.log('📋 Recent Withdrawal Ledger Entries:');
    ledgerEntries.forEach((entry, index) => {
      console.log(`${index + 1}. Transaction Type: ${entry.transaction_type}`);
      console.log(`   Available Delta: ${entry.available_delta}`);
      console.log(`   Escrow Delta: ${entry.escrow_delta}`);
      console.log(`   Pending Withdrawal Delta: ${entry.pending_withdrawal_delta}`);
      console.log(`   Description: ${entry.description}`);
      console.log(`   Reference: ${entry.reference_id}`);
      console.log(`   Created: ${entry.created_at}`);
      console.log('');
    });

    // Analyze the flow
    const withdrawalRequests = ledgerEntries.filter(entry => entry.transaction_type === 'withdrawal_request');
    const withdrawalBurns = ledgerEntries.filter(entry => entry.transaction_type === 'withdrawal_burn');

    console.log('🔍 Transaction Flow Analysis:');
    console.log(`   Withdrawal Requests (hold): ${withdrawalRequests.length}`);
    console.log(`   Withdrawal Burns (completion/refund): ${withdrawalBurns.length}`);
    console.log('');

    // Check for proper pairs
    const properPairs = [];
    withdrawalRequests.forEach(request => {
      const matchingBurn = withdrawalBurns.find(burn => 
        burn.reference_id === request.reference_id && 
        burn.created_at > request.created_at
      );
      if (matchingBurn) {
        properPairs.push({ request, burn: matchingBurn });
      }
    });

    console.log('✅ Proper Withdrawal Pairs:');
    properPairs.forEach((pair, index) => {
      console.log(`${index + 1}. Payout: ${pair.request.reference_id}`);
      console.log(`   Request: -${Math.abs(pair.request.available_delta)} available → +${pair.request.pending_withdrawal_delta} pending`);
      console.log(`   Completion: ${pair.burn.available_delta} available, ${pair.burn.pending_withdrawal_delta} pending`);
      
      if (pair.burn.pending_withdrawal_delta < 0) {
        console.log(`   ✅ FUNDS BURNED CORRECTLY`);
      } else if (pair.burn.available_delta > 0) {
        console.log(`   🔄 FUNDS REFUNDED`);
      }
      console.log('');
    });

    // Check for unmatched requests (stuck in pending)
    const unmatchedRequests = withdrawalRequests.filter(request => 
      !properPairs.find(pair => pair.request.id === request.id)
    );

    if (unmatchedRequests.length > 0) {
      console.log('⚠️ Unmatched Withdrawal Requests (stuck in pending):');
      unmatchedRequests.forEach((request, index) => {
        console.log(`${index + 1}. Payout: ${request.reference_id}`);
        console.log(`   Amount: ${Math.abs(request.available_delta)} FRETI`);
        console.log(`   Created: ${request.created_at}`);
        console.log(`   Status: Stuck in pending - needs webhook completion`);
      });
    } else {
      console.log('✅ All withdrawal requests have matching completions/refunds');
    }

  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
  }
};

testWithdrawalFlow();
