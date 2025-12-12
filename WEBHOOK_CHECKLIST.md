# Webhook Troubleshooting Checklist

## ✅ Your Current Status
- Payment: ✅ Successful on Flutterwave
- Deposit: ⚠️ Pending in app
- Webhook URL: `https://real-coats-divide.loca.lt/wallet/webhooks/flutterwave`
- Webhook Secret: ✅ Configured

## 🔍 Step-by-Step Debugging

### Step 1: Check Backend Logs
**Look for these in your backend console:**

✅ **If webhook was received:**
```
🔔 Flutterwave webhook received: charge.completed
📋 Webhook body: {...}
🔐 Signature header: present
✅ Webhook signature verified
📥 Processing deposit webhook: ...
✅ Deposit processed and wallet credited
```

❌ **If webhook wasn't received:**
- No logs at all = Webhook not reaching your backend
- Check LocalTunnel is running
- Check webhook URL is correct

### Step 2: Check Flutterwave Dashboard
1. Go to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Settings → Webhooks
3. Click on your webhook
4. Check "Webhook Logs" or "Delivery Status"
5. Look for:
   - ✅ **200 OK** = Webhook delivered successfully
   - ❌ **4xx/5xx** = Webhook failed to deliver
   - ⏱️ **Pending** = Webhook queued but not sent yet

### Step 3: Verify Webhook URL
**In Flutterwave Dashboard, the webhook URL MUST be:**
```
https://real-coats-divide.loca.lt/wallet/webhooks/flutterwave
```

**Common mistakes:**
- Missing `/wallet` in path
- Using `http://` instead of `https://`
- Extra trailing slash
- Wrong LocalTunnel URL

### Step 4: Test Webhook Endpoint
Test if your endpoint is accessible:

```bash
curl -X POST https://real-coats-divide.loca.lt/wallet/webhooks/flutterwave \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

**Expected response:**
- Backend logs should show: `🔔 Flutterwave webhook received: unknown event`
- If you get connection error = LocalTunnel not running or URL wrong

### Step 5: Check LocalTunnel Status
Make sure LocalTunnel is still running:
```bash
lt --port 3000
```

**If LocalTunnel stopped:**
1. Restart it: `lt --port 3000`
2. Get new URL (if it changed)
3. Update `.env`: `API_URL=https://new-url.loca.lt`
4. Update Flutterwave webhook URL

### Step 6: Manual Verification (Quick Fix)
Since payment was successful, manually verify the deposit:

**Option A: Via API**
```bash
POST /wallet/deposits/{depositId}/verify
```

**Option B: Check deposit ID from transaction history, then verify**

This will:
- Check Flutterwave for payment status
- Process the deposit if successful
- Credit your wallet
- Update deposit to "completed"

## 🎯 Most Likely Issues

### Issue 1: Webhook Sent Before Endpoint Was Ready
**Solution:** Manually verify the deposit (Step 6)

### Issue 2: LocalTunnel URL Changed
**Solution:** Restart LocalTunnel, update webhook URL

### Issue 3: Webhook URL Typo
**Solution:** Double-check URL in Flutterwave dashboard

### Issue 4: Webhook Secret Mismatch
**Solution:** Verify `FLW_WEBHOOK_SECRET` matches Flutterwave dashboard

## 🚀 Quick Fix Right Now

Since payment was successful, **manually verify the deposit:**

1. Get deposit ID from transaction history
2. Call: `POST /wallet/deposits/{depositId}/verify`
3. Deposit will be processed immediately

Then fix webhook for future deposits.

## 📝 What to Report Back

Please check and report:
1. ✅ Do you see any webhook logs in backend? (Yes/No)
2. ✅ What does Flutterwave webhook logs show? (Success/Failed/Pending)
3. ✅ Is LocalTunnel still running? (Yes/No)
4. ✅ What's the exact webhook URL in Flutterwave dashboard?

This will help identify the exact issue!

