# Admin Notifications Integration Guide

This guide shows how to trigger admin notifications in your services.

## Prerequisites

1. Import the service and types:
```typescript
import { AdminNotificationsService, AdminNotificationType } from '../admin/admin-notifications.service';
```

2. Inject the service in your constructor:
```typescript
constructor(
  // ... other services
  private adminNotificationsService: AdminNotificationsService,
) {}
```

## Notification Methods

### 1. Notify Specific Staff Member
```typescript
await this.adminNotificationsService.notifyStaff(
  staffId,
  AdminNotificationType.NEW_ORDER,
  'New Order Received',
  `Order #${orderNumber} for ${formatCurrency(totalAmount)}`,
  { orderId, orderNumber, totalAmount },
  `/dashboard/orders?id=${orderId}`
);
```

### 2. Notify All Super Admins
```typescript
await this.adminNotificationsService.notifySuperAdmins(
  AdminNotificationType.DISPUTE_ESCALATED,
  'Dispute Escalated',
  `Dispute #${disputeId} requires immediate attention`,
  { disputeId, orderId, reason },
  `/dashboard/disputes?id=${disputeId}`
);
```

### 3. Notify Department
```typescript
await this.adminNotificationsService.notifyDepartment(
  'logistics', // department slug
  AdminNotificationType.NEW_ORDER,
  'New Order for Delivery',
  `Order #${orderNumber} needs rider assignment`,
  { orderId, orderNumber },
  `/dashboard/logistics/assign?order=${orderId}`
);
```

### 4. Notify All Department Heads
```typescript
await this.adminNotificationsService.notifyDepartmentHeads(
  AdminNotificationType.SYSTEM_ALERT,
  'System Maintenance Scheduled',
  'Platform maintenance scheduled for tomorrow at 2 AM UTC',
  { scheduledTime: '2024-01-15T02:00:00Z' },
  '/dashboard'
);
```

### 5. Broadcast to All Staff
```typescript
await this.adminNotificationsService.broadcastToAll(
  AdminNotificationType.SYSTEM_ALERT,
  'Emergency: System Update',
  'Critical security patch deployed. Please refresh your browser.',
  {},
  '/dashboard'
);
```

## Available Notification Types

```typescript
AdminNotificationType.NEW_ORDER           // New order created
AdminNotificationType.DISPUTE_OPENED      // New dispute filed
AdminNotificationType.DISPUTE_ESCALATED   // Dispute escalated
AdminNotificationType.REPORT_SUBMITTED    // Content report submitted
AdminNotificationType.PAYOUT_REQUESTED    // Payout request created
AdminNotificationType.USER_SUSPENDED      // User account suspended
AdminNotificationType.HIGH_VALUE_TRANSACTION // High-value transaction detected
AdminNotificationType.ESCROW_STUCK        // Escrow processing issue
AdminNotificationType.SYSTEM_ALERT        // System-wide alert
AdminNotificationType.CONTENT_FLAGGED     // Content flagged for review
AdminNotificationType.RIDER_ISSUE         // Rider-related issue
AdminNotificationType.VENDOR_VERIFICATION // Vendor verification needed
AdminNotificationType.PAYMENT_FAILED      // Payment processing failed
```

## Department Slugs

- `admin_moderators` - Admin & Moderators
- `finance` - Finance Department
- `logistics` - Logistics Department
- `customer_care` - Customer Care
- `marketing` - Marketing Department
- `hr` - Human Resources

## Integration Examples

### Example 1: Order Service - New Order
```typescript
async createOrder(orderData: CreateOrderDto) {
  // ... create order logic
  
  // Notify logistics department
  await this.adminNotificationsService.notifyDepartment(
    'logistics',
    AdminNotificationType.NEW_ORDER,
    'New Order Received',
    `Order #${order.order_number} - ${order.items.length} items`,
    { 
      orderId: order.id, 
      orderNumber: order.order_number,
      totalAmount: order.total_amount,
      deliveryAddress: order.delivery_address
    },
    `/dashboard/orders?id=${order.id}`
  );
  
  // If high value, also notify finance
  if (order.total_amount > 10000) {
    await this.adminNotificationsService.notifyDepartment(
      'finance',
      AdminNotificationType.HIGH_VALUE_TRANSACTION,
      'High Value Order Detected',
      `Order #${order.order_number} - ${formatCurrency(order.total_amount)}`,
      { orderId: order.id, amount: order.total_amount },
      `/dashboard/orders?id=${order.id}`
    );
  }
  
  return order;
}
```

### Example 2: Disputes Service - New Dispute
```typescript
async createDispute(disputeData: CreateDisputeDto) {
  // ... create dispute logic
  
  // Notify super admins
  await this.adminNotificationsService.notifySuperAdmins(
    AdminNotificationType.DISPUTE_OPENED,
    'New Dispute Filed',
    `Dispute filed for order #${order.order_number}`,
    { 
      disputeId: dispute.id,
      orderId: order.id,
      reason: dispute.reason,
      buyerId: dispute.buyer_id,
      vendorId: order.vendor_id
    },
    `/dashboard/disputes?id=${dispute.id}`
  );
  
  return dispute;
}
```

### Example 3: Content Moderation - Flagged Content
```typescript
async flagContent(contentId: string, reason: string) {
  // ... flag content logic
  
  // Notify admin/moderators department
  await this.adminNotificationsService.notifyDepartment(
    'admin_moderators',
    AdminNotificationType.CONTENT_FLAGGED,
    'Content Flagged for Review',
    `${contentType} flagged: ${reason}`,
    { 
      contentId,
      contentType,
      reason,
      reportedBy: userId
    },
    `/dashboard/content/reported?id=${contentId}`
  );
}
```

### Example 4: Payments - Failed Payment
```typescript
async processPayment(paymentData: PaymentDto) {
  try {
    // ... payment processing
  } catch (error) {
    // Notify finance department of failed payment
    await this.adminNotificationsService.notifyDepartment(
      'finance',
      AdminNotificationType.PAYMENT_FAILED,
      'Payment Processing Failed',
      `Payment of ${formatCurrency(amount)} failed: ${error.message}`,
      { 
        orderId,
        amount,
        error: error.message,
        userId
      },
      `/dashboard/finance?order=${orderId}`
    );
    
    throw error;
  }
}
```

## Best Practices

1. **Use Appropriate Types**: Choose the most specific notification type for your event
2. **Provide Context**: Include relevant IDs and data in the data object
3. **Add Deep Links**: Always provide a link to the relevant page
4. **Target Correctly**: Notify only the relevant staff/departments
5. **Handle Errors**: Wrap notification calls in try-catch if they're non-critical
6. **Avoid Spam**: Don't send notifications for every minor event
7. **Be Concise**: Keep titles short and messages clear

## Error Handling

Notifications are non-critical by design. Wrap them in try-catch to prevent failures from disrupting core business logic:

```typescript
try {
  await this.adminNotificationsService.notifySuperAdmins(
    AdminNotificationType.NEW_ORDER,
    'New Order',
    'Order created',
    { orderId },
    '/dashboard/orders'
  );
} catch (error) {
  this.logger.warn('Failed to send admin notification:', error);
  // Continue with business logic
}
```

