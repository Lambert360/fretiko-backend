# Webhook Troubleshooting Guide

## Issue: Payment Completed but App Not Notified

If you completed payment on Flutterwave but the app wasn't notified, check these:

### 1. Webhook Configuration

**Check Flutterwave Dashboard:**
1. Go to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Settings → Webhooks
3. Verify webhook URL is set: `https://your-localtunnel-url/wallet/webhooks/flutterwave`
4. Verify events are selected:
   - ✅ `charge.completed`
   - ✅ `charge.failed`
5. Check webhook status (should be "Active")

### 2. Check Webhook is Receiving Events

**Check your backend logs** for:
```
🔔 Flutterwave webhook received: charge.completed
📥 Processing deposit webhook: ...
✅ Deposit processed and wallet credited
```

**If you don't see these logs:**
- Webhook URL might be wrong
- LocalTunnel might not be running
- Webhook might not be configured in Flutterwave

### 3. Verify LocalTunnel is Running

```bash
# Make sure LocalTunnel is running
lt --port 3000

# Check the URL matches your webhook configuration
```

### 4. Test Webhook Manually

You can test if your webhook endpoint is accessible:

```bash
curl -X POST https://your-localtunnel-url/wallet/webhooks/flutterwave \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

### 5. Check Deep Link is Working

After payment, Flutterwave should redirect to:
```
fretiko://wallet/deposit/callback?deposit_id=YOUR_DEPOSIT_ID
```

**If redirect doesn't work:**
- The deep link might not be opening the app
- Check if the app handles the deep link correctly

### 6. Frontend Polling

The app should automatically poll for deposit status when:
- You return from payment
- The screen comes into focus
- App comes to foreground

**Check frontend logs** for:
```
📥 Deposit callback received, deposit_id: ...
```

## Quick Fixes

### Fix 1: Update Webhook URL
1. Get your LocalTunnel URL: `lt --port 3000`
2. Update Flutterwave webhook: `https://your-url/wallet/webhooks/flutterwave`
3. Save webhook

### Fix 2: Restart LocalTunnel
If LocalTunnel URL changed:
1. Get new URL
2. Update webhook in Flutterwave
3. Update `API_URL` in `.env`
4. Restart backend

### Fix 3: Check Deep Link
The redirect URL should be: `fretiko://wallet/deposit/callback?deposit_id=...`

If it's still `http://localhost`, check your `.env`:
```env
FRONTEND_URL=fretiko://wallet/deposit/callback
```

## Expected Flow

1. ✅ User completes payment on Flutterwave
2. ✅ Flutterwave sends webhook to your backend
3. ✅ Backend processes webhook and updates deposit status
4. ✅ Flutterwave redirects to deep link: `fretiko://wallet/deposit/callback?deposit_id=...`
5. ✅ App opens and detects deposit_id
6. ✅ App polls for deposit status (or webhook already updated it)
7. ✅ User sees success message

## If Webhook Doesn't Work

The app will still work via **polling**:
- When you return to the app, it automatically checks deposit status
- It polls every 5 seconds for up to 5 minutes
- Once status is `completed`, it shows success message

So even if webhook fails, the polling will eventually detect the completed payment.

