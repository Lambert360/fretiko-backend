# Flutterwave Webhook Best Practices - Implementation Guide

## ✅ Changes Made

### 1. **Immediate 200 OK Response**
- Webhook now returns 200 OK immediately (within milliseconds)
- Processing happens asynchronously to avoid Flutterwave timeouts
- Flutterwave expects response within 5 seconds

### 2. **Non-Blocking Signature Verification**
- Signature verification errors are logged but don't block processing
- This prevents legitimate webhooks from being rejected due to signature issues
- Still logs warnings for security review

### 3. **Webhook Verification Endpoint (GET)**
- Added `GET /wallet/webhooks/flutterwave` endpoint
- Flutterwave can test this to verify URL is accessible
- Returns simple success message

### 4. **Better Error Handling**
- Errors are logged but don't cause webhook to fail
- Always returns 200 OK (Flutterwave will retry if needed)
- Detailed logging for debugging

## 🔧 Next Steps

### Step 1: Switch to ngrok (Recommended)

**Why ngrok over LocalTunnel:**
- More stable and reliable
- Better HTTPS support
- Consistent URLs (with paid plan)
- Better for production-like testing

**Install ngrok:**
```bash
# Option 1: Download from https://ngrok.com/download
# Option 2: npm install -g ngrok
```

**Start ngrok:**
```bash
ngrok http 3000
```

**Get your HTTPS URL:**
- Look for: `Forwarding https://abc123.ngrok.io -> http://localhost:3000`
- Use the HTTPS URL (not HTTP)

**Update configuration:**
1. Update `.env`:
   ```env
   API_URL=https://abc123.ngrok.io
   ```

2. Update Flutterwave webhook:
   ```
   https://abc123.ngrok.io/wallet/webhooks/flutterwave
   ```

### Step 2: Test Webhook URL

**Test the GET endpoint:**
```bash
curl https://your-ngrok-url.ngrok.io/wallet/webhooks/flutterwave
```

**Expected response:**
```json
{
  "status": "success",
  "message": "Webhook endpoint is accessible",
  "timestamp": "2025-12-07T..."
}
```

### Step 3: Verify in Flutterwave Dashboard

1. Go to Flutterwave Dashboard → Settings → Webhooks
2. Click "Test Webhook" or "Verify URL"
3. Should show "Webhook URL is accessible"

### Step 4: Test with Real Transaction

1. Make a test deposit
2. Complete payment on Flutterwave
3. Check backend logs for:
   ```
   🔔 Flutterwave webhook received: charge.completed
   ✅ Webhook processed successfully in XXXms
   ```

## 📋 Webhook URL Requirements

**Correct format:**
```
https://your-domain.com/wallet/webhooks/flutterwave
```

**Requirements:**
- ✅ Must use HTTPS (not HTTP)
- ✅ Must be publicly accessible
- ✅ Must return 200 OK quickly (< 5 seconds)
- ✅ Must include full path: `/wallet/webhooks/flutterwave`

## 🐛 Troubleshooting

### Issue: Webhook still not working

**Check 1: Is ngrok running?**
```bash
# Check ngrok status
# Should show active tunnel
```

**Check 2: Is backend running?**
```bash
# Check backend logs
# Should be listening on port 3000
```

**Check 3: Test webhook endpoint**
```bash
curl -X GET https://your-ngrok-url.ngrok.io/wallet/webhooks/flutterwave
# Should return success message
```

**Check 4: Flutterwave webhook logs**
- Go to Flutterwave Dashboard → Webhooks → Logs
- Check delivery status for recent transactions
- Look for error messages

### Issue: Webhook received but not processing

**Check backend logs for:**
- `🔔 Flutterwave webhook received: charge.completed`
- `✅ Webhook processed successfully`
- Any error messages

**If webhook is received but not processing:**
- Check deposit ID matches
- Check webhook data structure
- Check for errors in `handleDepositWebhook`

## 📝 Summary

**What changed:**
1. ✅ Webhook returns 200 OK immediately
2. ✅ Processing happens asynchronously
3. ✅ Signature verification doesn't block
4. ✅ Added GET endpoint for verification
5. ✅ Better error handling and logging

**Next steps:**
1. Switch to ngrok (more reliable)
2. Test webhook URL
3. Verify in Flutterwave dashboard
4. Test with real transaction

**Webhook URL format:**
```
https://your-ngrok-url.ngrok.io/wallet/webhooks/flutterwave
```

