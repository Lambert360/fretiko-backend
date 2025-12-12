# ngrok Quick Start for Flutterwave Webhooks

## ✅ ngrok is Installed

ngrok is ready to use for Flutterwave webhooks!

## Quick Start

### Step 1: Start ngrok

```bash
ngrok http 3000
```

**You'll see:**
```
Forwarding   https://abc123.ngrok.io -> http://localhost:3000
```

**Copy the HTTPS URL** (e.g., `https://abc123.ngrok.io`)

### Step 2: Update Configuration

**Update `.env` file:**
```env
API_URL=https://abc123.ngrok.io
```

**Update Flutterwave webhook:**
1. Go to Flutterwave Dashboard → Settings → Webhooks
2. Webhook URL: `https://abc123.ngrok.io/wallet/webhooks/flutterwave`
3. Save

### Step 3: Test Webhook Endpoint

**Test GET endpoint:**
```bash
curl https://abc123.ngrok.io/wallet/webhooks/flutterwave
```

**Or open in browser:**
```
https://abc123.ngrok.io/wallet/webhooks/flutterwave
```

**Expected response:**
```json
{
  "status": "success",
  "message": "Webhook endpoint is accessible",
  "timestamp": "..."
}
```

### Step 4: Verify in Flutterwave

1. Flutterwave Dashboard → Settings → Webhooks
2. Click "Test Webhook" or "Verify URL"
3. Should show "Webhook URL is accessible"

## Keep ngrok Running

**Important:**
- Keep ngrok terminal window open
- If you restart ngrok, URL changes
- Update `.env` and Flutterwave webhook URL if it changes

## Troubleshooting

### Issue: ngrok not starting
- Check if port 3000 is already in use
- Make sure backend is running on port 3000
- Check ngrok authtoken is configured: `ngrok config add-authtoken YOUR_TOKEN`

### Issue: Webhook still not working
1. Verify ngrok URL in Flutterwave dashboard
2. Test GET endpoint (should return success)
3. Check Flutterwave webhook logs
4. Check backend logs for webhook attempts

## Summary

**Webhook URL format:**
```
https://your-ngrok-url.ngrok.io/wallet/webhooks/flutterwave
```

**Requirements:**
- ✅ Use HTTPS (not HTTP)
- ✅ Include `/wallet` in path
- ✅ No trailing slash
- ✅ Must match ngrok URL exactly

That's it! ngrok is more reliable than LocalTunnel for webhooks. 🚀

