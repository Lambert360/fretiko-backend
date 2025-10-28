# Service Booking Escrow Flow

## Overview
Service bookings purchased during live streams now create full order and escrow records, ensuring buyer protection and proper vendor payment flow.

---

## Complete Flow

### 1. **Customer Books Service (Live Stream)**
**Endpoint**: `POST /live-sales/book-service`

**What Happens:**
- ✅ Order created in `orders` table
  - `source: 'service_booking'`
  - `escrow_enabled: true`
  - `status: 'pending'`
- ✅ Order item created in `order_items` table
- ✅ Wallet deducted from buyer
- ✅ Escrow record created in `escrows` table
  - `status: 'held'`
  - Funds locked until service completion + confirmation
- ✅ Service booking record created in `service_bookings` table
  - Links to `order_id`
  - `status: 'confirmed'`
- ✅ Vendor notified of new booking
- ✅ Vendor notified that payment is in escrow

**Migration Applied:**
```sql
-- Add order_id column to service_bookings table
ALTER TABLE public.service_bookings 
ADD COLUMN IF NOT EXISTS order_id UUID;

ALTER TABLE public.service_bookings
ADD CONSTRAINT service_bookings_order_id_fkey 
FOREIGN KEY (order_id) 
REFERENCES public.orders(id) 
ON DELETE CASCADE;
```

---

### 2. **Vendor Marks Service as Completed**
**Endpoint**: `POST /workspace/orders/:id/complete-service`

**What Happens:**
- ✅ Order status updated to `'delivered'`
- ✅ Service booking status updated to `'pending_confirmation'`
- ⚠️ **Escrow NOT released yet** (buyer must confirm first)
- ✅ Buyer notified that service is completed and needs confirmation

**Why "delivered" status?**
- Unified order system treats service completion like physical delivery
- Triggers buyer confirmation requirement
- Maintains consistency across all order types

---

### 3. **Buyer Confirms Service Received**
**Endpoint**: `POST /orders/:id/confirm-receipt`

**What Happens:**
- ✅ Order status updated to `'completed'`
- ✅ Service booking status updated to `'completed'`
- ✅ **Escrow auto-release timer set** (24 hours)
  - Gives buyer 24-hour dispute window
  - After 24 hours, funds auto-release to vendor
- ✅ Tracking event created
- ✅ Client relationship updated (buyer → vendor customer)

**Updated Logic:**
```typescript
// Set auto-release timer (24 hours from confirmation)
const autoReleaseAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

await supabase
  .from('escrows')
  .update({
    auto_release_at: autoReleaseAt,
    updated_at: new Date().toISOString(),
  })
  .eq('order_id', orderId)
  .eq('status', 'held');

// Update service_bookings status
if (order.source === 'service_booking') {
  await supabase
    .from('service_bookings')
    .update({
      status: 'completed',
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId);
}
```

---

### 4. **Escrow Auto-Release (24 Hours Later)**
**Scheduled Task**: Runs every hour via `EscrowSchedulerService`

**What Happens:**
- ✅ Vendor wallet credited with `vendor_amount`
- ✅ Rider wallet credited (if applicable - not for services)
- ✅ Platform fee collected
- ✅ Escrow status updated to `'released'`
- ✅ Order status remains `'completed'`
- ✅ Vendor notified of payment release
- ✅ Real-time wallet balance update broadcast
- ✅ Client relationship updated with final transaction data

**Escrow Breakdown for Services:**
```typescript
{
  totalAmount: servicePrice,      // e.g., ₣100
  vendorAmount: servicePrice * 0.98,  // ₣98 (98%)
  riderAmount: 0,                 // Services don't have delivery
  platformAmount: servicePrice * 0.02, // ₣2 (2% platform fee)
}
```

---

## Dispute Handling

### If Buyer Disputes Before Auto-Release

**Buyer Action**: `POST /disputes`
- Order status updated to `'dispute'`
- Escrow status updated to `'dispute'`
- Funds remain locked until admin resolution
- Both parties notified

**Admin Resolution**: `POST /disputes/:id/resolve`
Options:
1. **Release to Vendor** → Escrow released, vendor paid
2. **Refund to Buyer** → Escrow refunded, buyer credited
3. **Partial Refund** → Split funds between parties

---

## Key Differences: Service vs Product Orders

| Aspect | Product Orders | Service Bookings |
|--------|---------------|------------------|
| **Delivery** | Physical delivery by rider | Service completion by vendor |
| **Rider Fee** | 10% of total | 0% (no rider needed) |
| **Platform Fee** | 2% of total | 2% of total |
| **Vendor Amount** | 88% of total | 98% of total |
| **Completion Trigger** | Rider marks delivered | Vendor marks completed |
| **Confirmation** | Buyer confirms receipt | Buyer confirms receipt |
| **Auto-Release** | 24 hours after confirmation | 24 hours after confirmation |

---

## Database Schema

### Orders Table
```sql
source: 'service_booking'  -- Identifies as service order
escrow_enabled: true       -- Escrow protection enabled
metadata: {
  stream_id: uuid,
  service_id: uuid,
  service_name: string,
  booking_date: date,
  booking_time: time,
  duration_minutes: number,
  location_type: string,
  transaction_id: string,
  special_notes: string
}
```

### Service Bookings Table
```sql
id: uuid                  -- Transaction ID (live_svc_...)
order_id: uuid           -- Links to orders table (NEW)
stream_id: uuid          -- Live stream reference
customer_id: uuid        -- Buyer
service_id: uuid         -- Service type
vendor_id: uuid          -- Service provider
booking_date: date       -- Scheduled date
booking_time: time       -- Scheduled time
service_price: numeric   -- Total amount
platform_fee: numeric    -- Platform commission
status: enum            -- confirmed → pending_confirmation → completed
```

### Escrows Table
```sql
order_id: uuid           -- Links to orders table
total_amount: numeric    -- Full service price
vendor_amount: numeric   -- 98% of total
rider_amount: numeric    -- 0 for services
platform_amount: numeric -- 2% of total
status: 'held'          -- Until auto-release
auto_release_at: timestamp -- 24 hours after buyer confirmation
```

---

## API Endpoints Summary

| Endpoint | Method | Purpose | Who |
|----------|--------|---------|-----|
| `/live-sales/book-service` | POST | Purchase service during stream | Buyer |
| `/workspace/orders/:id/complete-service` | POST | Mark service as completed | Vendor |
| `/orders/:id/confirm-receipt` | POST | Confirm service received | Buyer |
| `/workspace/orders/:id/release-escrow` | POST | Manual release request (after 24h) | Vendor |
| `/disputes` | POST | File dispute before auto-release | Buyer |

---

## Notifications Sent

1. **On Purchase** (Vendor):
   - "New Order! 🎉" - Service booking received
   - "Payment Confirmed ✅" - Funds in escrow

2. **On Completion** (Buyer):
   - "Service Completed! 👍" - Please confirm receipt

3. **On Escrow Release** (Vendor):
   - "Payment Released! 💰" - Funds added to wallet

4. **On Dispute** (Both):
   - "Dispute Filed ⚠️" - Order under review

---

## Testing Checklist

- [ ] Book service during live stream
- [ ] Verify order created with `source: 'service_booking'`
- [ ] Verify escrow created with correct breakdown
- [ ] Verify vendor receives notifications
- [ ] Vendor marks service as completed
- [ ] Verify buyer receives completion notification
- [ ] Buyer confirms service received
- [ ] Verify 24-hour auto-release timer set
- [ ] Wait or manually trigger auto-release
- [ ] Verify vendor wallet credited
- [ ] Verify escrow status = 'released'
- [ ] Test dispute flow before auto-release
- [ ] Verify refund to buyer works

---

## Files Modified

### Backend
1. `live-sales.service.ts` - Service booking payment flow
2. `workspace.service.ts` - Added `completeServiceBooking()` method
3. `workspace.controller.ts` - Added `/complete-service` endpoint
4. `orders.service.ts` - Updated `confirmOrderReceipt()` for service bookings
5. `live-sales.module.ts` - Added EscrowModule and NotificationsModule

### Migrations
1. `add-service-bookings-order-id.sql` - Links service bookings to orders

---

## Status
✅ **COMPLETE** - Service bookings fully integrated with order/escrow system

Service bookings now have the same buyer protection and payment guarantees as regular product orders, with proper escrow management and automated release after confirmation.

