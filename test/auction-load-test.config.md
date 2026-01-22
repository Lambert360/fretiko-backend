## Auction Load Testing – High Concurrency Plan

This document describes how to stress‑test the live auction system (bidding + WebSocket) using an external tool such as **k6** or **Artillery**.

> Note: This file defines the scenarios and example payloads.  
> The actual runner (k6/Artillery) can be executed from a separate tooling repo or CI.

---

### 1. Target Endpoints

**WebSocket Namespace**
- `wss://<API_BASE_URL>/auctions` (Socket.IO namespace `/auctions`)

**Key Events**
- `join_auction` – join a specific auction room.
- `place_bid` – submit a bid.
- `leave_auction` – leave auction room.

**REST (optional warm‑up)**
- `GET /auctions/:id` – fetch auction details.
- `GET /auctions/:id/bids` – fetch public bid history.

---

### 2. Test Scenarios

#### Scenario A – Viewer Join Storm

**Goal:** Validate gateway and room handling with many concurrent viewers.

**Steps (per virtual user)**
1. Connect to `/auctions` namespace.
2. Emit `join_auction` with `{ auction_id, user_id }`.
3. Stay connected for 60–180 seconds.
4. Periodically listen for:
   - `auction_status_changed`
   - `view_count_updated`
   - `item_event`
5. Emit `leave_auction` and disconnect.

**Load Profile**
- Ramp from 0 → 500 concurrent users over 2–5 minutes.
- Hold for 5–10 minutes.

**Success Criteria**
- Connection error rate < 1%.
- Join latency (connect + join_auction) < 1s p95.
- Gateway process remains healthy (no crashes).

---

#### Scenario B – Bid Burst (Bidding Under Load)

**Goal:** Stress‑test `place_bid` and broadcast flows.

**Steps (per virtual user)**
1. Connect and `join_auction`.
2. Every 2–5 seconds:
   - Emit `place_bid` with:
     ```jsonc
     {
       "auction_id": "<ID>",
       "amount": "<current_bid + increment>",
       "bid_type": "manual"
     }
     ```
3. Listen for:
   - `new_bid`
   - `bid_confirmed`
   - `bid_error`
4. Run for 60–120 seconds, then disconnect.

**Load Profile**
- 100–300 concurrent bidders.
- Optionally run in waves: 30s on / 30s off.

**Success Criteria**
- `bid_error` rate low and explainable (e.g., outbid, min increment).
- No duplicate winning bids.
- No stale or out‑of‑order status events.

---

#### Scenario C – Mixed Traffic (Viewers + Bidders)

**Goal:** Simulate real event: many viewers, some active bidders.

**Mix**
- 70–80% users: **view only** (Scenario A pattern).
- 20–30% users: **active bidders** (Scenario B pattern).

**Duration**
- 15–30 minutes.

**Success Criteria**
- Stable latency and low error rates across all events.
- CPU/memory within acceptable limits on gateway and API nodes.

---

### 3. Example k6 Pseudocode

```js
// Pseudocode – run from a separate k6 project
import ws from 'k6/ws';
import { check, sleep } from 'k6';

export let options = {
  vus: 200,
  duration: '10m',
};

export default function () {
  const url = 'wss://API_BASE_URL/auctions';

  ws.connect(url, { tags: { auctionId: 'AUCTION_ID' } }, function (socket) {
    socket.on('open', () => {
      socket.emit('join_auction', { auction_id: 'AUCTION_ID', user_id: `user-${__VU}` });
    });

    socket.on('new_bid', (data) => {
      // optionally collect metrics
    });

    // Emit bids for bidder profiles
    if (__VU % 5 === 0) {
      // 1/5 of users are bidders
      socket.setInterval(() => {
        socket.emit('place_bid', {
          auction_id: 'AUCTION_ID',
          amount: 1000 + (__ITER * 10),
          bid_type: 'manual',
        });
      }, 3000);
    }

    socket.setTimeout(() => {
      socket.close();
    }, 60000);
  });
}
```

---

### 4. Metrics to Monitor

- WebSocket:
  - Connection success/failure counts.
  - Average and p95 send/receive latency.
  - Room sizes (`getAuctionViewerCount`).
- Backend:
  - API response times for any REST calls used.
  - Error logs from `AuctionGateway` and `AuctionsService`.
  - DB metrics (connection count, slow queries).

---

### 5. Safety & Data Reset

- Use **staging** environment and dedicated test auctions.
- Ensure:
  - Test auctions are clearly labeled and not visible in production discovery.
  - Scheduled cleanup job or manual script removes test bids and auctions after tests.


