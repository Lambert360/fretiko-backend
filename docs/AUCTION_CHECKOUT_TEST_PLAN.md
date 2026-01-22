## Auction Checkout & Escrow – Comprehensive Test Plan

This document defines the end‑to‑end test scenarios for **auction checkout**, including:
‑ converting a win into an order,  
‑ creating escrow, and  
‑ marking wins as checked out.

It focuses on:
‑ `AuctionLiveViewerScreen` (mobile)  
‑ `LiveAuctionCartCheckoutScreen` (mobile)  
‑ `CheckoutScreen` (mobile)  
‑ `checkout.service.ts` (backend)  
‑ `auctions.service.ts` (backend)

---

### 1. Single Auction Win → Checkout → Escrow

**Pre‑conditions**
- Live auction is active.
- Test user A wins a single auction (status `pending_checkout` in `user_auction_wins`).

**Steps**
1. From `AuctionLiveViewerScreen`, win an item (highest bid when `bidding_ended`).
2. Open the mini cart (won items) and tap **Proceed to Checkout**.
3. On `LiveAuctionCartCheckoutScreen`:
   - Verify the won item details (title, winningBid, thumbnail).
   - Select **Self Pickup** OR a delivery rider.
4. Tap **Complete Purchase** → navigates to `CheckoutScreen` with:
   - `source: 'auction'`
   - `auctionCheckout: { auctionId }` populated.
5. On `CheckoutScreen`:
   - Confirm address and payment method (wallet).
   - Tap **Place Order**.

**Expected Results**
- `checkout.service.createOrder()` is called with `auctionCheckout` populated.
- Order is created with **source = auction** and linked to the correct `auction_id`.
- `process_wallet_transaction` debits buyer wallet for:
  - item price + delivery (if rider) (escrow balance).
- `escrowService.createEscrow(orderId, breakdown)` is called:
  - Escrow record exists and references the order and auction.
- `user_auction_wins.status` becomes `checked_out` and references `order_id`.
- Mobile UI shows **Order Placed Successfully** and allows navigating to Order Tracking.

---

### 2. Multiple Wins in Same Auction (Cart Flow)

**Pre‑conditions**
- Test user wins **2+** items in the same auction (multi‑item).

**Steps**
1. From `AuctionLiveViewerScreen`, ensure `wonItems.length > 1`.
2. Open mini cart and verify all items are listed.
3. Tap **Checkout All Items** → navigates to `LiveAuctionCartCheckoutScreen`.
4. Confirm UI info message about processing items one at a time.
5. Tap **Start Checkout** for the first item.
6. Complete the checkout as in Scenario 1.

**Expected Results**
- First win is checked out and marked `checked_out`.
- Remaining wins stay `pending_checkout`.
- No double charging or duplicate orders.
- User can later re‑open mini cart and checkout remaining wins.

---

### 3. Insufficient Wallet Balance – Auction Checkout

**Pre‑conditions**
- Test user has a wallet balance **less than** `winning_bid + delivery`.

**Steps**
1. Attempt to checkout a win as in Scenario 1.

**Expected Results (Mobile)**
- `LiveAuctionCartCheckoutScreen`:
  - Shows **Insufficient Balance** alert.
- `CheckoutScreen`:
  - Shows dialog with required additional funds and option to **Add Funds**.
- No order or escrow is created.
- `user_auction_wins.status` stays `pending_checkout`.

---

### 4. Escrow Creation Failure After Payment

**Goal**: Ensure critical error handling works if escrow creation fails after successful payment.

**Setup**
- Temporarily mock/force `escrowService.createEscrow` to throw an error (e.g. in a test environment).

**Steps**
1. Perform auction checkout as in Scenario 1.

**Expected Results (Backend)**
- `process_wallet_transaction` successfully debits buyer into escrow balance.
- `escrowService.createEscrow` throws.
- `checkout.service`:
  - Logs a **CRITICAL** error with context (orderId, userId, auctionId).
  - Throws an `HttpException` with:
    - Message: *"Payment processed successfully but escrow creation failed..."* (existing logic).
- No duplicate escrows or orders are created.
- Manual reconciliation path is documented in logs.

---

### 5. Concurrency – Two Users Attempting Last‑Second Checkout

**Pre‑conditions**
- Simulate/seed an auction win where:
  - **User A** is the true winner.
  - **User B** tries to tamper or reuse stale data (e.g. outdated `auctionCheckout`).

**Steps**
1. From two devices/sessions, attempt auction checkout against the same `user_auction_wins` row.

**Expected Results**
- Only the **winning user** (User A) can successfully checkout:
  - Backend validates ownership of `user_auction_wins` before marking `checked_out`.
- User B receives an error such as:
  - *"Auction win not found"* or *"You do not have permission to update this win"*.
- No duplicate orders or double debits occur.

---

### 6. Delivery Flow – Rider vs Self Pickup

**Steps**
1. Win an auction item.
2. Checkout with:
   - **Case A**: Self Pickup only.
   - **Case B**: Select rider with non‑zero delivery fee.

**Expected Results**
- **Case A**:
  - Order’s delivery method = pickup.
  - No delivery fee in wallet transaction breakdown.
- **Case B**:
  - Order’s delivery method references rider details.
  - Delivery fee is included in order total and escrow breakdown.

---

### 7. API‑Level Tests (Backend Only)

Use a tool like Postman or `test-orders.js` style scripts to:

1. **`POST /checkout/create-order`** with `source: 'auction'` and valid `auctionCheckout`.
2. **`POST /checkout/create-order`** with missing/invalid `auctionCheckout` for `source: 'auction'`.
3. **`POST /checkout/create-order`** where `auctionCheckout.auctionId` refers to:
   - Non‑existent auction.
   - Auction not won by the user.
   - Already checked‑out win.

**Expected Results**
- Clear, user‑safe error messages (no raw DB errors):
  - *"Auction not found or not active"*
  - *"You are not the winner of this auction"*
  - *"Auction win already checked out"*
- No side‑effects on wallets or escrow in error cases.

---

### 8. Logging & Monitoring Checks

For each scenario above, verify:
- Structured logs include:
  - `userId`, `auctionId`, `orderId`, `winId`, and error codes/messages.
- No PII or sensitive token data leaked.
- Errors from Supabase or RPCs are normalized before being surfaced to the client.

---

### 9. Regression Checklist (Post‑Changes)

After any change to:
- `checkout.service.ts`
- `auctions.service.ts`
- `user_auction_wins` schema

Re‑run:
- Scenarios **1, 3, 4** (happy path, insufficient funds, escrow failure).
- One multi‑win cart scenario (**2**).

This ensures the **auction → checkout → escrow** pipeline remains stable.


