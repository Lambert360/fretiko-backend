# Webhook Debugging Steps

## Your Configuration
- LocalTunnel URL: `https://real-coats-divide.loca.lt`
- Webhook URL should be: `https://real-coats-divide.loca.lt/wallet/webhooks/flutterwave`
- Payment Status: ✅ Successful on Flutterwave
- Deposit Status: ⚠️ Pending in your app

## Quick Checks

### 1. Verify Webhook URL in Flutterwave
Go to Flutterwave Dashboard → Settings → Webhooks

**Correct URL:**
```
https://real-coats-divide.loca.lt/wallet/webhooks/flutterwave
```

**Common Mistakes:**
- ❌ `https://real-coats-divide.loca.lt` (missing path)
- ❌ `https://real-coats-divide.loca.lt/webhooks/flutterwave` (missing `/wallet`)
- ❌ `http://real-coats-divide.loca.lt/wallet/webhooks/flutterwave` (should be `https`)

### 2. Check Backend Logs
Look for these in your backend console:
```
🔔 Flutterwave webhook received: charge.completed
📥 Processing deposit webhook: ...
✅ Deposit processed and wallet credited
```

**If you don't see these:**
- Webhook isn't reaching your backend
- Check LocalTunnel is running
- Check webhook URL is correct

### 3. Test Webhook Endpoint Manually
Test if your endpoint is accessible:

```bash
curl -X POST https://real-coats-divide.loca.lt/wallet/webhooks/flutterwave \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

You should see in backend logs:
```
🔔 Flutterwave webhook received: unknown event
```

### 4. Check Flutterwave Webhook Logs
1. Go to Flutterwave Dashboard
2. Settings → Webhooks
3. Click on your webhook
4. Check "Webhook Logs" or "Delivery Status"
5. See if there are any failed attempts

### 5. Verify LocalTunnel is Running
Make sure LocalTunnel is still running:
```bash
lt --port 3000
```

If it stopped, restart it and update the webhook URL.

### 6. Check .env File
Make sure `API_URL` matches your LocalTunnel URL:
```env
API_URL=https://real-coats-divide.loca.lt
```

## Common Issues

### Issue 1: Webhook URL Wrong
**Symptom:** No webhook received
**Fix:** Double-check the URL in Flutterwave dashboard

### Issue 2: LocalTunnel Stopped
**Symptom:** Webhook can't reach your backend
**Fix:** Restart LocalTunnel and update webhook URL

### Issue 3: Signature Verification Failing
**Symptom:** Webhook received but rejected
**Fix:** Check `FLW_WEBHOOK_SECRET` matches Flutterwave dashboard

### Issue 4: Event Type Not Matching
**Symptom:** Webhook received but not processed
**Fix:** Check backend logs for event type

## Next Steps

1. **Check backend logs** - Do you see any webhook attempts?
2. **Check Flutterwave webhook logs** - Are there failed deliveries?
3. **Test endpoint manually** - Is it accessible?
4. **Verify URL** - Is it exactly correct?

Let me know what you find!

