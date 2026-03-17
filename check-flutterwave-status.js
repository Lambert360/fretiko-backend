const Flutterwave = require('flutterwave-node-v3');

const flw = new Flutterwave(process.env.FLW_PUBLIC_KEY, process.env.FLW_SECRET_KEY);

async function checkAccountStatus() {
    try {
        console.log('🔍 Checking Flutterwave account status...');
        
        // Check account balance
        const balance = await flw.Misc.Balance();
        console.log('💰 Account Balance:', balance);
        
        // Check transfer limits
        const transfers = await flw.Transfer.Fetch({
            limit: 1
        });
        console.log('📊 Transfer History:', transfers);
        
        // Try to get transfer fee (this will work if transfers are enabled)
        try {
            const fee = await flw.Transfer.Fee({
                amount: 100,
                currency: 'NGN'
            });
            console.log('💸 Transfer Fee:', fee);
            console.log('✅ Transfers appear to be enabled!');
        } catch (feeError) {
            console.log('❌ Transfer fee check failed:', feeError.message);
            console.log('⚠️ Transfers may not be enabled');
        }
        
    } catch (error) {
        console.error('❌ Error checking account status:', error.message);
    }
}

checkAccountStatus();
