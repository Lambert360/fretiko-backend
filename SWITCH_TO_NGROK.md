# Switch from LocalTunnel to ngrok

## Why LocalTunnel is Problematic

**LocalTunnel issues:**
- ❌ URLs change frequently (every restart)
- ❌ Can be unstable and drop connections
- ❌ Flutterwave may have trouble reaching it
- ❌ Less reliable for production-like testing
- ❌ Sometimes doesn't forward requests correctly

**ngrok advantages:**
- ✅ More stable and reliable
- ✅ Better HTTPS support
- ✅ More consistent (especially with free account)
- ✅ Better for Flutterwave webhooks
- ✅ Better connection reliability

## Step-by-Step: Switch to ngrok

### Step 1: Install ngrok

**Option A: Download (Recommended)**
1. Go to https://ngrok.com/download
2. Download for Windows
3. Extract to a folder (e.g., `C:\ngrok`)
4. Add to PATH or use full path

**Option B: Using npm**
```bash
npm install -g ngrok
```

### Step 2: Sign up for ngrok (Free)

1. Go to https://dashboard.ngrok.com/signup
2. Sign up for free account
3. Get your authtoken from dashboard
4. Run: `ngrok config add-authtoken YOUR_TOKEN`

### Step 3: Stop LocalTunnel

Stop your LocalTunnel process (close the terminal or Ctrl+C)

### Step 4: Start ngrok

```bash
ngrok http 3000
```

**You'll see:**
```
Forwarding   https://abc123.ngrok.io -> http://localhost:3000
```

**Copy the HTTPS URL** (e.g., `https://abc123.ngrok.io`)

### Step 5: Update Configuration

**Update `.env` file:**
```env
API_URL=https://abc123.ngrok.io
```

**Update Flutterwave webhook:**
1. Go to Flutterwave Dashboard → Settings → Webhooks
2. Update webhook URL to:
   ```
   https://abc123.ngrok.io/wallet/webhooks/flutterwave
   ```
3. Save

### Step 6: Test Webhook Endpoint

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

### Step 7: Verify in Flutterwave

1. Flutterwave Dashboard → Settings → Webhooks
2. Click "Test Webhook" or "Verify URL"
3. Should show "Webhook URL is accessible"

### Step 8: Test with Real Transaction

1. Make a test deposit
2. Complete payment on Flutterwave
3. Check backend logs for:
   ```
   🔔 Flutterwave webhook received: charge.completed
   ✅ Webhook processed successfully
   ```

## ngrok Free Account Benefits

**Free tier includes:**
- ✅ HTTPS tunnels
- ✅ Stable URLs (same URL until you restart)
- ✅ Web interface to inspect requests
- ✅ Request replay
- ✅ Perfect for development

**Note:** Free tier URLs change when you restart ngrok, but they're more stable than LocalTunnel.

## Keep ngrok Running

**Important:**
- Keep ngrok terminal window open
- If you restart ngrok, URL changes
- Update `.env` and Flutterwave webhook URL if it changes

## Troubleshooting

### Issue: ngrok not starting
- Check if port 3000 is already in use
- Make sure backend is running on port 3000
- Check ngrok authtoken is configured

### Issue: Webhook still not working
1. Verify ngrok URL in Flutterwave dashboard
2. Test GET endpoint (should return success)
3. Check Flutterwave webhook logs
4. Check backend logs for webhook attempts

### Issue: ngrok URL changed
- Restart ngrok = new URL
- Update `.env`: `API_URL=https://new-url.ngrok.io`
- Update Flutterwave webhook URL

## Summary

**Why switch:**
- LocalTunnel is unreliable for webhooks
- ngrok is more stable and better for Flutterwave
- Better connection reliability
- Better debugging tools

**Quick switch:**
1. Install ngrok
2. Start: `ngrok http 3000`
3. Update `.env` with ngrok URL
4. Update Flutterwave webhook URL
5. Test!

This should fix your webhook issues! 🚀

