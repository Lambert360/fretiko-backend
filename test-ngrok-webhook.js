#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

console.log('🔍 Testing Ngrok Webhook Setup');
console.log('==============================');

const ngrokUrl = 'https://psychedelic-undefending-kyler.ngrok-free.dev';
const webhookUrl = `${ngrokUrl}/wallet/webhooks/flutterwave`;

console.log('🚀 Ngrok URL:', ngrokUrl);
console.log('🔗 Webhook URL:', webhookUrl);
console.log('');

// Test 1: Check if ngrok is accessible
console.log('📡 Testing ngrok accessibility...');
import https from 'https';

const testNgrok = async () => {
  try {
    const response = await fetch(ngrokUrl);
    console.log('✅ Ngrok is accessible:', response.status);
  } catch (error) {
    console.log('❌ Ngrok not accessible:', error.message);
    return false;
  }

  // Test 2: Check webhook endpoint
  console.log('🔗 Testing webhook endpoint...');
  try {
    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'flutterwave-signature': 'test-signature'
      },
      body: JSON.stringify({
        event: 'transfer.completed',
        data: {
          id: 'test-transfer-id',
          status: 'SUCCESSFUL',
          amount: 100,
          currency: 'NGN',
          reference: 'test-reference'
        }
      })
    });
    
    console.log('✅ Webhook endpoint responding:', webhookResponse.status);
    
    if (webhookResponse.status === 200) {
      console.log('🎉 Webhook setup is working!');
      console.log('📋 Next withdrawal should receive webhook callbacks');
    } else {
      console.log('⚠️ Webhook responded with:', webhookResponse.status);
    }
    
  } catch (error) {
    console.log('❌ Webhook endpoint error:', error.message);
  }
};

testNgrok();
