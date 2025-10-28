# 🚀 Workspace Stats Optimization Plan

## 🐛 Problem Identified
```
⏱️ [WORKSPACE-UI] Stats fetched in 12241ms ⚠️ 12 SECONDS!
```

**Root Cause:** `getWorkspaceStats()` makes 20+ sequential queries to multiple tables:
- `orders` (4 queries)
- `live_stream_transactions` (3 queries)
- `auction_sales` (3 queries)
- `service_bookings` (3 queries)
- `escrows` (5+ queries)
- Plus additional calculations

## ✅ Solution: Simplify & Optimize

### Strategy 1: Query ONLY `orders` Table (RECOMMENDED)
Since ALL order types are in `orders` with a `source` field:

**Before (20+ queries):**
```typescript
// Query orders
const { data: todayOrders } = await supabase.from('orders')...
const { count: regularPending } = await supabase.from('orders')...
const { count: regularProcessing } = await supabase.from('orders')...

// Query live_stream_transactions  
const { data: todayLive } = await supabase.from('live_stream_transactions')...
const { count: livePending } = await supabase.from('live_stream_transactions')...

// Query auction_sales
const { data: todayAuctions } = await supabase.from('auction_sales')...

// Query service_bookings
const { data: todayBookings } = await supabase.from('service_bookings')...

// Query escrows
const { data: heldEscrows } = await supabase.from('escrows')...
const { data: releasedEscrows } = await supabase.from('escrows')...
const { data: disputedEscrows } = await supabase.from('escrows')...
```

**After (2-3 queries):**
```typescript
// 1. Get ALL today's orders in ONE query
const { data: todayOrders } = await supabase
  .from('orders')
  .select('id, total_amount, status, source, delivery_fee, created_at, metadata')
  .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
  .gte('created_at', `${today}T00:00:00.000Z`);

// 2. Get ALL active orders in ONE query (for counts)
const { data: activeOrders } = await supabase
  .from('orders')
  .select('status, source')
  .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`)
  .in('status', ['pending', 'processing', 'ready_for_pickup']);

// 3. Get escrow data (keep this as is - necessary for escrow metrics)
const { data: escrows } = await supabase
  .from('escrows')
  .select('*')
  .or(`vendor_id.eq.${userId},rider_id.eq.${userId}`);

// Process in JavaScript (fast)
const stats = {
  todayOrders: todayOrders.length,
  todayRevenue: todayOrders.reduce((sum, o) => sum + o.total_amount, 0),
  completedToday: todayOrders.filter(o => o.status === 'delivered').length,
  pendingOrders: activeOrders.filter(o => o.status === 'pending').length,
  processingOrders: activeOrders.filter(o => o.status === 'processing').length,
  ordersBySource: {
    regular: todayOrders.filter(o => o.source === 'regular').length,
    live_stream: todayOrders.filter(o => o.source === 'live_stream').length,
    auction: todayOrders.filter(o => o.source === 'auction').length,
    service_booking: todayOrders.filter(o => o.source === 'service_booking').length,
  },
  // ... etc
};
```

### Expected Performance Improvement
- **Before:** 20+ queries × 500ms avg = 10,000ms+ (10+ seconds)
- **After:** 3 queries × 200ms avg = 600ms ✅

**~95% faster!**

## Implementation Steps

1. ✅ Backup current `getWorkspaceStats()` method
2. ✅ Rewrite to use `orders` table only
3. ✅ Keep escrow queries (necessary for escrow metrics)
4. ✅ Move calculations to JavaScript (fast in-memory processing)
5. ✅ Test performance
6. ✅ Add caching layer (optional - Redis 60s TTL)

## Alternative: Caching Strategy (If Needed)

If stats still slow after optimization:

```typescript
@Cacheable('workspace-stats', 60) // Cache for 60 seconds
async getWorkspaceStats(userId: string) {
  // ... optimized queries
}
```

Or use Redis:
```typescript
const cacheKey = `workspace:stats:${userId}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached);

const stats = await this.calculateStats(userId);
await redis.setex(cacheKey, 60, JSON.stringify(stats));
return stats;
```

## Status
🔧 **Ready to implement** - Will proceed with Strategy 1 (simplify queries)

