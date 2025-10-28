# 🚀 Deployment Checklist - Freti Escrow System

## Pre-Deployment Verification

### ✅ **Database Migrations**
- [ ] Review all 5 new migration files:
  - `add-escrow-rls-policies.sql`
  - `add-service-bookings-order-id.sql`
  - `add-disputes-table.sql`
  - `add-dispute-messages-table.sql`
  - `add-dispute-rls-policies.sql`
- [ ] Run migrations in staging environment first
- [ ] Verify no conflicts with existing schema
- [ ] Test rollback procedures

### ✅ **Environment Configuration**
- [ ] `SUPABASE_URL` configured
- [ ] `SUPABASE_ANON_KEY` configured  
- [ ] `SUPABASE_SERVICE_KEY` configured (for RLS bypass)
- [ ] `JWT_SECRET` configured
- [ ] `PORT` configured (default: 3000)
- [ ] Redis URL configured (if using Socket.IO scaling)

### ✅ **Admin User Setup**
```sql
-- Create admin user in user_profiles table
UPDATE user_profiles 
SET role = 'admin', 
    preferences = jsonb_set(preferences, '{isAdmin}', 'true')
WHERE email = 'admin@freti.com';
```
- [ ] Admin user created
- [ ] Admin access tested: `GET /admin/stats`

---

## Backend Deployment

### ✅ **1. Install & Build**
```bash
cd fretiko-backend
npm install
npm run build
```
- [ ] No build errors
- [ ] All dependencies installed

### ✅ **2. Database Setup**
```bash
# Apply migrations (if using a migration tool)
npm run migration:run

# Or manually execute SQL files in Supabase Dashboard
```
- [ ] All migrations applied successfully
- [ ] RLS policies active
- [ ] Foreign key constraints verified

### ✅ **3. Start Server**
```bash
npm run start:prod
```
- [ ] Server starts without errors
- [ ] Health check endpoint responds: `GET /`
- [ ] Scheduled tasks initialized (check logs for "Running cron job")

### ✅ **4. Verify Core Endpoints**
```bash
# Test authentication
curl -X POST https://api.freti.com/auth/login

# Test wallet endpoint
curl -X GET https://api.freti.com/wallet \
  -H "Authorization: Bearer {token}"

# Test workspace stats
curl -X GET https://api.freti.com/workspace/stats \
  -H "Authorization: Bearer {token}"

# Test admin endpoint (with admin token)
curl -X GET https://api.freti.com/admin/stats \
  -H "Authorization: Bearer {adminToken}"
```
- [ ] All endpoints respond
- [ ] Authentication working
- [ ] RLS enforced (users can't see others' data)

---

## Mobile/Frontend Deployment

### ✅ **1. Update Configuration**
```typescript
// services/api.ts or config.ts
export const API_BASE_URL = 'https://api.freti.com';
export const SOCKET_URL = 'https://api.freti.com';
```
- [ ] API base URL updated
- [ ] Socket.IO URL updated
- [ ] No hardcoded localhost URLs

### ✅ **2. Build & Deploy**
```bash
cd fretiko-mobile
npm install
npm run build  # or eas build for Expo
```
- [ ] Build successful
- [ ] No TypeScript errors
- [ ] Assets optimized

### ✅ **3. Push Notifications**
- [ ] FCM (Firebase) credentials configured
- [ ] APNs (Apple) certificates configured
- [ ] Test notification delivery

---

## Post-Deployment Testing

### ✅ **Critical Path Test**

**Test 1: Complete Order Flow**
1. [ ] Buyer places order
2. [ ] Escrow created
3. [ ] Vendor receives notifications
4. [ ] Vendor accepts & delivers
5. [ ] Buyer confirms receipt
6. [ ] Escrow auto-releases after 24h
7. [ ] Vendor wallet credited

**Test 2: Real-Time Updates**
1. [ ] Open WalletScreen on mobile
2. [ ] Trigger wallet update from web/another device
3. [ ] Verify balance updates without refresh
4. [ ] Check notification received

**Test 3: Live Stream Purchase**
1. [ ] Start live stream
2. [ ] Purchase product during stream
3. [ ] Verify order created with `source: 'live_stream'`
4. [ ] Verify escrow created

**Test 4: Service Booking**
1. [ ] Book service during stream
2. [ ] Vendor marks completed
3. [ ] Buyer confirms
4. [ ] Escrow releases after 24h

**Test 5: Dispute Flow**
1. [ ] Buyer files dispute
2. [ ] Escrow locked
3. [ ] Admin views in dashboard
4. [ ] Admin resolves
5. [ ] Refund processed

**Test 6: Analytics**
1. [ ] Check workspace stats
2. [ ] Verify escrow metrics accurate
3. [ ] Check vendor/rider performance data
4. [ ] Admin dashboard shows platform revenue

---

## Monitoring Setup

### ✅ **Logs**
- [ ] Application logs configured (Winston, Pino, or similar)
- [ ] Error tracking enabled (Sentry, LogRocket)
- [ ] Structured logging for escrow events

### ✅ **Alerts**
- [ ] Alert on high dispute rate (> 5%)
- [ ] Alert on escrow failures
- [ ] Alert on overdue escrows (> 48 hours)
- [ ] Alert on server errors

### ✅ **Metrics**
- [ ] Track escrow creation success rate
- [ ] Track auto-release execution
- [ ] Track notification delivery rate
- [ ] Track API response times

### ✅ **Database Monitoring**
- [ ] Query performance monitoring
- [ ] Index usage tracking
- [ ] RLS policy performance
- [ ] Connection pool monitoring

---

## Security Verification

### ✅ **Access Control**
- [ ] Admin endpoints only accessible to admins
- [ ] RLS policies prevent unauthorized data access
- [ ] JWT tokens expire appropriately
- [ ] Service role key secured (not exposed to clients)

### ✅ **Data Protection**
- [ ] Sensitive data encrypted at rest
- [ ] API uses HTTPS only
- [ ] Socket.IO uses WSS (secure WebSockets)
- [ ] No sensitive data in logs

### ✅ **Rate Limiting**
- [ ] API rate limits configured
- [ ] Escrow creation rate limited (prevent abuse)
- [ ] Admin endpoints extra protected

---

## Backup & Recovery

### ✅ **Database Backups**
- [ ] Automated daily backups enabled
- [ ] Backup retention policy set (30 days minimum)
- [ ] Test restore procedure
- [ ] Point-in-time recovery available

### ✅ **Disaster Recovery**
- [ ] Failover plan documented
- [ ] Database replication configured
- [ ] Load balancer configured (if applicable)
- [ ] CDN configured for static assets

---

## Performance Optimization

### ✅ **Backend**
- [ ] Database indexes on:
  - `escrows(order_id, status)`
  - `orders(buyer_id, vendor_id, rider_id, status)`
  - `wallet_ledger(user_id, created_at)`
- [ ] Connection pooling configured
- [ ] Query optimization verified
- [ ] Cron job runs efficiently (< 1 minute)

### ✅ **Frontend/Mobile**
- [ ] API responses cached where appropriate
- [ ] Images optimized
- [ ] Lazy loading implemented
- [ ] Socket.IO reconnection logic works

---

## Documentation

### ✅ **User-Facing**
- [ ] Help articles for escrow system
- [ ] FAQ about disputes
- [ ] Vendor guide for workspace analytics
- [ ] Admin dashboard user guide

### ✅ **Developer**
- [ ] API documentation updated (Swagger/OpenAPI)
- [ ] Database schema documented
- [ ] Environment variables documented
- [ ] Deployment guide accessible to team

---

## Rollback Plan

### ✅ **If Issues Arise**
1. [ ] Document rollback procedure:
   ```bash
   # Revert to previous version
   git revert {commit-hash}
   npm run build
   pm2 restart fretiko-backend
   ```
2. [ ] Database rollback scripts ready
3. [ ] Communication plan for users
4. [ ] Support team notified

---

## Go-Live Checklist

### ✅ **Final Steps Before Launch**
- [ ] All tests passed
- [ ] Monitoring dashboards configured
- [ ] Support team trained on new features
- [ ] User communication sent (if major changes)
- [ ] Backup verified
- [ ] Rollback plan reviewed

### ✅ **Launch!**
- [ ] Deploy backend to production
- [ ] Deploy frontend/mobile to production
- [ ] Monitor for errors (first hour critical)
- [ ] Verify escrow creation working
- [ ] Verify notifications sending
- [ ] Verify real-time updates working
- [ ] Check admin dashboard accessible

---

## Post-Launch Monitoring (First 24 Hours)

### ✅ **Watch For:**
- [ ] Error rates (should be < 0.1%)
- [ ] Escrow creation success rate (should be > 99%)
- [ ] Notification delivery rate (should be > 95%)
- [ ] API response times (p95 < 200ms)
- [ ] User feedback/support tickets

### ✅ **Daily Checks (First Week)**
- [ ] Review escrow health metrics
- [ ] Check for overdue escrows
- [ ] Review dispute rates
- [ ] Monitor auto-release execution
- [ ] Check wallet balance integrity

---

## Success Criteria

### ✅ **System is Production-Ready When:**
- ✅ All tests passing
- ✅ Zero critical bugs
- ✅ RLS policies enforced
- ✅ Monitoring and alerts active
- ✅ Documentation complete
- ✅ Team trained
- ✅ Backup and recovery tested

---

## Support Contact

**For Deployment Issues:**
- Backend Lead: [Your Name]
- DevOps: [Team Contact]
- Database Admin: [Contact]

**Emergency Contacts:**
- On-Call Engineer: [Phone]
- Technical Lead: [Phone]

---

## 🎉 **Deployment Complete!**

Once all checkboxes are ticked, the Freti Escrow System is **LIVE** and ready to protect buyers and ensure vendors get paid. 🚀

**Remember:**
- Monitor closely for first 24 hours
- Be ready to rollback if needed
- Communicate any issues promptly
- Celebrate the launch! 🎊

