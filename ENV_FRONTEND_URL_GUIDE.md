# FRONTEND_URL Configuration Guide

## For Mobile Apps (React Native)

Since you're building a mobile app, `FRONTEND_URL` should be your **deep link scheme**, not a localhost URL.

### Correct Configuration

```env
FRONTEND_URL=fretiko://
```

**OR** if you want to be more specific:

```env
FRONTEND_URL=fretiko://wallet/deposit/callback
```

### Why Not localhost?

- `http://localhost:3000` only works in a web browser
- Mobile apps can't open localhost URLs
- Deep links (`fretiko://`) open your mobile app directly

### Current Implementation

The code now uses deep links directly:
- Redirect URL: `fretiko://wallet/deposit/callback?deposit_id=...`
- This opens your app after payment completion

### If You Have a Web Version

If you also have a web version of your app, you can use:

```env
FRONTEND_URL=https://app.fretiko.com
```

But for mobile-only, use the deep link scheme.

### Summary

**For Mobile App:**
```env
FRONTEND_URL=fretiko://
```

**For Web App:**
```env
FRONTEND_URL=https://app.fretiko.com
```

**For Both:**
Use the deep link scheme for mobile, as that's what the payment redirect uses.

