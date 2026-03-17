import dotenv from 'dotenv';
import Flutterwave from 'flutterwave-node-v3';

dotenv.config();

console.log('🔍 Testing Flutterwave Transfers Status');
console.log('=====================================');

// Check if credentials are loaded
const publicKey = process.env.FLW_PUBLIC_KEY;
const secretKey = process.env.FLW_SECRET_KEY;

if (!publicKey || !secretKey) {
    console.log('❌ Missing credentials');
    console.log('FLW_PUBLIC_KEY:', publicKey ? 'SET' : 'MISSING');
    console.log('FLW_SECRET_KEY:', secretKey ? 'SET' : 'MISSING');
    process.exit(1);
}

console.log('✅ Credentials loaded');
console.log('🔑 Public Key:', publicKey.substring(0, 20) + '...');

try {
    const flw = new Flutterwave(publicKey, secretKey);
    
    // Test 1: Check balance
    console.log('\n💰 Testing balance check...');
    try {
        const balance = await flw.Misc.balance();
        console.log('✅ Balance check successful');
        console.log('💰 Balance:', balance.data);
    } catch (balanceError) {
        console.log('❌ Balance check failed:', balanceError.message);
    }
    
    // Test 2: Check transfer fees (this will work if transfers are enabled)
    console.log('\n💸 Testing transfer fees...');
    try {
        const fee = await flw.Transfer.fee({
            amount: 1000,
            currency: 'NGN'
        });
        console.log('✅ Transfer fee check successful');
        console.log('💸 Fee for 1000 NGN:', fee.data);
        console.log('🎉 TRANSFERS APPEAR TO BE ENABLED!');
    } catch (feeError) {
        console.log('❌ Transfer fee check failed:', feeError.message);
        
        if (feeError.message.includes('not enabled') || feeError.message.includes('merchant')) {
            console.log('⚠️ TRANSFERS NOT ENABLED');
            console.log('📞 Contact Flutterwave support to enable transfers');
        } else {
            console.log('⚠️ Other API issue (may not be transfer-related)');
        }
    }
    
    // Test 3: Try a small transfer (optional)
    console.log('\n🧪 Testing small transfer...');
    try {
        const transfer = await flw.Transfer.initiate({
            account_bank: '044', // Test bank code
            account_number: '0690000030', // Test account
            amount: 100, // Small test amount
            currency: 'NGN',
            beneficiary_name: 'Test User',
            narration: 'Test transfer to verify transfers are enabled'
        });
        console.log('✅ Test transfer successful!');
        console.log('📊 Transfer ID:', transfer.data.id);
        console.log('🎉 TRANSFERS DEFINITELY ENABLED!');
    } catch (transferError) {
        console.log('❌ Test transfer failed:', transferError.message);
        
        if (transferError.message.includes('not enabled') || transferError.message.includes('merchant')) {
            console.log('⚠️ TRANSFERS NOT ENABLED');
            console.log('📞 Contact Flutterwave support to enable transfers');
        } else {
            console.log('⚠️ Test failed for other reasons (invalid test data?)');
        }
    }
    
} catch (error) {
    console.log('❌ Flutterwave API error:', error.message);
}

console.log('\n📋 Summary:');
console.log('- If transfer fee check succeeded: Transfers are enabled');
console.log('- If transfer fee check failed: Transfers need to be enabled');
console.log('- Contact Flutterwave support if transfers are not enabled');
console.log('\n🏪 Flutterwave Support: integrations@flutterwavego.com');
