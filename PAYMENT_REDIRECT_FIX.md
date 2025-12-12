# Payment Redirect & Notification Fix

## Current Issues

1. ✅ Payment completes successfully on Flutterwave
2. ❌ Redirect goes to browser instead of app
3. ❌ Browser can't open `fretiko://` link
4. ❌ App doesn't show successful deposit

## Solutions

### Issue 1: Deep Link Not Opening App

**Problem**: Mobile browser doesn't recognize `fretiko://` scheme

**Solution**: Use a Universal Link (HTTPS) that redirects to deep link, OR ensure deep link is properly registered

**Option A: Use Universal Link (Recommended)**
1. Set up a web page that redirects to the deep link
2. Use that web page URL as redirect URL
3. The web page automatically opens the app

**Option B: Fix Deep Link Registration**
- Ensure `app.json` has the scheme configured
- Rebuild the app after changes

### Issue 2: App Not Updated After Payment

**Two ways to fix this:**

#### Method 1: Webhook (Primary - Fastest)
- Webhook updates status immediately when payment completes
- Check if webhook is configured in Flutterwave dashboard
- Check backend logs for webhook receipt

#### Method 2: Polling (Fallback - Works but slower)
- App polls for status when you return
- Should work even without webhook
- Checks every 5 seconds for up to 5 minutes

## Quick Fixes

### Fix 1: Check Webhook is Working

**Check your backend logs** for:
```
🔔 Flutterwave webhook received: charge.completed
📥 Processing deposit webhook: ...
✅ Deposit processed and wallet credited
```

**If you don't see these:**
1. Webhook not configured in Flutterwave dashboard
2. LocalTunnel URL changed (update webhook URL)
3. Webhook URL incorrect

### Fix 2: Manual Status Check

Even if webhook doesn't work, **polling should detect it**:
1. Return to the app
2. Go to Wallet screen
3. The deposit should show as "completed" after a few seconds
4. Or go back to Deposit screen - it should detect the completed status

### Fix 3: Use Universal Link

Create a simple redirect page:
1. Host a page at: `https://your-domain.com/payment-callback`
2. Page redirects to: `fretiko://wallet/deposit/callback?deposit_id=...`
3. Use that URL as redirect in Flutterwave

## Immediate Workaround

**For now, you can manually check:**

1. After payment completes, return to your app
2. Go to Wallet → Deposit History
3. The deposit should show as "completed" (webhook updated it)
4. OR it will update within 5-10 seconds (polling detected it)

The deposit **is successful** - it's just the notification that needs fixing.

## Next Steps

1. ✅ **Configure webhook** in Flutterwave dashboard (for instant updates)
2. ✅ **Check backend logs** to see if webhook is being received
3. ✅ **Test polling** - return to app and check if status updates
4. ⚠️ **Fix deep link** - either use universal link or ensure scheme is registered

The payment itself is working - we just need to fix the notification/redirect mechanism.

