## Advanced Auction Analytics – Design Plan

This document outlines the **Phase 3** plan for advanced auction analytics.

### 1. Goals

- Give staff and admins **clear visibility** into auction performance:
  - Revenue from auctions (fees + buyer premiums).
  - Bidder engagement (bids, unique bidders, reactions).
  - Auction health (sell‑through rate, average time to sell).
- Reuse existing analytics patterns from:
  - `analytics.service.ts` (live sales).
  - Admin finance/analytics pages in `fretiko-admin`.

---

### 2. Core Metrics

**Per‑auction metrics**
- `total_bids` – count from `auction_bids`.
- `unique_bidders` – distinct user IDs in `auction_bids`.
- `final_price` – `winning_bid` or last valid bid.
- `reserve_met` – boolean (`winning_bid >= reserve_price` or no reserve).
- `sell_through` – did it result in a sale? (`status = 'sold'`).
- `duration_seconds` – from `start_time` to `end_time`.
- `viewer_count` – from existing `view_count` / room metrics.
- `watch_count` – `watch_count` column.
- `reaction_count` – from new `auction_reactions` table.

**Aggregate metrics (per date range)**
- `total_auction_revenue` (platform side, using existing fee/commission logic).
- `average_bids_per_auction`.
- `average_unique_bidders_per_auction`.
- `average_sell_through_rate`.
- `top_categories_by_revenue`.
- `top_auctions_by_bids` and `by_revenue`.

---

### 3. Backend Implementation (High Level)

**Service Layer**
- Add auction analytics methods (either in `analytics.service.ts` or `auctions.service.ts`):
  - `getAuctionAnalyticsSummary(dateRange)`.
  - `getAuctionLeaderboard(dateRange, limit)`.
  - `getAuctionCategoryBreakdown(dateRange)`.

**Data Sources**
- `auctions` (core auction meta + status).
- `auction_bids` (engagement).
- `auction_reactions` (viewer feedback).
- `wallet_ledger` (fee/commission revenue tagged as `auction`).

**Example query sketch (Supabase RPC or service)**
- Aggregate over `auctions` with:
  - `COUNT(*)` (total auctions).
  - `SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END)` (sold count).
  - Join or correlate with `auction_bids`, `auction_reactions`, `wallet_ledger`.

---

### 4. Admin Panel Integration (Summary)

Use existing admin pages as reference:
- `fretiko-admin/src/app/dashboard/analytics/page.tsx`
- `fretiko-admin/src/app/dashboard/finance/page.tsx`

Add:
- **Auctions tab** inside analytics or finance:
  - Cards: *Total Auction Revenue*, *Sell‑Through Rate*, *Avg Bids/Auction*, *Avg Unique Bidders*.
  - Charts:
    - Line chart of auction revenue over time.
    - Bar chart of categories by revenue/bids.
  - Table:
    - Top 10 auctions (title, category, revenue, bids, bidders, status).

---

### 5. Phased Rollout

**Phase 3.A – Backend only**
- Implement `getAuctionAnalyticsSummary` and `getAuctionLeaderboard` endpoints (admin‑only).
- Return JSON with the metrics outlined in section 2.

**Phase 3.B – Admin UI**
- Wire new API methods into:
  - `fretiko-admin/src/lib/api/analytics.ts` and/or `finance.ts`.
  - `dashboard/analytics` page (new “Auctions” section).

**Phase 3.C – Refinements**
- Add filters:
  - Date range.
  - Category.
  - Auction type (`timed` vs `live`).
- Add export (CSV) of auction analytics.

---

This plan keeps analytics implementation aligned with existing patterns while giving a clear roadmap for extending both backend and admin UI. No schema changes are required beyond `auction_reactions` (already added). 


