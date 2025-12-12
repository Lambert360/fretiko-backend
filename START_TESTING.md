# Quick Start - Testing Flutterwave Integration

## ✅ Prerequisites Installed

- ✅ Flutterwave SDK installed
- ✅ Ngrok installed globally
- ✅ Code compiled successfully

## 🚀 Start Testing (3 Steps)

### Step 1: Start Backend Server

**Terminal 1** - Run your backend:
```bash
cd fretiko-backend
npm run start:dev
```

Wait for: `🚀 Server is running on http://0.0.0.0:3000`

---

### Step 2: Start Ngrok

**Terminal 2** - Expose your backend:
```bash
ngrok http 3000
```

You'll see:
```
Forwarding  https://abc123.ngrok.io -> http://localhost:3000
```

**Copy the HTTPS URL** (e.g., `https://abc123.ngrok.io`)

---

### Step 3: Update .env File

Add to your `.env` file:

```env
# Flutterwave Keys (Get from Flutterwave Dashboard)
FLW_PUBLIC_KEY=FLWPUBK_TEST-xxxxxxxxxxxxxxxxxxxxx
FLW_SECRET_KEY=FLWSECK_TEST-xxxxxxxxxxxxxxxxxxxxx
FLW_ENCRYPTION_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FLW_WEBHOOK_SECRET=your_webhook_secret_here

# URLs
FRONTEND_URL=fretiko://wallet/deposit/callback
API_URL=https://abc123.ngrok.io  # ← Paste your ngrok URL here
```

**Then restart your backend** (Ctrl+C and run `npm run start:dev` again)

---

## 🔗 Configure Flutterwave Webhook

1. Go to [Flutterwave Dashboard](https://dashboard.flutterwave.com) → Settings → Webhooks
2. Add webhook URL: `https://abc123.ngrok.io/wallet/webhooks/flutterwave`
3. Select events:
   - ✅ `charge.completed`
   - ✅ `charge.failed`
   - ✅ `transfer.completed`
   - ✅ `transfer.failed`
4. Save webhook

---

## 🧪 Test Deposit

1. Make a deposit request via API or mobile app
2. You'll get a `paymentLink` in the response
3. Open the link and use Flutterwave test card:
   - Card: `5531886652142950`
   - CVV: `123`
   - Expiry: Any future date
   - PIN: `3310`
   - OTP: `123456`
4. Complete payment
5. Check ngrok web interface: http://127.0.0.1:4040 (see incoming webhooks)
6. Check backend logs for webhook processing
7. Verify deposit status updated in database

---

## 📊 Monitor

- **Ngrok Web UI**: http://127.0.0.1:4040 (see all requests)
- **Backend Logs**: Check terminal for webhook processing
- **Database**: Check `deposits` and `payout_requests` tables

---

## ⚠️ Important Notes

- **Keep both terminals open** (backend + ngrok)
- **Ngrok URL changes** when you restart ngrok (update webhook URL)
- **Use test keys** from Flutterwave dashboard for sandbox testing

---

## 🎯 You're Ready!

Once you've:
1. ✅ Started backend
2. ✅ Started ngrok
3. ✅ Updated .env with ngrok URL
4. ✅ Configured Flutterwave webhook

You can start testing deposits and withdrawals!

