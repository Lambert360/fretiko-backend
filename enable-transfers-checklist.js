#!/usr/bin/env node

require('dotenv').config();

const Flutterwave = require('flutterwave-node-v3');

// Use your actual credentials from .env
const flw = new Flutterwave(process.env.FLW_PUBLIC_KEY, process.env.FLW_SECRET_KEY);

async function enableTransfersChecklist() {
    console.log('🔍 Flutterwave Transfers Enable Checklist');
    console.log('==========================================\n');
    
    console.log('📋 Required Information for Support:');
    console.log('1. Business Name:', process.env.FLUTTERWAVE_BUSINESS_NAME || '[Set in .env]');
    console.log('2. Account Email:', process.env.FLUTTERWAVE_EMAIL || '[Set in .env]');
    console.log('3. Public Key:', process.env.FLW_PUBLIC_KEY?.substring(0, 20) + '...');
    console.log('4. Environment:', process.env.NODE_ENV || 'development');
    console.log('5. Expected Use Case: Wallet withdrawals to bank accounts\n');
    
    try {
        // Test basic API connectivity
        console.log('🔌 Testing API connectivity...');
        
        // Try different balance methods based on Flutterwave API version
        let balance;
        try {
            balance = await flw.Misc.balance(); // Try lowercase first
        } catch (e1) {
            try {
                balance = await flw.Misc.Balance(); // Try capitalized
            } catch (e2) {
                try {
                    balance = await flw.Transaction.verify({tx_ref: 'test'}); // Fallback to transaction API
                    console.log('✅ API Connection: SUCCESS (via Transaction API)');
                } catch (e3) {
                    console.log('❌ All API methods failed');
                }
            }
        }
        
        if (balance) {
            console.log('✅ API Connection: SUCCESS');
            console.log('💰 Available Balance:', balance.data || balance, '\n');
        }
        
        // Test transfer fee calculation (will show if transfers are enabled)
        console.log('💸 Testing transfer fee calculation...');
        try {
            const fee = await flw.Transfer.fee({ // Try lowercase first
                amount: 1000,
                currency: 'NGN'
            });
            console.log('✅ Transfer Fee Check: SUCCESS');
            console.log('📊 Fee for 1000 NGN:', fee.data, '\n');
        } catch (feeError1) {
            try {
                const fee = await flw.Transfer.Fee({ // Try capitalized
                    amount: 1000,
                    currency: 'NGN'
                });
                console.log('✅ Transfer Fee Check: SUCCESS');
                console.log('📊 Fee for 1000 NGN:', fee.data, '\n');
            } catch (feeError2) {
                console.log('❌ Transfer Fee Check: FAILED');
                console.log('⚠️ Error:', feeError2.message);
                console.log('🔧 This indicates transfers are not yet enabled\n');
            }
        }
        
    } catch (error) {
        console.log('❌ API Connection: FAILED');
        console.log('⚠️ Error:', error.message);
        console.log('🔧 Check your API credentials\n');
    }
    
    console.log('📞 Next Steps:');
    console.log('1. Contact Flutterwave support with the information above');
    console.log('2. Request: "Enable bank transfers for verified business account"');
    console.log('3. Mention: "Need payouts to customer bank accounts"');
    console.log('4. Ask for: "Webhook callbacks for transfer status"');
    console.log('5. Expected timeline: 1-3 business days\n');
    
    console.log('🧪 Development Testing:');
    console.log('- Use test mode for development');
    console.log('- Switch to live keys after approval');
    console.log('- Test with small amounts first\n');
}

enableTransfersChecklist();
