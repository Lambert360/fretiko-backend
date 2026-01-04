# Phase 7: Manual Testing Checklist
## Platform Commission and Wallet System - UI Testing

**Date**: _______________________  
**Tester**: _______________________  
**Environment**: _______________________ (Development/Staging/Production)

---

## Quick Reference

- **Platform User ID**: `00000000-0000-4000-8000-000000000002`
- **Admin Panel URL**: _______________________
- **Backend API URL**: _______________________

---

## Pre-Testing Setup

- [ ] Admin user is logged into admin panel
- [ ] Admin user has `view_revenue` permission
- [ ] Backend server is running
- [ ] Database connection is active
- [ ] Platform wallet has some balance (for withdrawal testing)

---

## Admin Panel UI Testing

### 1. Platform Wallet Tab Display

**Steps**:
1. Navigate to Finance page
2. Click "Platform Wallet" tab

**Expected Results**:
- [ ] Platform Wallet tab is visible and clickable
- [ ] Tab displays correctly when selected
- [ ] Wallet balance cards display:
  - [ ] Available Balance card (green)
  - [ ] Escrow Balance card (yellow)
  - [ ] Pending Withdrawal card (blue)
  - [ ] Total Balance card
- [ ] All amounts are formatted correctly (currency format)
- [ ] Amounts match backend data (verify via API if needed)

**Notes**: _________________________________

---

### 2. Bank Account List Display

**Steps**:
1. Navigate to Platform Wallet tab
2. Scroll to Bank Accounts section

**Expected Results**:
- [ ] Bank Accounts section is visible
- [ ] "Add Bank Account" button is visible and enabled
- [ ] If accounts exist:
  - [ ] List displays all platform bank accounts
  - [ ] Each account shows:
    - [ ] Account name
    - [ ] Bank name
    - [ ] Account number (partially masked if applicable)
    - [ ] Account type
    - [ ] Currency and Country
    - [ ] Default badge (if applicable)
    - [ ] Verified badge (if verified)
    - [ ] Edit button (pencil icon)
    - [ ] Delete button (trash icon)
- [ ] If no accounts exist:
  - [ ] Empty state message displays
  - [ ] "Add Bank Account" button in empty state works

**Notes**: _________________________________

---

### 3. Add Bank Account

**Steps**:
1. Click "Add Bank Account" button
2. Verify dialog/form opens
3. Fill in form fields:
   - Account Name: "Test Bank Account"
   - Bank Name: "Test Bank"
   - Account Number: "1234567890"
   - Bank Code: "TEST001"
   - Account Type: Select "checking"
   - Currency: "USD"
   - Country: "US"
   - Default: Check/uncheck
4. Click "Add Bank Account" button
5. Verify validation (try submitting empty form)

**Expected Results**:
- [ ] Dialog opens smoothly
- [ ] All form fields are visible and editable
- [ ] Form validation works (required fields)
- [ ] Account type dropdown works
- [ ] Currency field accepts input
- [ ] Country field accepts input
- [ ] Default checkbox works
- [ ] Submit button is enabled when form is valid
- [ ] Success notification appears after submission
- [ ] Dialog closes after success
- [ ] New account appears in list immediately
- [ ] Form validation prevents submission with empty required fields

**Notes**: _________________________________

---

### 4. Edit Bank Account

**Steps**:
1. Find an existing bank account (non-default)
2. Click Edit button (pencil icon)
3. Modify account name
4. Change account type
5. Toggle default checkbox
6. Submit form

**Expected Results**:
- [ ] Edit dialog opens with current account data pre-filled
- [ ] All fields are editable
- [ ] Changes can be made
- [ ] Submit button works
- [ ] Success notification appears
- [ ] Changes reflected in list immediately
- [ ] Dialog closes after success

**Notes**: _________________________________

---

### 5. Delete Bank Account

**Steps**:
1. Find a non-default bank account
2. Click Delete button (trash icon)
3. Verify confirmation dialog appears
4. Click "Cancel" - verify account still exists
5. Click Delete again
6. Click "Delete Bank Account" in confirmation dialog
7. Try to delete default account (should fail/be disabled)

**Expected Results**:
- [ ] Delete button is visible and clickable (for non-default accounts)
- [ ] Confirmation dialog appears with account details
- [ ] Cancel button works (dialog closes, account remains)
- [ ] Confirm deletion works
- [ ] Success notification appears
- [ ] Account removed from list immediately
- [ ] Default account cannot be deleted (button disabled or error message)

**Notes**: _________________________________

---

### 6. Withdraw Funds

**Steps**:
1. Check current platform wallet balance
2. Click "Withdraw Funds" button
3. Verify withdrawal dialog opens
4. Enter withdrawal amount (less than available balance)
5. Select bank account from dropdown
6. Verify only verified, active accounts appear in dropdown
7. Submit form
8. Try with amount > available balance (should fail)
9. Try without selecting bank account (should fail)

**Expected Results**:
- [ ] "Withdraw Funds" button is visible
- [ ] Button is enabled if balance > 0, disabled if balance = 0
- [ ] Withdrawal dialog opens smoothly
- [ ] Amount input field works
- [ ] Bank account dropdown shows only verified, active accounts
- [ ] Default account is marked in dropdown
- [ ] Submit button works with valid input
- [ ] Success notification appears
- [ ] Dialog closes after success
- [ ] Wallet balances update (may require refresh)
- [ ] Validation prevents withdrawal > available balance
- [ ] Validation prevents submission without bank account
- [ ] Error messages are clear and helpful

**Notes**: _________________________________

---

### 7. Error Handling & User Feedback

**Steps**:
1. Test network error scenarios (disconnect network temporarily)
2. Test with invalid data
3. Test edge cases

**Expected Results**:
- [ ] Error messages are displayed clearly
- [ ] Errors are user-friendly (not technical)
- [ ] Loading states are shown during API calls
- [ ] Buttons are disabled during operations
- [ ] No data corruption on errors
- [ ] User can retry failed operations

**Notes**: _________________________________

---

### 8. Responsive Design

**Steps**:
1. Test on different screen sizes (if applicable)
2. Test on mobile/tablet view
3. Test scrolling and layout

**Expected Results**:
- [ ] Layout works on different screen sizes
- [ ] All elements are accessible
- [ ] Forms are usable on mobile
- [ ] Tables/lists scroll properly

**Notes**: _________________________________

---

## API Testing (via Browser DevTools or Postman)

### 9. Get Platform Wallet (API)

**Endpoint**: `GET /admin/platform/wallet`

**Steps**:
1. Open browser DevTools → Network tab
2. Navigate to Platform Wallet tab in admin panel
3. Check the API request
4. Or use Postman/curl with admin JWT token

**Expected Results**:
- [ ] HTTP 200 OK
- [ ] Response contains `wallet` object
- [ ] Response contains `platformUserId`
- [ ] Wallet object has: `availableBalance`, `escrowBalance`, `pendingWithdrawal`
- [ ] `platformUserId` = `00000000-0000-4000-8000-000000000002`

**Notes**: _________________________________

---

### 10. List Bank Accounts (API)

**Endpoint**: `GET /admin/platform/bank-accounts`

**Steps**:
1. Monitor network request when loading bank accounts list

**Expected Results**:
- [ ] HTTP 200 OK
- [ ] Response is array of bank account objects
- [ ] Each account has required fields
- [ ] All accounts have `user_id` = platform user ID

**Notes**: _________________________________

---

### 11. Add Bank Account (API)

**Endpoint**: `POST /admin/platform/bank-accounts`

**Steps**:
1. Monitor network request when adding bank account
2. Verify request payload
3. Verify response

**Expected Results**:
- [ ] HTTP 201/200
- [ ] Request payload matches form data
- [ ] Response contains created bank account
- [ ] Account has correct `user_id`

**Notes**: _________________________________

---

## Commission Flow Verification (Manual)

### 12. End-to-End Commission Test

**Steps**:
1. Create a test order (product/service) with amount ₣100
2. Complete checkout
3. Check order in database: `platform_fee` should be ₣2.00 (2%)
4. Check escrow: `platform_amount` should be ₣2.00
5. Mark order as delivered
6. Release escrow
7. Check platform wallet balance increased by ₣2.00
8. Verify in admin panel Platform Wallet tab

**Expected Results**:
- [ ] Commission calculated correctly (2% for products/services)
- [ ] Escrow created with platform_amount
- [ ] Platform wallet credited after escrow release
- [ ] Balance updates visible in admin panel

**Notes**: _________________________________

---

## Test Summary

**Total Tests**: 12  
**Passed**: _____  
**Failed**: _____  
**Not Tested**: _____  

### Critical Issues Found

1. _________________________________
2. _________________________________
3. _________________________________

### Minor Issues/Improvements

1. _________________________________
2. _________________________________
3. _________________________________

### Recommendations

1. _________________________________
2. _________________________________
3. _________________________________

---

## Sign-off

**Tester Name**: _______________________  
**Date Completed**: _______________________  
**Approved for Production**: [ ] Yes [ ] No

**Notes**: _________________________________

---

**End of Manual Testing Checklist**

