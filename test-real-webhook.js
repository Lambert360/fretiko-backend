#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

console.log('🔍 Testing REAL Webhook with Actual Transfer ID');
console.log('============================================');

const ngrokUrl = 'https://psychedelic-undefending-kyler.ngrok-free.dev';
const webhookUrl = `${ngrokUrl}/wallet/webhooks/flutterwave`;

// Use the ACTUAL transfer ID from your withdrawal
const actualTransferId = '2121132'; // From your backend logs
const actualReference = 'b900b3c6-4e88-41fd-843d-c3d832f59c85'; // From your withdrawal

console.log('🎯 Using REAL transfer data:');
console.log('   Transfer ID:', actualTransferId);
console.log('   Reference:', actualReference);
console.log('');

import https from 'https';

const testRealWebhook = async () => {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'flutterwave-signature': 'test-signature'
      },
      body: JSON.stringify({
        event: 'transfer.completed',
        data: {
          id: actualTransferId, // REAL transfer ID
          status: 'SUCCESSFUL',
          amount: 100,
          currency: 'NGN',
          reference: actualReference, // REAL reference
          tx_ref: actualReference, // Add tx_ref for additional lookup
          account_number: '3099633148' // Add account number for debugging
        }
      })
    });
    
    console.log('✅ Real webhook sent:', response.status);
    
    if (response.status === 200) {
      console.log('🎉 REAL webhook test successful!');
      console.log('📋 This should find your actual payout and update status');
    } else {
      console.log('⚠️ Webhook responded:', response.status);
    }
    
  } catch (error) {
    console.log('❌ Real webhook error:', error.message);
  }
};

testRealWebhook();
