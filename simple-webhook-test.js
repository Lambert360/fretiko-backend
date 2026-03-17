import https from 'https';

const testWebhook = async () => {
  try {
    const response = await fetch('https://psychedelic-undefending-kyler.ngrok-free.dev/wallet/webhooks/flutterwave', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'flutterwave-signature': 'test-signature'
      },
      body: JSON.stringify({
        event: 'transfer.completed',
        data: {
          id: 9645, // Transfer ID from logs
          status: 'SUCCESSFUL',
          amount: 100,
          currency: 'NGN',
          reference: '9645c5f5-ef7f-44cd-863c-1dcbfa02ead8' // Payout ID from logs
        }
      })
    });
    
    console.log('Status:', response.status);
    console.log('Response:', await response.text());
    
  } catch (error) {
    console.error('Error:', error.message);
  }
};

testWebhook();
