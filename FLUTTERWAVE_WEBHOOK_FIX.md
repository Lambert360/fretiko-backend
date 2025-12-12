# Flutterwave Webhook Fix - Best Practices

## Common Issues with Flutterwave Webhooks

### 1. **HTTPS Requirement**
- Flutterwave **requires HTTPS** for webhooks
- LocalTunnel provides HTTPS, but can be unreliable
- **Solution**: Use ngrok for more stable HTTPS tunneling

### 2. **Webhook URL Must Be Publicly Accessible**
- Flutterwave must be able to reach your webhook URL
- LocalTunnel/ngrok must be running
- URL must not have typos

### 3. **Quick Response Required**
- Flutterwave expects a **200 OK response within 5 seconds**
- If response is slow, Flutterwave marks it as failed
- **Solution**: Process webhook asynchronously, return 200 immediately

### 4. **Signature Verification**
- Flutterwave sends `verif-hash` header for security
- Must verify signature before processing
- **Solution**: Verify signature, but don't block on failure (log it)

### 5. **Raw Body Requirement**
- Signature verification needs raw request body
- NestJS must be configured to preserve raw body
- **Solution**: Use express.raw() middleware correctly

## Recommended Fixes

### Fix 1: Use ngrok Instead of LocalTunnel
**Why:**
- ngrok is more stable and reliable
- Better HTTPS support
- More consistent URLs
- Better for production-like testing

**How:**
1. Install ngrok: `npm install -g ngrok` or download from ngrok.com
2. Start ngrok: `ngrok http 3000`
3. Get HTTPS URL (e.g., `https://abc123.ngrok.io`)
4. Update `.env`: `API_URL=https://abc123.ngrok.io`
5. Update Flutterwave webhook: `https://abc123.ngrok.io/wallet/webhooks/flutterwave`

### Fix 2: Return 200 OK Immediately
**Current Issue**: Webhook processing might be slow, causing Flutterwave to timeout

**Solution**: Process webhook asynchronously, return 200 OK immediately

### Fix 3: Better Error Handling
- Log all webhook attempts (even failed ones)
- Don't fail on signature verification errors (log and continue)
- Return proper HTTP status codes

### Fix 4: Webhook URL Verification Endpoint
- Add a simple GET endpoint to verify webhook URL is accessible
- Flutterwave can test this to confirm URL is correct

## Implementation Steps

1. **Switch to ngrok** (more reliable)
2. **Update webhook handler** to return 200 OK immediately
3. **Add webhook verification endpoint**
4. **Improve logging** for debugging
5. **Test webhook** with Flutterwave's test feature

