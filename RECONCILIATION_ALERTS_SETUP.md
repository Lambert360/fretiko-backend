# Reconciliation Alerts System

## Overview

The Reconciliation Alerts system tracks when fallback exchange rates are used instead of Flutterwave's actual rates during deposit processing. This helps finance administrators identify and reconcile potential discrepancies in currency conversions.

## What Gets Tracked

When a deposit webhook is processed and a fallback exchange rate is used (instead of Flutterwave's actual rate), a reconciliation alert is automatically created with:

- **Deposit Information**: Deposit ID, user ID, local amount, local currency
- **Exchange Rate Details**: Fallback rate used, estimated FRETI amount, actual FRETI amount (if available later)
- **Discrepancy Calculation**: Amount difference and percentage difference between estimated and actual
- **Alert Severity**: Automatically calculated based on discrepancy amount:
  - **Low**: < 1 FRETI
  - **Medium**: 1-10 FRETI
  - **High**: 10-100 FRETI
  - **Critical**: > 100 FRETI
- **Alert Reason**: Why the fallback was used (e.g., "Flutterwave verification failed", "No transaction ID")
- **Status**: `pending`, `reviewed`, `resolved`, or `dismissed`

## Database Schema

The `reconciliation_alerts` table stores all alerts with full audit trail and resolution tracking.

## API Endpoints

### Get Reconciliation Alerts
```
GET /admin/finance/reconciliation-alerts
```

**Query Parameters:**
- `status`: Filter by status (`pending`, `reviewed`, `resolved`, `dismissed`)
- `severity`: Filter by severity (`low`, `medium`, `high`, `critical`)
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 20)
- `startDate`: Filter alerts created after this date
- `endDate`: Filter alerts created before this date

**Response:**
```json
{
  "alerts": [
    {
      "id": "uuid",
      "depositId": "uuid",
      "userId": "uuid",
      "userName": "username",
      "localAmount": 16000,
      "localCurrency": "NGN",
      "fallbackRateUsed": 1500,
      "estimatedFretiAmount": 10.67,
      "actualFretiAmount": 11.03,
      "actualRate": 1450,
      "amountDiscrepancy": 0.36,
      "discrepancyPercentage": 3.26,
      "alertSeverity": "low",
      "alertReason": "Flutterwave verification failed",
      "status": "pending",
      "createdAt": "2025-12-08T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 5,
    "totalPages": 1
  },
  "summary": {
    "total": 5,
    "pending": 3,
    "reviewed": 1,
    "resolved": 1,
    "bySeverity": {
      "low": 2,
      "medium": 2,
      "high": 1,
      "critical": 0
    }
  }
}
```

### Update Alert Status
```
POST /admin/finance/reconciliation-alerts/:id/status?status=resolved&notes=Verified with Flutterwave
```

**Query Parameters:**
- `status`: New status (`reviewed`, `resolved`, `dismissed`)
- `notes`: Optional resolution notes

**Response:**
```json
{
  "id": "uuid",
  "status": "resolved",
  "resolvedBy": "staff-uuid",
  "resolvedAt": "2025-12-08T11:00:00Z",
  "resolutionNotes": "Verified with Flutterwave",
  "updatedAt": "2025-12-08T11:00:00Z"
}
```

## When Alerts Are Created

Reconciliation alerts are automatically created in the following scenarios:

1. **Verification Response Missing `amount_settled`**: When Flutterwave's verification API doesn't return `amount_settled` and webhook data also doesn't have it
2. **Verification Failed**: When the Flutterwave verification API call fails (network error, API error, etc.)
3. **No Transaction ID**: When the webhook doesn't contain a transaction ID to verify with

## Automatic Updates

If a reconciliation alert was created with an estimated amount, and later the actual Flutterwave data becomes available (e.g., through manual verification), the alert is automatically updated with:
- Actual FRETI amount
- Actual exchange rate
- Recalculated discrepancy
- Updated severity based on actual discrepancy

## Permissions

All endpoints require:
- Staff authentication (`StaffJwtAuthGuard`)
- `view_revenue` permission

## Migration

Run the migration to create the table:
```bash
# The migration file is located at:
supabase-migrations/120_create_reconciliation_alerts.sql
```

## Files Created/Modified

### New Files:
- `src/wallet/reconciliation.service.ts` - Service for creating and updating reconciliation alerts
- `supabase-migrations/120_create_reconciliation_alerts.sql` - Database migration

### Modified Files:
- `src/wallet/wallet.module.ts` - Added ReconciliationService
- `src/wallet/wallet.service.ts` - Added alert creation when fallback rates are used
- `src/admin/admin.service.ts` - Added methods to fetch and update reconciliation alerts
- `src/admin/finance.controller.ts` - Added endpoints for reconciliation alerts

## Usage in Admin Panel

Finance administrators can:
1. View all reconciliation alerts in the Finance section
2. Filter by status, severity, and date range
3. Review each alert to see the discrepancy details
4. Mark alerts as reviewed, resolved, or dismissed
5. Add resolution notes for audit trail

## Best Practices

1. **Regular Review**: Review pending alerts daily to identify patterns
2. **Investigation**: For high/critical severity alerts, verify with Flutterwave dashboard
3. **Resolution**: Mark alerts as resolved only after verifying the actual conversion
4. **Documentation**: Add resolution notes explaining how the discrepancy was handled
5. **Monitoring**: Track alert frequency to identify systemic issues with Flutterwave integration

