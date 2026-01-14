/**
 * Event DTOs for admin notifications
 * Used for event-based notification system to avoid circular dependencies
 */

export enum AdminNotificationEventType {
  DISPUTE_ESCALATED = 'admin.dispute.escalated',
  CONTENT_REPORT_CREATED = 'admin.content.report.created',
  MEMO_SENT = 'admin.memo.sent',
  ORDER_CREATED = 'admin.order.created',
  PAYOUT_REQUESTED = 'admin.payout.requested',
  USER_SUSPENDED = 'admin.user.suspended',
  ESCROW_STUCK = 'admin.escrow.stuck',
  PAYMENT_FAILED = 'admin.payment.failed',
}

export interface AdminNotificationEvent {
  type: AdminNotificationEventType;
  data: any;
  timestamp: string;
}

// Specific event data interfaces
export interface DisputeEscalatedEvent {
  disputeId: string;
  escalatedBy: string;
  departmentId?: string;
  reportCreated: boolean;
  reportNumber?: string;
}

export interface ContentReportCreatedEvent {
  reportId: string;
  category: string;
  reportType: string;
  reporterId: string;
}

export interface MemoSentEvent {
  memoId: string;
  senderId: string;
  senderName: string;
  recipientType: string;
  recipientId?: string;
  priority: string;
}

export interface OrderCreatedEvent {
  orderId: string;
  userId: string;
  totalAmount: number;
  itemsCount: number;
}

export interface PayoutRequestedEvent {
  payoutId: string;
  vendorId: string;
  amount: number;
  currency: string;
}

export interface UserSuspendedEvent {
  userId: string;
  reason: string;
  suspendedBy: string;
}

export interface EscrowStuckEvent {
  escrowId: string;
  orderId: string;
  amount: number;
  stuckForDays: number;
}

export interface PaymentFailedEvent {
  paymentId: string;
  userId: string;
  amount: number;
  reason: string;
}
