# ngrok URL Setup for Flutterwave

## ❌ Issue Found

Your ngrok is forwarding to the wrong port:
```
https://psychedelic-undefending-kyler.ngrok-free.dev -> http://localhost:80
```

**Problem:** Your backend runs on port **3000**, not port 80!

## ✅ Fix: Restart ngrok with Correct Port

**Stop ngrok** (Ctrl+C) and restart with:
```bash
ngrok http 3000
```

**You should see:**
```
Forwarding   https://psychedelic-undefending-kyler.ngrok-free.dev -> http://localhost:3000
```

## 📋 Flutterwave Webhook URL

**The full webhook URL for Flutterwave is:**
```
https://psychedelic-undefending-kyler.ngrok-free.dev/wallet/webhooks/flutterwave
```

**NOT just:**
```
https://psychedelic-undefending-kyler.ngrok-free.dev
```

## ✅ Complete Setup Steps

### 1. Restart ngrok (correct port)
```bash
ngrok http 3000
```

### 2. Update `.env`
```env
API_URL=https://psychedelic-undefending-kyler.ngrok-free.dev
```

### 3. Update Flutterwave Webhook
**In Flutterwave Dashboard → Settings → Webhooks:**
```
https://psychedelic-undefending-kyler.ngrok-free.dev/wallet/webhooks/flutterwave
```

### 4. Test Webhook Endpoint
Open in browser:
```
https://psychedelic-undefending-kyler.ngrok-free.dev/wallet/webhooks/flutterwave
```

Should return:
```json
{
  "status": "success",
  "message": "Webhook endpoint is accessible"
}
```

## Summary

- ✅ ngrok URL: `https://psychedelic-undefending-kyler.ngrok-free.dev`
- ✅ Flutterwave webhook: `https://psychedelic-undefending-kyler.ngrok-free.dev/wallet/webhooks/flutterwave`
- ⚠️ Make sure ngrok forwards to port 3000 (not 80)

