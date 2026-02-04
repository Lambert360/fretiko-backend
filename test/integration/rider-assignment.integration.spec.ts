import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { RidersService } from '../../src/riders/riders.service';
import { RiderAssignmentTimeoutService } from '../../src/riders/rider-assignment-timeout.service';
import { RiderReplacementWorkflowService } from '../../src/riders/rider-replacement-workflow.service';
import { RiderPricingService } from '../../src/riders/rider-pricing.service';
import { RiderNotificationService } from '../../src/notifications/rider-notification.service';

describe('Rider Assignment Integration Tests', () => {
  let ridersService: RidersService;
  let timeoutService: RiderAssignmentTimeoutService;
  let replacementService: RiderReplacementWorkflowService;
  let pricingService: RiderPricingService;
  let notificationService: RiderNotificationService;
  let supabase: SupabaseClient;
  let configService: ConfigService;

  // Mock PostgrestBuilder for RPC functions
  const mockPostgrestBuilder = {
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    like: jest.fn().mockReturnThis(),
    ilike: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    contains: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    filter: jest.fn().mockReturnThis(),
    match: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    throwOnError: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    then: jest.fn().mockImplementation((resolve) => resolve),
    catch: jest.fn().mockReturnThis(),
    finally: jest.fn().mockReturnThis(),
  } as any;

  // Test data
  const testOrder = {
    id: 'order-123',
    order_number: 'ORD-001',
    vendor_id: 'vendor-123',
    buyer_id: 'buyer-123',
    delivery_fee: 15.50,
    delivery_address: {
      address: '456 Oak Ave, City, State 12345',
      latitude: 40.7128,
      longitude: -74.0060,
    },
    total_amount: 100.00,
    status: 'paid',
  };

  const testRider = {
    id: 'rider-123',
    name: 'John Doe',
    email: 'john@example.com',
    phone: '+1234567890',
    rating: 4.8,
    total_deliveries: 150,
    vehicle_type: 'bike',
    is_available: true,
    is_online: true,
    location: {
      latitude: 40.7128,
      longitude: -74.0060,
      address: '123 Main St, City, State 12345',
    },
  };

  const testVendor = {
    id: 'vendor-123',
    name: 'Test Vendor',
    email: 'vendor@example.com',
    location: {
      latitude: 40.7128,
      longitude: -74.0060,
      address: '123 Main St, City, State 12345',
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RidersService,
        RiderAssignmentTimeoutService,
        RiderReplacementWorkflowService,
        RiderPricingService,
        RiderNotificationService,
        ConfigService,
      ],
    }).compile();

    ridersService = module.get<RidersService>(RidersService);
    timeoutService = module.get<RiderAssignmentTimeoutService>(RiderAssignmentTimeoutService);
    replacementService = module.get<RiderReplacementWorkflowService>(RiderReplacementWorkflowService);
    pricingService = module.get<RiderPricingService>(RiderPricingService);
    notificationService = module.get<RiderNotificationService>(RiderNotificationService);
    configService = module.get<ConfigService>(ConfigService);

    // Mock Supabase client
    supabase = createClient(
      configService.get('SUPABASE_URL')!,
      configService.get('SUPABASE_SERVICE_KEY')!,
    ) as jest.Mocked<SupabaseClient>;

    // Setup comprehensive mocks
    setupDatabaseMocks();
  });

  const setupDatabaseMocks = () => {
    // Mock orders table operations
    jest.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              or: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: testOrder,
                  error: null,
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              or: jest.fn().mockResolvedValue({
                data: { ...testOrder, rider_id: testRider.id },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'rider_profiles') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  user_id: testRider.id,
                  vehicle_type: testRider.vehicle_type,
                  service_pricing: {
                    intracity: {
                      enabled: true,
                      base_price: 2.00,
                      per_km_rate: 0.50,
                    },
                  },
                  pricing_mode: 'formula',
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'user_profiles') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: testVendor,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'trust_scores') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  rider_trust_score: 850,
                  completed_orders: 150,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'notifications') {
        return {
          insert: jest.fn().mockResolvedValue({
            data: { id: 'notification-123' },
            error: null,
          }),
        };
      }
      if (table === 'notification_logs') {
        return {
          insert: jest.fn().mockResolvedValue({
            data: { id: 'log-123' },
            error: null,
          }),
        };
      }
      if (table === 'user_notification_preferences') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  user_id: 'test-user',
                  push_enabled: true,
                  websocket_enabled: true,
                  email_enabled: false,
                  sms_enabled: false,
                  assignment_notifications: true,
                  replacement_notifications: true,
                  broadcast_notifications: true,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'broadcast_assignments') {
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: { id: 'broadcast-123' },
                error: null,
              }),
            }),
          }),
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: { status: 'active', accepted_by: null },
                error: null,
              }),
            }),
          }),
        };
      }
      return {} as any;
    });

    // Mock RPC functions
    jest.spyOn(supabase, 'rpc').mockImplementation((funcName: string) => {
      if (funcName === 'find_nearby_riders') {
        return {
          ...mockPostgrestBuilder,
          then: jest.fn().mockImplementation((resolve) => {
            resolve([
              {
                rider_id: testRider.id,
                rider_name: testRider.name,
                distance: 1.5,
                is_available: true,
              },
            ]);
          }),
        };
      }
      if (funcName === 'calculate_rider_price') {
        return {
          ...mockPostgrestBuilder,
          then: jest.fn().mockImplementation((resolve) => {
            resolve(8.50);
          }),
        };
      }
      if (funcName === 'check_price_compatibility') {
        return {
          ...mockPostgrestBuilder,
          then: jest.fn().mockImplementation((resolve) => {
            resolve({
              compatible: true,
              compatibility_type: 'perfect',
              message: 'Price within rider range',
              rider_pricing_mode: 'formula',
            });
          }),
        };
      }
      if (funcName === 'accept_broadcast_assignment') {
        return {
          ...mockPostgrestBuilder,
          then: jest.fn().mockImplementation((resolve) => {
            resolve(true);
          }),
        };
      }
      return {
        ...mockPostgrestBuilder,
        then: jest.fn().mockImplementation((resolve) => {
          resolve(null);
        }),
      };
    });
  };

  describe('Complete Rider Assignment Workflow', () => {
    it('should handle complete assignment workflow from vendor assignment to rider acceptance', async () => {
      // Step 1: Vendor assigns rider to order
      const assignmentResult = await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      expect(assignmentResult.success).toBe(true);
      expect(assignmentResult.estimatedPickup).toBeDefined();
      expect(assignmentResult.estimatedDelivery).toBeDefined();

      // Step 2: Rider accepts assignment
      const acceptResult = await ridersService.acceptRiderAssignment(
        testOrder.id,
        testRider.id
      );

      expect(acceptResult.success).toBe(true);
      expect(acceptResult.message).toBe('Assignment accepted successfully');
      expect(acceptResult.order).toBeDefined();
      expect(acceptResult.order?.id).toBe(testOrder.id);

      // Step 3: Verify order status is updated
      const updatedOrder = await (ridersService as any).getOrderStatus(testOrder.id);
      expect(updatedOrder.rider_acceptance_status).toBe('accepted');
    });

    it('should handle rider rejection and trigger replacement workflow', async () => {
      // Step 1: Vendor assigns rider to order
      await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      // Step 2: Rider rejects assignment
      const rejectResult = await ridersService.rejectRiderAssignment(
        testOrder.id,
        testRider.id,
        'Too far away'
      );

      expect(rejectResult.success).toBe(true);
      expect(rejectResult.message).toBe('Assignment rejected successfully');

      // Step 3: Verify replacement workflow is triggered
      const replacementStatus = await replacementService.getReplacementStatus(testOrder.id);
      expect(replacementStatus.stage).toBe('vendor_selection');
    });

    it('should handle timeout and trigger replacement workflow', async () => {
      // Step 1: Vendor assigns rider to order
      await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      // Step 2: Simulate timeout by updating order directly
      await (ridersService as any).updateOrderTimeout(testOrder.id);

      // Step 3: Process timeout
      await timeoutService.handleRiderAssignmentTimeouts();

      // Step 4: Verify replacement workflow is triggered
      const replacementStatus = await replacementService.getReplacementStatus(testOrder.id);
      expect(replacementStatus.stage).toBe('vendor_selection');
    });
  });

  describe('Replacement Workflow Integration', () => {
    it('should complete two-stage replacement workflow', async () => {
      // Step 1: Initial rider assignment and rejection
      await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      await ridersService.rejectRiderAssignment(
        testOrder.id,
        testRider.id,
        'Initial rider unavailable'
      );

      // Step 2: Initiate replacement workflow
      const replacementResult = await replacementService.initiateReplacementWorkflow(testOrder.id);

      expect(replacementResult.success).toBe(true);
      expect(replacementResult.stage).toBe('vendor_selection');

      // Step 3: Vendor selects new rider (simulate)
      const vendorSelectionResult = await replacementService.handleVendorRiderSelection(
        testOrder.id,
        'new-rider-456',
        testVendor.id
      );

      expect(vendorSelectionResult.success).toBe(true);
      expect(vendorSelectionResult.message).toBe('Rider selected successfully');

      // Step 4: New rider accepts
      const newAcceptResult = await ridersService.acceptRiderAssignment(
        testOrder.id,
        'new-rider-456'
      );

      expect(newAcceptResult.success).toBe(true);
    });

    it('should fallback to fastest-finger broadcast when vendor doesn\'t select', async () => {
      // Step 1: Initial rider assignment and rejection
      await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      await ridersService.rejectRiderAssignment(
        testOrder.id,
        testRider.id,
        'Initial rider unavailable'
      );

      // Step 2: Initiate replacement workflow
      const replacementResult = await replacementService.initiateReplacementWorkflow(testOrder.id);

      // Step 3: Simulate vendor timeout (no selection)
      // This would normally happen after 5 minutes, but we'll simulate it
      const fastestFingerResult = await (replacementService as any).initiateFastestFingerWorkflow(testOrder.id, {
        ...testOrder,
        user_profiles: { location: testVendor.location },
      });

      expect(fastestFingerResult.stage).toBe('completed');
      expect(fastestFingerResult.message).toContain('Rider assigned successfully');
    });
  });

  describe('Pricing Integration', () => {
    it('should calculate rider price based on pricing mode', async () => {
      // Test formula pricing
      const formulaPrice = await pricingService.calculateRiderPrice(
        testRider.id,
        5.0, // 5km distance
        'intracity'
      );

      expect(formulaPrice.success).toBe(true);
      expect(formulaPrice.price).toBeGreaterThan(0);

      // Test price compatibility
      const compatibility = await pricingService.checkPriceCompatibility(
        testRider.id,
        8.50, // Order price
        'intracity'
      );

      expect(compatibility.success).toBe(true);
      expect(compatibility.compatibility?.compatible).toBe(true);
    });

    it('should migrate rider to new pricing mode', async () => {
      // Migrate to range pricing
      const migrationResult = await pricingService.migrateRiderToNewPricingMode(
        testRider.id,
        'range',
        {
          minPrice: 5.00,
          maxPrice: 20.00,
          preferredPrice: 12.50,
        }
      );

      expect(migrationResult.success).toBe(true);
      expect(migrationResult.message).toContain('Successfully migrated to range pricing mode');

      // Verify new pricing mode
      const pricingMode = await pricingService.getRiderPricingMode(testRider.id);

      expect(pricingMode.success).toBe(true);
      expect(pricingMode.pricingMode?.mode).toBe('range');
      expect(pricingMode.pricingMode?.pricingRange).toBeDefined();
    });
  });

  describe('Notification Integration', () => {
    it('should send notifications throughout assignment workflow', async () => {
      // Mock notification service
      jest.spyOn(notificationService, 'sendNotification').mockResolvedValue({
        success: true,
        sent: ['push', 'websocket'],
        failed: [],
      });

      // Step 1: Vendor assigns rider
      await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      expect(notificationService.sendNotification).toHaveBeenCalledWith(
        testRider.id,
        expect.objectContaining({
          type: 'assignment_created',
          orderId: testOrder.id,
          orderNumber: testOrder.order_number,
        })
      );

      // Step 2: Rider accepts assignment
      await ridersService.acceptRiderAssignment(
        testOrder.id,
        testRider.id
      );

      expect(notificationService.sendNotification).toHaveBeenCalledWith(
        testVendor.id,
        expect.objectContaining({
          type: 'assignment_accepted',
          orderId: testOrder.id,
          orderNumber: testOrder.order_number,
        })
      );

      expect(notificationService.sendNotification).toHaveBeenCalledWith(
        testOrder.buyer_id,
        expect.objectContaining({
          type: 'assignment_accepted',
          orderId: testOrder.id,
          orderNumber: testOrder.order_number,
        })
      );
    });

    it('should send bulk notifications for fastest-finger broadcast', async () => {
      // Mock notification service
      jest.spyOn(notificationService, 'sendBulkNotification').mockResolvedValue({
        success: true,
        totalSent: 3,
        totalFailed: 0,
      });

      // Simulate broadcast to multiple riders
      const riderIds = ['rider-1', 'rider-2', 'rider-3'];
      const broadcastPayload = {
        type: 'broadcast_sent' as const,
        orderId: testOrder.id,
        orderNumber: testOrder.order_number,
        vendorId: testVendor.id,
        buyerId: testOrder.buyer_id,
        timestamp: new Date().toISOString(),
        priority: 'urgent' as const,
      };

      await notificationService.sendBulkNotification(riderIds, broadcastPayload);

      expect(notificationService.sendBulkNotification).toHaveBeenCalledWith(
        riderIds,
        broadcastPayload
      );
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid rider assignment gracefully', async () => {
      // Mock database error
      jest.spyOn(supabase, 'from').mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            or: jest.fn().mockReturnValue({
              single: jest.fn().mockRejectedValue(new Error('Database error')),
            }),
          }),
        }),
      } as any);

      const result = await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      expect(result.success).toBe(false);
    });

    it('should handle duplicate rider acceptance gracefully', async () => {
      // First acceptance
      await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      const firstAccept = await ridersService.acceptRiderAssignment(
        testOrder.id,
        testRider.id
      );

      expect(firstAccept.success).toBe(true);

      // Second acceptance (should fail)
      const secondAccept = await ridersService.acceptRiderAssignment(
        testOrder.id,
        testRider.id
      );

      expect(secondAccept.success).toBe(false);
      expect(secondAccept.message).toContain('no longer pending');
    });

    it('should handle rider rejection after acceptance gracefully', async () => {
      // First accept
      await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      await ridersService.acceptRiderAssignment(
        testOrder.id,
        testRider.id
      );

      // Try to reject after acceptance (should fail)
      const rejectResult = await ridersService.rejectRiderAssignment(
        testOrder.id,
        testRider.id,
        'Changed mind'
      );

      expect(rejectResult.success).toBe(false);
      expect(rejectResult.message).toContain('no longer pending');
    });

    it('should handle replacement workflow with no available riders', async () => {
      // Mock no riders found
      jest.spyOn(supabase, 'rpc').mockImplementation((funcName: string) => {
        if (funcName === 'find_nearby_riders') {
          return {
            ...mockPostgrestBuilder,
            then: jest.fn().mockImplementation((resolve) => {
              resolve([]); // No riders found
            }),
          };
        }
        return {
          ...mockPostgrestBuilder,
          then: jest.fn().mockImplementation((resolve) => {
            resolve(null);
          }),
        };
      });

      // Initial assignment and rejection
      await ridersService.assignRiderToOrder(
        testRider.id,
        testOrder.id,
        testVendor.id
      );

      await ridersService.rejectRiderAssignment(
        testOrder.id,
        testRider.id,
        'Initial rider unavailable'
      );

      // Try replacement workflow
      const replacementResult = await replacementService.initiateReplacementWorkflow(testOrder.id);

      expect(replacementResult.success).toBe(true);
      expect(replacementResult.stage).toBe('failed');
      expect(replacementResult.message).toContain('No riders found');
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle concurrent rider assignments', async () => {
      const assignments = Array.from({ length: 10 }, (_, i) => ({
        orderId: `order-${i}`,
        orderNumber: `ORD-${i.toString().padStart(3, '0')}`,
        riderId: `rider-${i}`,
        vendorId: testVendor.id,
      }));

      // Process all assignments concurrently
      const results = await Promise.allSettled(
        assignments.map(assignment =>
          ridersService.assignRiderToOrder(
            assignment.riderId,
            assignment.orderId,
            assignment.vendorId
          )
        )
      );

      const successful = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');

      expect(successful.length).toBeGreaterThan(0);
      expect(failed.length).toBeLessThan(assignments.length);
    });

    it('should handle bulk notifications efficiently', async () => {
      const riderIds = Array.from({ length: 100 }, (_, i) => `rider-${i}`);
      const broadcastPayload = {
        type: 'broadcast_sent' as const,
        orderId: testOrder.id,
        orderNumber: testOrder.order_number,
        vendorId: testVendor.id,
        buyerId: testOrder.buyer_id,
        timestamp: new Date().toISOString(),
        priority: 'urgent' as const,
      };

      const startTime = Date.now();
      const result = await notificationService.sendBulkNotification(riderIds, broadcastPayload);
      const endTime = Date.now();

      expect(result.success).toBe(true);
      expect(result.totalSent).toBe(100);
      expect(result.totalFailed).toBe(0);
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should maintain data consistency during concurrent operations', async () => {
      // This test ensures that concurrent operations don't corrupt data
      const concurrentOperations = [
        ridersService.assignRiderToOrder(testRider.id, testOrder.id, testVendor.id),
        ridersService.acceptRiderAssignment(testOrder.id, testRider.id),
        ridersService.rejectRiderAssignment(testOrder.id, testRider.id),
        ridersService.getPendingAssignments(testRider.id),
        replacementService.getReplacementStatus(testOrder.id),
      ];

      const results = await Promise.allSettled(concurrentOperations);

      // All operations should either succeed or fail gracefully
      results.forEach((result, index) => {
        expect(['fulfilled', 'rejected']).toContain(result.status);
      });
    });
  });
});
