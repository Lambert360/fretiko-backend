# Complete Testing Guide - Freti Escrow & Order System

## 📋 Table of Contents
1. [Escrow Flow Testing](#1-escrow-flow-testing)
2. [Notification System Testing](#2-notification-system-testing)
3. [Real-Time Updates Testing](#3-real-time-updates-testing)
4. [Workspace Analytics Testing](#4-workspace-analytics-testing)
5. [Admin Dashboard Testing](#5-admin-dashboard-testing)

---

## 1. Escrow Flow Testing

### **Test Case 1.1: Regular Product Order with Escrow**

#### Prerequisites:
- 3 test accounts: Buyer, Vendor, Rider
- Vendor has products in marketplace
- All accounts have wallet balance

#### Steps:

**1. Place Order (Buyer)**
```bash
POST /checkout/create-order
{
  "items": [{"productId": "...", "quantity": 2}],
  "paymentMethodId": "wallet",
  "deliveryAddress": {...}
}
```
✅ **Expected:**
- Order created with `status: 'pending'`
- Buyer wallet debited
- Escrow created with `status: 'held'`
- Vendor receives notification: "New Order! 🎉"
- Vendor receives notification: "Payment Confirmed ✅"

**2. Verify Escrow Created**
```bash
GET /wallet
```
✅ **Expected:**
- Buyer: `availableBalance` reduced
- Vendor: `pendingVendorEarnings` > 0 (funds in escrow)

**3. Vendor Accepts Order**
```bash
POST /workspace/orders/{orderId}/accept
```
✅ **Expected:**
- Order status → `'accepted'`
- Buyer receives notification: "Order Accepted! 👍"

**4. Vendor Marks Ready**
```bash
POST /workspace/orders/{orderId}/ready
```
✅ **Expected:**
- Order status → `'ready_for_pickup'`

**5. Rider Accepts & Picks Up**
```bash
POST /riders/orders/{orderId}/assign
POST /workspace/orders/{orderId}/pickup
```
✅ **Expected:**
- Order status → `'out_for_delivery'`
- Rider receives notification: "New Delivery Assignment 🏍️"

**6. Rider Marks Delivered**
```bash
POST /workspace/orders/{orderId}/delivered
{
  "deliveryProof": {...}
}
```
✅ **Expected:**
- Order status → `'delivered'`
- Escrow `auto_release_at` set to +24 hours
- Buyer notified to confirm receipt

**7. Buyer Confirms Receipt**
```bash
POST /orders/{orderId}/confirm-receipt
```
✅ **Expected:**
- Order status → `'completed'`
- Escrow `auto_release_at` timer started (24 hours)
- Success message mentions 24-hour dispute window

**8. Wait or Trigger Auto-Release**
```bash
# Option A: Wait 24+ hours
# Option B: Manually trigger (for testing)
GET /admin/escrow-health  # Check overdue escrows
# Or run the cron job manually
```
✅ **Expected:**
- Escrow status → `'released'`
- Vendor wallet credited with `vendor_amount`
- Rider wallet credited with `rider_amount`
- Vendor receives notification: "Payment Released! 💰"
- Rider receives notification: "Delivery Fee Paid! 💵"
- Real-time wallet update broadcast
- Order status remains `'completed'`

**9. Verify Final Balances**
```bash
GET /wallet  (as vendor)
GET /wallet  (as rider)
GET /wallet/history
```
✅ **Expected:**
- Vendor: `availableBalance` increased by vendor_amount
- Rider: `availableBalance` increased by rider_amount
- Wallet history shows `'escrow_release'` and `'delivery_payment'` transactions

---

### **Test Case 1.2: Live Stream Purchase with Escrow**

#### Steps:

**1. Start Live Stream (Vendor)**
```bash
POST /live-sales/streams
```

**2. Buy Product During Stream (Buyer)**
```bash
POST /live-sales/purchase-product
{
  "streamId": "...",
  "productId": "...",
  "quantity": 1
}
```
✅ **Expected:**
- Order created with `source: 'live_stream'`
- Escrow created
- Vendor notified

**3. Follow same flow as Test 1.1** (steps 3-9)

---

### **Test Case 1.3: Service Booking with Escrow**

#### Steps:

**1. Book Service During Stream**
```bash
POST /live-sales/book-service
{
  "streamId": "...",
  "serviceId": "...",
  "serviceDate": "2024-12-01",
  "serviceTime": "14:00"
}
```
✅ **Expected:**
- Order created with `source: 'service_booking'`
- Escrow created (no rider fee, only vendor + platform)
- Service booking linked to order

**2. Vendor Completes Service**
```bash
POST /workspace/orders/{orderId}/complete-service
{
  "completionNotes": "Service completed successfully"
}
```
✅ **Expected:**
- Order status → `'delivered'`
- Service booking status → `'pending_confirmation'`
- Buyer notified to confirm
- **Escrow timer NOT YET set** (waiting for buyer confirmation)

**3. Buyer Confirms Service**
```bash
POST /orders/{orderId}/confirm-receipt
```
✅ **Expected:**
- Order status → `'completed'`
- Service booking status → `'completed'`
- Escrow `auto_release_at` timer NOW set (+24 hours)

**4. Auto-Release** (after 24 hours)
✅ **Expected:**
- Vendor wallet credited
- No rider payment (services don't have delivery)

---

### **Test Case 1.4: Auction Win with Escrow**

#### Steps:

**1. Win Auction & Checkout**
```bash
POST /auctions/{auctionId}/checkout
```
✅ **Expected:**
- Order created with `source: 'auction'`
- Escrow created
- Follow same flow as regular orders

---

### **Test Case 1.5: Dispute Flow**

#### Steps:

**1. Buyer Disputes Before Auto-Release**
```bash
POST /disputes
{
  "orderId": "...",
  "disputeType": "item_not_received",
  "reason": "Delivered to wrong address",
  "evidence": [...]
}
```
✅ **Expected:**
- Dispute record created
- Escrow status → `'dispute'`
- Order status → `'dispute'`
- Vendor notified: "Dispute Filed ⚠️"
- Auto-release STOPPED

**2. Admin Reviews & Resolves**
```bash
GET /admin/disputes
POST /disputes/{disputeId}/resolve
{
  "resolution": "refund_buyer",
  "adminNotes": "Evidence shows wrong address"
}
```
✅ **Expected:**
- Escrow status → `'refunded'`
- Buyer wallet credited
- Buyer receives notification: "Order Refunded 💵"

---

## 2. Notification System Testing

### **Test Case 2.1: Vendor Notifications**

#### Test all vendor notification types:

**1. New Order**
- Trigger: Buyer places order
- Expected: "New Order! 🎉" with order details
- Action buttons: [Accept Order] [View Details]

**2. Payment in Escrow**
- Trigger: Payment processed
- Expected: "Payment Confirmed ✅" with amount in escrow

**3. Escrow Released**
- Trigger: Auto-release or manual release
- Expected: "Payment Released! 💰" with amount credited
- Action buttons: [View Wallet] [Withdraw]

### **Test Case 2.2: Rider Notifications**

**1. New Assignment**
- Trigger: Order assigned to rider
- Expected: "New Delivery Assignment 🏍️" with pickup/delivery addresses
- Action buttons: [Start Delivery] [View Route]

**2. Payment Released**
- Trigger: Escrow released
- Expected: "Delivery Fee Paid! 💵" with delivery fee amount
- Action buttons: [View Wallet] [Withdraw]

### **Test Case 2.3: Buyer Notifications**

**1. Order Accepted**
- Trigger: Vendor accepts order
- Expected: "Order Accepted! 👍"
- Action buttons: [Track Order]

**2. Order Refunded**
- Trigger: Dispute resolved in buyer's favor
- Expected: "Order Refunded 💵" with refund amount

### **Test Case 2.4: Dispute Notifications**

**1. Dispute Filed**
- Trigger: Dispute created
- Expected: Both parties receive "Dispute Filed ⚠️"
- Action buttons: [View Dispute] [Respond]

**2. Dispute Resolved**
- Trigger: Admin resolves
- Expected: Both parties receive "Dispute Resolved ✅" with outcome

### **Verification Steps:**

```bash
# Check notifications endpoint
GET /notifications
GET /notifications/unread
```

✅ **Expected:**
- All notifications appear in list
- Unread count accurate
- Action buttons functional
- Badge indicators correct

---

## 3. Real-Time Updates Testing

### **Test Case 3.1: Wallet Balance Updates**

#### Setup:
- Open WalletScreen on mobile device/emulator
- Have another device/browser ready to trigger updates

#### Steps:

**1. Trigger Wallet Update**
```bash
# From another session
POST /wallet/deposit
POST /orders/{orderId}/confirm-receipt  # Triggers escrow release
```

**2. Observe Mobile Screen**
✅ **Expected:**
- Wallet balance updates WITHOUT refresh
- `escrow_released` event received
- Alert popup: "Payment Released! 💰"
- Pending earnings decrease
- Available balance increases

**Verify WebSocket Events:**
```javascript
// Mobile app console logs should show:
💰 Wallet balance update received: {availableBalance, escrowBalance, ...}
💸 Escrow released received: {amount, orderNumber}
```

---

### **Test Case 3.2: Order Status Updates**

#### Setup:
- Open Order Tracking Screen for an active order
- Have vendor/rider session ready

#### Steps:

**1. Vendor Accepts Order**
```bash
POST /workspace/orders/{orderId}/accept
```

**2. Observe Buyer's Tracking Screen**
✅ **Expected:**
- Status badge updates to "Accepted"
- Timeline updates automatically
- No refresh needed

**3. Continue Order Progression**
```bash
POST /workspace/orders/{orderId}/ready
POST /workspace/orders/{orderId}/pickup
POST /workspace/orders/{orderId}/delivered
```

**4. Observe Each Status Change**
✅ **Expected:**
- Real-time status updates on tracking screen
- Timeline progresses automatically

**Verify WebSocket Events:**
```javascript
// Mobile app console:
📦 ORDER UPDATE: Broadcasted status 'accepted' for order ...
📦 ORDER UPDATE: Broadcasted status 'out_for_delivery' for order ...
```

---

### **Test Case 3.3: Rider Location Updates**

#### Setup:
- Open Order Tracking Screen (buyer view)
- Start rider session with location simulation

#### Steps:

**1. Rider Starts Delivery**
```bash
POST /riders/location/update
{
  "orderId": "...",
  "latitude": 6.5244,
  "longitude": 3.3792,
  "accuracy": 10,
  "heading": 45,
  "speed": 25
}
```

**2. Observe Buyer's Map**
✅ **Expected:**
- Rider marker appears/moves on map
- Rider location updates every few seconds
- Polyline shows route
- ETA updates based on location

**3. Simulate Movement**
```bash
# Send updates with changing coordinates
POST /riders/location/update (every 5 seconds)
```

**4. Observe Smooth Movement**
✅ **Expected:**
- Rider marker animates smoothly
- No jumpy/laggy movements
- Real-time location tracking

**Verify WebSocket Events:**
```javascript
// Mobile app console:
🏍️ RIDER LOCATION: Broadcasted location for rider ... on order ...
```

---

### **Test Case 3.4: Live Stream Real-Time Events**

#### Setup:
- Vendor starts live stream
- Multiple buyers join stream

#### Test Events:

**1. Comments**
```bash
POST /live-sales/comment
```
✅ **Expected:**
- Comment appears instantly for all viewers

**2. Reactions**
```bash
POST /live-sales/react
```
✅ **Expected:**
- Reaction animation broadcasts to all

**3. Product Purchase**
```bash
POST /live-sales/purchase-product
```
✅ **Expected:**
- Stock count updates in real-time for all viewers
- Purchase notification shows

---

## 4. Workspace Analytics Testing

### **Test Case 4.1: Multi-Source Revenue Tracking**

#### Setup:
- Create orders from all 4 sources:
  1. Regular marketplace order
  2. Live stream purchase
  3. Auction win
  4. Service booking

#### Steps:

**1. Check Workspace Stats**
```bash
GET /workspace/stats
```

**2. Verify Order Counts by Source**
✅ **Expected:**
```json
{
  "ordersBySource": {
    "regular": 5,
    "live_stream": 3,
    "auction": 2,
    "service_booking": 1
  }
}
```

**3. Verify Revenue by Source**
✅ **Expected:**
```json
{
  "revenueBySource": {
    "regular": 150.00,
    "live_stream": 75.50,
    "auction": 200.00,
    "service_booking": 50.00
  }
}
```

**4. Verify Totals Match**
✅ **Expected:**
- `todayRevenue` = sum of all sources
- `todayOrders` = sum of order counts

---

### **Test Case 4.2: Escrow-Aware Analytics**

#### Test Metrics:

**1. Escrow Metrics**
```bash
GET /workspace/stats
```
✅ **Expected Response:**
```json
{
  "escrowMetrics": {
    "totalInEscrow": 250.00,
    "riderInEscrow": 25.00,
    "pendingRelease": 100.00,
    "releasedToday": 75.00,
    "escrowCount": 3,
    "averageHoldTimeHours": 26.5,
    "autoReleaseRate": 95.2,
    "disputeRate": 2.1,
    "refundRate": 1.5,
    "totalReleased": 45,
    "totalDisputed": 1,
    "totalRefunded": 1,
    "pendingReleaseCount": 2
  }
}
```

**2. Vendor Performance Metrics**
✅ **Expected:**
```json
{
  "vendorMetrics": {
    "totalOrders": 50,
    "acceptedOrders": 48,
    "cancelledOrders": 2,
    "orderAcceptanceRate": 96.0,
    "cancellationRate": 4.0,
    "averagePreparationTime": 22
  }
}
```

**3. Rider Performance Metrics**
✅ **Expected:**
```json
{
  "riderMetrics": {
    "totalDeliveries": 30,
    "onTimeDeliveries": 28,
    "onTimeDeliveryRate": 93.3,
    "averageDeliveryTime": 18,
    "rating": 4.7,
    "totalRatings": 30
  }
}
```

---

### **Test Case 4.3: Real-Time Analytics Update**

#### Steps:

**1. Note Current Stats**
```bash
GET /workspace/stats
```

**2. Complete an Order**
```bash
# Accept, deliver, confirm receipt, release escrow
```

**3. Check Updated Stats**
```bash
GET /workspace/stats
```

✅ **Expected Changes:**
- `completedToday` += 1
- `todayRevenue` += order amount
- `escrowMetrics.releasedToday` += vendor amount
- Source-specific counts updated

---

## 5. Admin Dashboard Testing

### **Test Case 5.1: Platform Revenue Analytics**

#### Prerequisites:
- Admin account with `role: 'admin'` or `preferences.isAdmin: true`

#### Steps:

**1. Get Platform Revenue**
```bash
GET /admin/revenue?start=2024-01-01&end=2024-12-31
Authorization: Bearer {adminToken}
```

✅ **Expected Response:**
```json
{
  "summary": {
    "totalPlatformFees": 5000.00,
    "realizedRevenue": 4750.00,
    "pendingRevenue": 200.00,
    "lostRevenue": 50.00,
    "averageFeePerTransaction": 9.50
  },
  "transactionCounts": {
    "total": 500,
    "released": 475,
    "held": 20,
    "refunded": 5
  },
  "revenueBySource": {
    "regular": 2000.00,
    "live_stream": 1500.00,
    "auction": 1000.00,
    "service_booking": 250.00,
    "invoice": 0.00
  },
  "topVendors": [
    {
      "vendorId": "...",
      "vendorName": "John's Store",
      "vendorEmail": "john@example.com",
      "totalFeesPaid": 150.00
    }
  ],
  "dailyRevenue": [
    {"date": "2024-11-01", "revenue": 45.00},
    {"date": "2024-11-02", "revenue": 52.50}
  ]
}
```

**2. Verify Calculations**
✅ **Check:**
- `realizedRevenue` + `pendingRevenue` + `lostRevenue` ≈ `totalPlatformFees`
- Top vendors list sorted by fees paid (descending)
- Daily revenue dates sorted chronologically

---

### **Test Case 5.2: Escrow Health Monitoring**

#### Steps:

**1. Get Escrow Health**
```bash
GET /admin/escrow-health
Authorization: Bearer {adminToken}
```

✅ **Expected Response:**
```json
{
  "totalInEscrow": 10000.00,
  "escrowCounts": {
    "total": 525,
    "held": 25,
    "released": 480,
    "disputed": 5,
    "refunded": 15,
    "overdue": 2
  },
  "metrics": {
    "averageHoldTimeHours": 25.5,
    "disputeRate": 0.95,
    "refundRate": 2.86
  },
  "overdueEscrows": [
    {
      "escrowId": "...",
      "amount": 50.00,
      "autoReleaseAt": "2024-11-20T10:00:00Z",
      "hoursOverdue": 12
    }
  ]
}
```

**2. Verify Alerts**
✅ **Check:**
- Overdue escrows list not empty (if any exist)
- Hours overdue calculated correctly
- Dispute/refund rates reasonable (< 10%)

---

### **Test Case 5.3: Active Disputes Review**

#### Steps:

**1. Get Active Disputes**
```bash
GET /admin/disputes
Authorization: Bearer {adminToken}
```

✅ **Expected Response:**
```json
[
  {
    "disputeId": "...",
    "orderNumber": "ORD-12345",
    "orderAmount": 100.00,
    "disputeType": "item_not_received",
    "reason": "Package never arrived",
    "complainant": {
      "id": "...",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+1234567890"
    },
    "respondent": {
      "id": "...",
      "name": "Vendor Store",
      "email": "vendor@example.com",
      "phone": "+0987654321"
    },
    "createdAt": "2024-11-20T14:30:00Z",
    "evidence": [...],
    "adminNotes": null
  }
]
```

**2. Verify Data Completeness**
✅ **Check:**
- All disputes have complainant/respondent info
- Evidence attached (if uploaded)
- Created date recent (for testing)

---

### **Test Case 5.4: Platform Statistics**

#### Steps:

**1. Get Platform Stats**
```bash
GET /admin/stats
Authorization: Bearer {adminToken}
```

✅ **Expected Response:**
```json
{
  "users": {
    "total": 1500,
    "vendors": 300,
    "riders": 50
  },
  "orders": {
    "total": 5000,
    "completed": 4500,
    "completionRate": 90.0
  },
  "wallets": {
    "totalBalance": 50000.00,
    "totalInEscrow": 5000.00,
    "totalPendingWithdrawals": 1000.00
  }
}
```

**2. Verify Business Health**
✅ **Check:**
- Completion rate > 85%
- Total in escrow < 20% of total wallet balance
- User growth trends

---

### **Test Case 5.5: Unauthorized Access**

#### Steps:

**1. Try Admin Endpoints as Regular User**
```bash
GET /admin/revenue
Authorization: Bearer {regularUserToken}
```

✅ **Expected:**
- 401 Unauthorized
- Error message: "Admin access required"

---

## 📊 Testing Checklist Summary

### Core Escrow Flow
- [ ] Regular order → escrow → auto-release
- [ ] Live stream purchase → escrow → release
- [ ] Auction win → escrow → release
- [ ] Service booking → escrow → release
- [ ] Dispute → escrow lock → refund

### Notifications
- [ ] Vendor notifications (new order, payment, release)
- [ ] Rider notifications (assignment, payment)
- [ ] Buyer notifications (accepted, refunded)
- [ ] Dispute notifications (filed, resolved, messages)

### Real-Time Updates
- [ ] Wallet balance updates
- [ ] Order status updates
- [ ] Rider location tracking
- [ ] Live stream events

### Analytics
- [ ] Multi-source revenue tracking
- [ ] Escrow metrics (hold time, rates)
- [ ] Vendor performance metrics
- [ ] Rider performance metrics

### Admin Dashboard
- [ ] Platform revenue analytics
- [ ] Escrow health monitoring
- [ ] Active disputes management
- [ ] Platform-wide statistics
- [ ] Access control (admin only)

---

## 🎯 Expected Results Summary

**If all tests pass:**
✅ Complete order lifecycle functional  
✅ Escrow protection working end-to-end  
✅ Real-time updates broadcasting correctly  
✅ Notifications sent and received  
✅ Analytics accurate across all sources  
✅ Admin dashboard provides platform insights  

**System is production-ready! 🚀**

