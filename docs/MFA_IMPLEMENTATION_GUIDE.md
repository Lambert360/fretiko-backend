# MFA (Multi-Factor Authentication) Implementation Guide

**Status:** Phase 1 Complete (Login Step-Up) | Phase 2 Complete (Enrollment & Management) | Phase 3 Complete (Backup Codes + Remember Device, not yet end-to-end tested with a real device)  
**Date Started:** September 23, 2026  
**Technology:** TOTP (Time-based One-Time Password) via Supabase Auth  
**Authenticator Apps Supported:** Google Authenticator, Authy, Microsoft Authenticator, 1Password, LastPass, FreeOTP, etc.

---

## Overview

Fretiko now has a complete MFA infrastructure for defense-in-depth security. Even if a user's password is compromised, attackers cannot access the account without the second factor (6-digit code from an authenticator app).

### Key Features
- ✅ **TOTP-based 2FA** — Industry standard, no SMS costs, works offline
- ✅ **Optional enrollment** — Users opt-in via Settings → Security
- ✅ **Step-up authentication** — MFA required only after password success
- ✅ **Secure token handling** — Supabase session tokens in-memory, app tokens in SecureStore
- ✅ **Graceful fallback** — Users without MFA enrolled are completely unaffected
- ✅ **Backup codes** — 10 one-time codes, bcrypt-hashed, shown at enrollment
- ✅ **Remember device** — trusted-device tokens skip MFA for 30 days

---

## What's Implemented (Phase 1) ✅

### Backend
- [x] MFA service wrapping Supabase Auth APIs
- [x] MFA controller with all endpoints
- [x] Updated signin flow to detect MFA requirement
- [x] New `/auth/mfa/login-verify` endpoint for step-up
- [x] Error handling & rate limiting
- [x] Helmet security headers
- [x] Dependency vulnerability fixes

### Mobile
- [x] AuthContext extended with MFA state
- [x] `verifyMFA()` function to complete step-up
- [x] `clearMFAState()` to reset on cancel
- [x] MFAVerificationScreen component (6-digit code input)
- [x] LoginScreen integration (conditional rendering)
- [x] API service method `mfaLoginVerify()`
- [x] Feature flag configuration

---

## What's Implemented (Phase 2) ✅

### Backend
- [x] `POST /auth/mfa/session` — mints a short-lived Supabase session for an
      already app-JWT-authenticated user (via admin generateLink + verifyOtp),
      so the mobile app never has to persist long-lived Supabase tokens just
      to reach Settings > Security

### Mobile
- [x] `MFAEnrollmentScreen.tsx` — fetches an MFA session, calls `/enroll`,
      renders the QR code (`react-native-qrcode-svg`) + manual secret, and
      verifies the 6-digit code via `/verify`
- [x] `MFAManagementScreen.tsx` — fetches an MFA session, lists factors via
      `/factors`, and disables via `/unenroll`
- [x] `AccountSettingsScreen.tsx` — "Privacy & Security" row now opens
      `MFAManagement` instead of a "Coming Soon" alert
- [x] Navigation routes for `MFAEnrollment` and `MFAManagement` added to `App.tsx`
- [x] `react-native-qrcode-svg` installed (was declared in package.json but
      missing from node_modules)

### Still Pending
1. **End-to-end testing** — not yet tested with a real authenticator app on
   a device/simulator (this environment has no simulator)
2. **Run migrations 122/123** — `mfa_backup_codes` and `mfa_trusted_devices`
   tables need to be created in Supabase (SQL Editor) before backup codes /
   remember-device work

## What's Implemented (Phase 3) ✅

### Backend
- [x] `POST /auth/mfa/backup-codes` — generates 10 one-time backup codes
      (bcrypt-hashed in `mfa_backup_codes`, plaintext returned once)
- [x] `POST /auth/mfa/login-verify` now accepts `isBackupCode` and
      `rememberDevice` — backup codes verified/consumed instead of TOTP;
      `rememberDevice: true` issues a trusted-device token (30-day expiry,
      bcrypt-hashed in `mfa_trusted_devices`)
- [x] `POST /auth/signin` now accepts `deviceToken` — valid unexpired trusted
      device skips the MFA step-up
- [x] Migrations `122_add_mfa_backup_codes.sql` and
      `123_add_mfa_trusted_devices.sql` (run in Supabase SQL Editor)

### Mobile
- [x] `MFAVerificationScreen` — "Use a backup code instead" toggle +
      "Remember this device for 30 days" checkbox
- [x] `MFAEnrollmentScreen` — shows backup codes after successful enrollment
- [x] `MFAManagementScreen` — "Generate Backup Codes" section (regenerating
      invalidates old codes)
- [x] `AuthContext` — persists `mfa_device_token` in SecureStore, sends it on
      future sign-ins

---

## Files Changed

### Backend
- `src/auth/mfa.service.ts` — NEW
- `src/auth/mfa.controller.ts` — NEW
- `src/auth/dto/mfa.dto.ts` — NEW
- `src/auth/auth.service.ts` — MODIFIED
- `src/auth/auth.controller.ts` — MODIFIED
- `src/auth/auth.module.ts` — MODIFIED
- `src/shared/dto/auth.dto.ts` — MODIFIED
- `src/main.ts` — MODIFIED (Helmet)
- `package.json` — MODIFIED (helmet)

### Mobile
- `src/contexts/AuthContext.tsx` — MODIFIED
- `src/screens/LoginScreen.tsx` — MODIFIED
- `src/screens/MFAVerificationScreen.tsx` — NEW
- `src/services/api.ts` — MODIFIED
- `src/config/features.ts` — NEW

---

## How It Works (Current)

### Login Flow with MFA
```
1. User enters email/password
2. Backend validates password
3. If MFA enrolled: return mfaRequired: true + Supabase tokens
4. Mobile app shows MFAVerificationScreen
5. User enters 6-digit code from authenticator app
6. Backend validates code via Supabase
7. Backend returns app tokens
8. User logged in
```

### Key Endpoints
- `POST /auth/signin` — Returns mfaRequired if user has MFA (skipped for trusted devices)
- `POST /auth/mfa/login-verify` — Validates TOTP or backup code, returns tokens
- `POST /auth/mfa/session` — Mints short-lived Supabase session for Settings screens
- `POST /auth/mfa/enroll` — Starts MFA enrollment
- `POST /auth/mfa/verify` — Confirms MFA enrollment
- `POST /auth/mfa/factors` — Lists enrolled factors
- `POST /auth/mfa/unenroll` — Disables MFA
- `POST /auth/mfa/backup-codes` — Generates 10 one-time backup codes

---

## How to Resume (Remaining Work)

### Step 1: Run Migrations in Supabase SQL Editor
- `migrations/120_add_follower_counts_to_user_profiles.sql`
- `migrations/121_add_is_bot_flags.sql`
- `migrations/122_add_mfa_backup_codes.sql`
- `migrations/123_add_mfa_trusted_devices.sql`

### Step 2: Test End-to-End
- Create test user with MFA in Supabase
- Test login with real authenticator app
- Test enrollment flow (QR scan → code → backup codes shown)
- Test backup-code login
- Test remember-device (login once with checkbox → next login skips MFA)
- Test disable flow

---

## Security Summary

✅ **Secure:**
- TOTP is industry standard (GitHub, Google, AWS)
- Supabase handles TOTP validation
- Tokens never logged
- Rate limiting on endpoints
- Helmet security headers

⚠️ **Limitations:**
- No biometric auth yet
- Backup codes are single-use and regenerating invalidates old ones (by design)

---

## Testing Status

✅ Backend: tsc clean, endpoints respond correctly  
✅ Mobile: imports correct, state management sound  
✅ Integration: backend + mobile endpoints match  
✅ Regression: existing login unaffected  

❌ End-to-end: not yet tested with real authenticator app  
❌ Migrations 120-123: not yet run in Supabase SQL Editor

---

## Next Steps

When resuming:
1. Run migrations 120-123 in Supabase SQL Editor
2. Test end-to-end (enroll, login, backup codes, remember device)
3. Prepare for app store

---

**Version:** 1.1  
**Last Updated:** September 23, 2026  
**Status:** Phase 1, 2, 3 Complete — pending end-to-end testing
