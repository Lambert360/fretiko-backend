# Fretiko Backend — Working Notes

## Security invariants

These invariants exist because of how data access is wired. Do not assume
otherwise when writing or reviewing code.

### RLS is not a safety net — every service method must self-authorize

`createUserSupabaseClient()` in `src/shared/supabase.client.ts` builds a
**service-role** client (it accepts an access token but does not use it). All
Supabase access therefore bypasses Row Level Security. Authorization is
enforced exclusively in NestJS code:

- Controllers/gateways must verify the caller's identity via `JwtAuthGuard`
  (REST) or the JWT handshake (`Socket.IO`) — never trust `user_id` fields
  sent in request bodies or socket message payloads.
- Services must verify resource ownership before mutating (e.g.
  `auction.seller_id === user.sub`).

If you add an endpoint or socket handler and forget an ownership check, it is
fully open. There is no database-level fallback.

### Socket.IO authentication pattern

The auction gateway verifies the JWT once in `handleConnection` and stores the
principal on `client.user`/`connection.userId`. Anonymous sockets may connect
(for public viewing) but have no identity. Handlers that act on behalf of a
user (`place_bid`, `auctioneer_event`, `play_sound`, `stop_sound`) use
`@UseGuards(JwtAuthGuard)` and read `client.user.sub`. Follow this pattern for
new handlers.

### Anti-sniping / soft close

`auctions.last_extended_at` is the dedup column for soft-close extensions.
Bids bump `auctions.updated_at` on every insert — never use `updated_at` to
decide whether an extension already ran.

### Bid fraud metadata

`auction_bids.ip_address` / `user_agent` are populated server-side from the
HTTP request / socket handshake (never from client payloads). If the app is
deployed behind a load balancer, set `trust proxy` on the Express instance in
`main.ts` or `req.ip`/`handshake.address` will record the LB's address and
same-IP fraud detection will be useless. Only enable it when a proxy is
actually in front — otherwise clients can spoof `X-Forwarded-For`.

### Live auction finalization

`endLiveAuction` must resolve every `active`/`countdown` item through the
`mark_item_sold_atomic` RPC before closing the auction, otherwise winning
bidders get no `auction_sales`/`user_auction_wins` rows and cannot check out.

## Verify

- Typecheck: `npx tsc --noEmit`
- Migrations deploy before the backend code that depends on them (new columns
  such as `auctions.last_extended_at`, `auction_bids.ip_address`).
