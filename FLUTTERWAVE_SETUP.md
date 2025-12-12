# Flutterwave Payment Integration Setup Guide

## Overview

This document provides setup instructions for the Flutterwave payment integration in the Fretiko wallet system.

## Prerequisites

1. Flutterwave account (sandbox or production)
2. Flutterwave API keys (Public Key, Secret Key, Encryption Key)
3. Webhook secret for signature verification

## Environment Variables

Add the following to your `.env` file:

```env
# Flutterwave Configuration
FLW_PUBLIC_KEY=your_public_key_here
FLW_SECRET_KEY=your_secret_key_here
FLW_ENCRYPTION_KEY=your_encryption_key_here
FLW_WEBHOOK_SECRET=your_webhook_secret_here

# Application URLs (for redirects and webhooks)
FRONTEND_URL=http://localhost:3000
API_URL=http://localhost:3000
```

## Installation

1. Install dependencies:
```bash
cd fretiko-backend
npm install
```

The Flutterwave SDK (`flutterwave-node-v3`) is already added to `package.json`.

## Webhook Configuration

### 1. Configure Webhook URL in Flutterwave Dashboard

1. Log in to your Flutterwave dashboard
2. Go to Settings → Webhooks
3. Add webhook URL: `https://your-api-domain.com/wallet/webhooks/flutterwave`
4. Select events to listen for:
   - `charge.completed`
   - `charge.failed`
   - `transfer.completed`
   - `transfer.failed`
5. Copy the webhook secret and add it to `.env` as `FLW_WEBHOOK_SECRET`

### 2. Webhook Signature Verification

The webhook endpoint automatically verifies signatures using HMAC SHA256. The signature is sent in the `verif-hash` header.

**Important**: The raw body is configured in `main.ts` for the webhook endpoint to enable signature verification.

## API Endpoints

### Deposits

- **POST** `/wallet/deposit` - Create deposit and initialize Flutterwave payment
  - Returns payment link for user to complete payment
  - Body: `{ fretiAmount?: number, localAmount?: number, localCurrency?: string }`

- **GET** `/wallet/deposits` - Get user's deposit history
  - Query params: `status`, `limit`, `offset`

### Withdrawals

- **POST** `/wallet/withdraw` - Create withdrawal and initiate Flutterwave transfer
  - Body: `{ fretiAmount: number, bankAccountId: string, localCurrency?: string }`
  - Requires verified bank account

- **GET** `/wallet/withdrawals` - Get user's withdrawal history
  - Query params: `status`, `limit`, `offset`

### Webhooks

- **POST** `/wallet/webhooks/flutterwave` - Flutterwave webhook endpoint
  - No authentication required
  - Automatically verifies signature
  - Processes deposit and withdrawal events

## Multi-Currency Flow

### Deposits

1. User pays in their local currency (e.g., 10,000 NGN)
2. Flutterwave converts to USD (e.g., $10 USD)
3. System credits user with FRETI (1 USD = 1 FRETI)
4. User receives ₣10 FRETI in their wallet

### Withdrawals

1. User withdraws FRETI (e.g., ₣10 FRETI = $10 USD)
2. System sends USD to Flutterwave
3. Flutterwave converts to bank account's currency (e.g., 120 GHS)
4. User receives local currency in their bank account

**Note**: Bank account currency is determined by the `currency` field in the `user_bank_accounts` table.

## Testing

### Sandbox Mode

1. Use Flutterwave sandbox credentials in `.env`
2. Test cards: https://developer.flutterwave.com/docs/test-cards
3. Test bank accounts: Use Flutterwave test bank accounts

### Test Flow

1. **Deposit Test**:
   - Create deposit request
   - Use payment link to complete payment with test card
   - Verify webhook updates deposit status
   - Check wallet balance is credited

2. **Withdrawal Test**:
   - Add test bank account
   - Create withdrawal request
   - Verify funds moved to pending_withdrawal
   - Check webhook updates withdrawal status
   - Verify funds removed from pending_withdrawal

## Error Handling

The system handles:
- Duplicate webhook processing (idempotency checks)
- Payment failures (deposits remain pending, withdrawals refunded)
- Network errors (retry logic in Flutterwave SDK)
- Invalid signatures (webhook rejected)

## Security Notes

1. **Never commit `.env` file** with real credentials
2. **Use different keys** for sandbox and production
3. **Verify webhook signatures** in production (currently allows in dev if secret not set)
4. **Store webhook payloads** in `webhook_data` field for audit trail
5. **Use idempotency keys** to prevent duplicate transactions

## Troubleshooting

### Webhook Not Receiving Events

1. Check webhook URL is accessible from internet
2. Verify webhook URL in Flutterwave dashboard
3. Check server logs for incoming requests
4. Verify signature verification is working

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

## Support

For Flutterwave API issues:
- Documentation: https://developer.flutterwave.com/docs
- Support: support@flutterwave.com

For integration issues:
- Check server logs
- Review webhook payloads in database
- Verify environment variables are set correctly

