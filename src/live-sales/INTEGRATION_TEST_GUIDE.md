# Live Sales Integration Test Guide

This guide explains how to run integration tests for the live sales purchase flow.

## Prerequisites

1. **Test Database Setup**
   - Create a separate test database or use a test schema
   - Run migrations: `npm run migration:test`
   - Seed test data (streams, products, users, wallets)

2. **Environment Variables**
   - Set up `.env.test` with test database credentials
   - Configure test Supabase instance

## Test Scenarios

### 1. Atomic Stock Update Tests

**Test: Successful Purchase with Atomic Stock Update**
```typescript
// Setup: Product with stock: 5
// Action: Purchase quantity: 2
// Verify:
//   - Stock updated to 3 atomically
//   - Order created
//   - Escrow created
//   - Wallet transaction processed
```

**Test: Race Condition Prevention**
```typescript
// Setup: Product with stock: 1
// Action: 2 concurrent purchase requests (quantity: 1 each)
// Verify:
//   - Only 1 purchase succeeds
//   - Stock is 0
//   - SELECT FOR UPDATE prevented race condition
```

**Test: Insufficient Stock**
```typescript
// Setup: Product with stock: 0
// Action: Purchase quantity: 1
// Verify:
//   - BadRequestException thrown
//   - Stock remains 0
//   - No order created
```

### 2. Transaction Rollback Tests

**Test: Escrow Creation Failure Rollback**
```typescript
// Setup: Product with stock, user with wallet balance
// Action: Purchase (mock escrow creation to fail)
// Verify:
//   - Wallet transaction refunded
//   - Order status: cancelled
//   - Stock restored
//   - Error logged
```

**Test: Rollback Failure Handling**
```typescript
// Setup: Product, user wallet
// Action: Purchase (escrow fails, rollback also fails)
// Verify:
//   - Appropriate error thrown
//   - Error logged for manual intervention
//   - System state logged
```

### 3. Duplicate Purchase Prevention Tests

**Test: Duplicate Purchase Blocked**
```typescript
// Setup: Product with stock
// Action: Purchase, then immediately purchase again (same params)
// Verify:
//   - Second purchase rejected
//   - Only 1 order created
//   - Idempotency check works
```

**Test: Purchase After Window**
```typescript
// Setup: Product with stock
// Action: Purchase, wait 11 seconds, purchase again
// Verify:
//   - Both purchases succeed
//   - 2 orders created
```

### 4. Error Recovery Tests

**Test: Order Creation Failure Recovery**
```typescript
// Setup: Product with stock: 10
// Action: Purchase (mock order creation to fail)
// Verify:
//   - Stock restored to 10
//   - Wallet refunded
//   - Specific error message returned
```

**Test: Error Message Specificity**
```typescript
// Test different error scenarios:
//   - Unique constraint violation → "Order number already exists"
//   - Foreign key violation → "Invalid reference data"
//   - Check constraint violation → "Order data violates constraints"
```

### 5. Stock Reservation Tests

**Test: Reservation Creation**
```typescript
// Setup: Product with stock: 10
// Action: Reserve quantity: 2
// Verify:
//   - Available stock: 8
//   - Reservation record created
//   - Expires in 5 minutes
```

**Test: Reservation Expiration**
```typescript
// Setup: Reservation with expires_at in past
// Action: Run cleanup function
// Verify:
//   - Reservation marked as expired
//   - Available stock restored
```

**Test: Duplicate Reservation Prevention**
```typescript
// Setup: Active reservation for user/product
// Action: Attempt to create duplicate reservation
// Verify:
//   - Error or existing reservation returned
//   - Unique constraint enforced
```

## Running Tests

### Unit Tests (Mocked Dependencies)
```bash
npm run test live-sales.service.spec.ts
```

### Integration Tests (Real Database)
```bash
# Set up test environment
export NODE_ENV=test
export DATABASE_URL=postgresql://test:test@localhost:5432/test_db

# Run integration tests
npm run test:integration live-sales.integration.spec.ts
```

### E2E Tests (Full Stack)
```bash
npm run test:e2e live-sales.e2e.spec.ts
```

## Test Data Setup

Create a test data seeder:

```typescript
// test/seeders/live-sales.seeder.ts
export async function seedLiveSalesTestData() {
  // Create test users (buyer, vendor)
  // Create test products
  // Create test live stream
  // Create test live stream products
  // Create test wallets with balances
}
```

## Assertions

Key assertions to verify:

1. **Database State**
   - Stock levels are correct
   - Orders are created with correct data
   - Escrows are created
   - Wallet transactions are recorded

2. **Business Logic**
   - Atomic operations prevent race conditions
   - Rollbacks restore correct state
   - Duplicate prevention works
   - Error recovery functions correctly

3. **Performance**
   - Operations complete within acceptable time
   - Metrics are tracked correctly
   - Logs are structured and searchable

## Continuous Integration

Add to CI/CD pipeline:

```yaml
# .github/workflows/test.yml
- name: Run Integration Tests
  run: |
    npm run test:integration
    npm run test:coverage
```

## Notes

- Use transactions for test isolation
- Clean up test data after each test
- Use factories for test data generation
- Mock external services (notifications, etc.)
- Test both success and failure paths

