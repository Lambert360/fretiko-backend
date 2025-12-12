# Flutterwave Integration - Quick Start Guide

## ✅ Installation Complete

All dependencies have been installed and the code compiles successfully.

## 🚀 Next Steps

### 1. Configure Environment Variables

Add these to your `.env` file in `fretiko-backend/`:

```env
# Flutterwave Configuration (Get these from Flutterwave Dashboard)
FLW_PUBLIC_KEY=FLWPUBK-xxxxxxxxxxxxxxxxxxxxx
FLW_SECRET_KEY=FLWSECK-xxxxxxxxxxxxxxxxxxxxx
FLW_ENCRYPTION_KEY=xxxxxxxxxxxxxxxxxxxxx
FLW_WEBHOOK_SECRET=your_webhook_secret_here

# Application URLs
FRONTEND_URL=http://localhost:3000
API_URL=http://localhost:3000
```

**Where to get Flutterwave keys:**
1. Log in to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Go to Settings → API Keys
3. Copy your Public Key, Secret Key, and Encryption Key
4. For sandbox testing, use the test keys

### 2. Configure Webhook in Flutterwave Dashboard

1. Log in to Flutterwave Dashboard
2. Go to Settings → Webhooks
3. Click "Add Webhook"
4. Enter webhook URL: `https://your-api-domain.com/wallet/webhooks/flutterwave`
   - For local testing: Use ngrok or similar to expose your local server
   - Example: `https://abc123.ngrok.io/wallet/webhooks/flutterwave`
5. Select these events:
   - ✅ `charge.completed`
   - ✅ `charge.failed`
   - ✅ `transfer.completed`
   - ✅ `transfer.failed`
6. Copy the webhook secret and add it to `.env` as `FLW_WEBHOOK_SECRET`
7. Save the webhook

### 3. Start the Backend Server

```bash
cd fretiko-backend
npm run start:dev
```

The server should start without errors. If you see warnings about missing Flutterwave keys, that's normal until you add them to `.env`.

### 4. Test Deposit Flow (Sandbox)

1. **Create a deposit request** via API or mobile app:
```bash
   POST http://localhost:3000/wallet/deposit
   Authorization: Bearer <your-token>
   {
     "fretiAmount": 10,
     "localAmount": 10000,
     "localCurrency": "NGN"
   }
   ```

2. **Response will include** `paymentLink`:
   ```json
   {
     "id": "...",
     "paymentLink": "https://checkout.flutterwave.com/v3/hosted/pay/...",
     "status": "pending",
     ...
   }
   ```

3. **Open the payment link** in a browser
4. **Use Flutterwave test card**:
   - Card Number: `5531886652142950`
   - CVV: `123`
   - Expiry: Any future date
   - PIN: `3310`
   - OTP: `123456`

5. **Complete payment** and verify:
   - Webhook is received
   - Deposit status updates to `completed`
   - Wallet balance is credited

### 5. Test Withdrawal Flow (Sandbox)

1. **Ensure user has sufficient balance** (deposit first)
2. **Add a bank account** (via mobile app or API)
3. **Create withdrawal request**:
   ```bash
   POST http://localhost:3000/wallet/withdraw
   Authorization: Bearer <your-token>
   {
     "fretiAmount": 10,
     "bankAccountId": "<bank-account-id>"
   }
   ```

4. **Verify**:
   - Funds moved to `pending_withdrawal`
   - Payout request created with status `processing`
   - Webhook updates status when transfer completes

### 6. Monitor Logs

Watch the console for:
- ✅ Payment initialization logs
- ✅ Webhook processing logs
- ✅ Transaction completion logs
- ❌ Any error messages

## 🧪 Testing Checklist

- [ ] Deposit with NGN currency
- [ ] Deposit with USD currency
- [ ] Deposit with other currencies (GHS, KES, ZAR)
- [ ] Withdrawal to NGN bank account
- [ ] Withdrawal to GHS bank account
- [ ] Webhook signature verification
- [ ] Duplicate webhook handling (idempotency)
- [ ] Payment failure scenarios
- [ ] Withdrawal failure scenarios (refund to balance)
- [ ] Daily limit enforcement

## 🔍 Troubleshooting

### Webhook Not Receiving Events

1. **Check webhook URL is accessible**:
   ```bash
   curl -X POST https://your-api-domain.com/wallet/webhooks/flutterwave
   ```

2. **Verify webhook is active** in Flutterwave dashboard

3. **Check server logs** for incoming requests

4. **Verify signature verification** is working (check logs)

### Payment Link Not Opening

1. Check `FRONTEND_URL` is correct
2. Verify Flutterwave keys are valid
3. Check browser console for errors
4. Ensure payment link is properly formatted

### Withdrawal Fails

1. Verify bank account is active and verified
2. Check bank account has correct `bank_code`
3. Verify sufficient balance in wallet
4. Check daily withdrawal limits
5. Review Flutterwave transfer response for errors

### Build Errors

If you see TypeScript errors:
```bash
npm run build
```

Common fixes:
- Ensure all imports are correct
- Check `tsconfig.json` settings
- Verify all dependencies are installed

## 📚 Additional Resources

- **Flutterwave Documentation**: https://developer.flutterwave.com/docs
- **Test Cards**: https://developer.flutterwave.com/docs/test-cards
- **Webhook Guide**: https://developer.flutterwave.com/docs/webhooks
- **API Reference**: https://developer.flutterwave.com/reference

## 🎯 Production Deployment

Before going live:

1. ✅ Switch to production Flutterwave keys
2. ✅ Update webhook URL to production domain
3. ✅ Enable webhook signature verification (remove dev bypass)
4. ✅ Set up monitoring and alerts
5. ✅ Test with small amounts first
6. ✅ Monitor logs for any issues
7. ✅ Set up backup webhook endpoints

## ✨ You're Ready!

The Flutterwave integration is fully implemented and ready for testing. Once you've configured the environment variables and webhook, you can start processing real payments!

For detailed setup instructions, see `FLUTTERWAVE_SETUP.md`.
For implementation status, see `FLUTTERWAVE_IMPLEMENTATION_STATUS.md`.
