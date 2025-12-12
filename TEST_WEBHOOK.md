# Test Webhook Endpoint

## Quick Test

Test if your webhook endpoint is accessible:

```bash
curl -X POST https://real-coats-divide.loca.lt/wallet/webhooks/flutterwave \
  -H "Content-Type: application/json" \
  -d '{"test": "data", "event": "test"}'
```

**Expected in backend logs:**
```
🔔 Flutterwave webhook received: test
📋 Webhook body: {...}
```

If you don't see this, the endpoint isn't reachable.

## Check Flutterwave Webhook Logs

1. Go to Flutterwave Dashboard
2. Settings → Webhooks
3. Click on your webhook
4. Check "Webhook Logs" or "Delivery Status"
5. Look for the recent transaction - what status does it show?

## Verify Webhook URL One More Time

In Flutterwave Dashboard, the webhook URL MUST be exactly:
```
https://real-coats-divide.loca.lt/wallet/webhooks/flutterwave
```

Double-check:
- ✅ Starts with `https://`
- ✅ Includes `/wallet` before `/webhooks`
- ✅ No trailing slash
- ✅ Matches your LocalTunnel URL exactly

## Common Issues

1. **LocalTunnel URL Changed**
   - If you restarted LocalTunnel, the URL might have changed
   - Check: `lt --port 3000` - what URL does it show now?

2. **Webhook URL Typo**
   - Even a small typo will cause it to fail
   - Copy-paste the exact URL

3. **Webhook Not Enabled for Event**
   - Make sure `charge.completed` is enabled
   - Check webhook event subscriptions

