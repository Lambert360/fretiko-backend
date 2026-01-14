# WebSocket Gateway Debug Checklist

## ✅ Changes Applied

1. **Added `OnGatewayInit` interface** to `AdminNotificationsGateway`
2. **Added constructor logging** to track instantiation
3. **Added `afterInit()` method** with detailed initialization logs
4. **Verified** `@nestjs/platform-socket.io` is installed (v11.1.6)
5. **Verified** `main.ts` has custom Socket.IO adapter configured

## 🔍 What to Look For After Restart

### Expected Logs (Success):
```
🔧 AdminNotificationsGateway constructor called
🔑 JWT_SECRET configured: ✅ Yes (length: XX)
🚀 ========================================
🚀 AdminNotificationsGateway INITIALIZED
🚀 Namespace: /admin-notifications
🚀 CORS: Enabled (origin: true)
🚀 Server adapter: SocketIoAdapter
🚀 ========================================
```

### If Only Constructor Log Appears:
```
🔧 AdminNotificationsGateway constructor called
🔑 JWT_SECRET configured: ✅ Yes (length: XX)
(but no "INITIALIZED" message)
```
**Diagnosis**: Constructor succeeds but `afterInit()` not called
**Cause**: WebSocket server not starting for this namespace
**Solution**: Check for port conflicts or adapter issues

### If NO Logs Appear:
```
(complete silence - no constructor log)
```
**Diagnosis**: Gateway class not being instantiated at all
**Cause**: Circular dependency or DI failure
**Solution**: Check AdminService dependencies

## 🐛 If Gateway Still Doesn't Initialize

### Test 1: Temporarily Remove Circular Dependency

In `admin.service.ts`, comment out:
```typescript
// @Inject(forwardRef(() => AdminNotificationsService))
// private adminNotificationsService: AdminNotificationsService,
```

Also comment out any usage of `this.adminNotificationsService` in admin.service.ts

### Test 2: Check for Module Import Issues

Verify in `admin.module.ts`:
- `AdminNotificationsGateway` is in `providers` array ✅
- `AdminNotificationsService` is in `providers` array ✅
- `JwtModule` is properly configured ✅

### Test 3: Check JWT_SECRET

```bash
# In PowerShell
$env:JWT_SECRET
# Should output the secret key
```

## 📊 Current Status

- ✅ Gateway file modified with logging
- ✅ Socket.IO packages installed
- ✅ WebSocket adapter configured
- ⏳ Awaiting backend restart to see logs

## 🚀 Next Steps

1. **Restart backend server** (Ctrl+C, then `npm run start:dev`)
2. **Watch logs** for the 🔧 and 🚀 emojis
3. **Open admin panel** in browser
4. **Check browser console** (F12) for WebSocket connection
5. **Report findings**: Which logs appear?

