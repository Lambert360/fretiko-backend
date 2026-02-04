import { Test, TestingModule } from '@nestjs/testing';
import { RiderNotificationService } from '../../src/notifications/rider-notification.service';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

describe('RiderNotificationService', () => {
  let service: RiderNotificationService;
  let configService: ConfigService;
  let supabase: SupabaseClient;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiderNotificationService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              switch (key) {
                case 'SUPABASE_URL':
                  return 'https://test.supabase.co';
                case 'SUPABASE_SERVICE_KEY':
                  return 'test-service-key';
                default:
                  return 'test-value';
              }
            }),
          },
        },
      ],
    }).compile();

    service = module.get<RiderNotificationService>(RiderNotificationService);
    configService = module.get<ConfigService>(ConfigService);
    
    // Mock Supabase client
    supabase = createClient(
      configService.get('SUPABASE_URL')!,
      configService.get('SUPABASE_SERVICE_KEY')!,
    ) as jest.Mocked<SupabaseClient>;
    
    // Mock all Supabase methods
    jest.spyOn(supabase, 'from').mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: null,
            error: null,
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: { id: 'test-id' },
            error: null,
          }),
        }),
      }),
    } as any);
  });

  describe('sendNotification', () => {
    it('should send notification successfully', async () => {
      const userId = 'test-user-id';
      const payload = {
        type: 'assignment_created' as const,
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        vendorId: 'vendor-123',
        buyerId: 'buyer-123',
        timestamp: new Date().toISOString(),
        priority: 'high' as const,
      };

      const result = await service.sendNotification(userId, payload);

      expect(result.success).toBe(true);
      expect(result.sent).toContain('push');
      expect(result.sent).toContain('websocket');
    });

    it('should handle notification failure gracefully', async () => {
      const userId = 'test-user-id';
      const payload = {
        type: 'assignment_created' as const,
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        vendorId: 'vendor-123',
        buyerId: 'buyer-123',
        timestamp: new Date().toISOString(),
      };

      // Mock Supabase error
      jest.spyOn(supabase, 'from').mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockRejectedValue(new Error('Database error')),
          }),
        }),
      } as any);

      const result = await service.sendNotification(userId, payload);

      expect(result.success).toBe(false);
      expect(result.failed).toContain('all');
    });
  });

  describe('sendBulkNotification', () => {
    it('should send bulk notifications successfully', async () => {
      const userIds = ['user-1', 'user-2', 'user-3'];
      const payload = {
        type: 'broadcast_sent' as const,
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        vendorId: 'vendor-123',
        buyerId: 'buyer-123',
        timestamp: new Date().toISOString(),
        priority: 'urgent' as const,
      };

      const result = await service.sendBulkNotification(userIds, payload);

      expect(result.success).toBe(true);
      expect(result.totalSent).toBeGreaterThan(0);
      expect(result.totalFailed).toBe(0);
    });

    it('should handle partial failures in bulk notifications', async () => {
      const userIds = ['user-1', 'user-2', 'user-3'];
      const payload = {
        type: 'broadcast_sent' as const,
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        vendorId: 'vendor-123',
        buyerId: 'buyer-123',
        timestamp: new Date().toISOString(),
      };

      // Mock partial failure
      jest.spyOn(service, 'sendNotification')
        .mockResolvedValueOnce({ success: true, sent: ['push'], failed: [] })
        .mockResolvedValueOnce({ success: false, sent: [], failed: ['push'] })
        .mockResolvedValueOnce({ success: true, sent: ['push'], failed: [] });

      const result = await service.sendBulkNotification(userIds, payload);

      expect(result.success).toBe(true);
      expect(result.totalSent).toBe(2);
      expect(result.totalFailed).toBe(1);
    });
  });

  describe('notifyRiderNewAssignment', () => {
    it('should notify rider of new assignment', async () => {
      const riderId = 'rider-123';
      const assignmentData = {
        id: 'order-123',
        orderNumber: 'ORD-001',
        deliveryFee: 15.50,
        pickupAddress: '123 Main St',
        deliveryAddress: '456 Oak Ave',
        estimatedEarnings: 12.50,
      };

      await expect(service.notifyRiderNewAssignment(riderId, assignmentData)).resolves.not.toThrow();
    });
  });

  describe('notifyRiderAssignmentAccepted', () => {
    it('should notify vendor and buyer of accepted assignment', async () => {
      const vendorId = 'vendor-123';
      const buyerId = 'buyer-123';
      const assignmentData = {
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        riderName: 'John Doe',
        estimatedPickup: '2025-01-30T15:00:00Z',
        estimatedDelivery: '2025-01-30T15:30:00Z',
      };

      await expect(service.notifyRiderAssignmentAccepted(vendorId, buyerId, assignmentData)).resolves.not.toThrow();
    });
  });

  describe('notifyRiderAssignmentRejected', () => {
    it('should notify vendor of rejected assignment', async () => {
      const vendorId = 'vendor-123';
      const rejectionData = {
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        reason: 'Too far away',
      };

      await expect(service.notifyRiderAssignmentRejected(vendorId, rejectionData)).resolves.not.toThrow();
    });
  });

  describe('notifyRiderAssignmentTimeout', () => {
    it('should notify vendor of assignment timeout', async () => {
      const vendorId = 'vendor-123';
      const timeoutData = {
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        replacementAttempts: 1,
      };

      await expect(service.notifyRiderAssignmentTimeout(vendorId, timeoutData)).resolves.not.toThrow();
    });
  });

  describe('notifyVendorReplacementNeeded', () => {
    it('should notify vendor of replacement needed', async () => {
      const vendorId = 'vendor-123';
      const replacementData = {
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        availableRiders: [
          { riderId: 'rider-1', riderName: 'John Doe', score: 95 },
          { riderId: 'rider-2', riderName: 'Jane Smith', score: 92 },
        ],
        deadline: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };

      await expect(service.notifyVendorReplacementNeeded(vendorId, replacementData)).resolves.not.toThrow();
    });
  });

  describe('notifyRiderBroadcastAssignment', () => {
    it('should notify rider of broadcast assignment', async () => {
      const riderId = 'rider-123';
      const broadcastData = {
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        deliveryFee: 15.50,
        pickupAddress: '123 Main St',
        deliveryAddress: '456 Oak Ave',
        broadcastId: 'broadcast-123',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        estimatedEarnings: 12.50,
        distance: 2.5,
        estimatedArrival: '15 min',
      };

      await expect(service.notifyRiderBroadcastAssignment(riderId, broadcastData)).resolves.not.toThrow();
    });
  });

  describe('notifyBroadcastAccepted', () => {
    it('should notify vendor and buyer of accepted broadcast', async () => {
      const vendorId = 'vendor-123';
      const buyerId = 'buyer-123';
      const acceptedData = {
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        riderName: 'John Doe',
        broadcastId: 'broadcast-123',
      };

      await expect(service.notifyBroadcastAccepted(vendorId, buyerId, acceptedData)).resolves.not.toThrow();
    });
  });

  describe('generateNotificationTemplate', () => {
    it('should generate correct template for assignment_created', () => {
      const payload = {
        type: 'assignment_created' as const,
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        vendorId: 'vendor-123',
        buyerId: 'buyer-123',
        timestamp: new Date().toISOString(),
        data: {
          deliveryFee: 15.50,
        },
      };

      const template = (service as any).generateNotificationTemplate(payload);

      expect(template.title).toBe('🚀 New Assignment Available');
      expect(template.body).toContain('ORD-001');
      expect(template.body).toContain('15.50');
      expect(template.actions).toHaveLength(2);
      expect(template.actions![0].title).toBe('View Details');
      expect(template.actions![1].title).toBe('Accept');
    });

    it('should generate correct template for assignment_accepted', () => {
      const payload = {
        type: 'assignment_accepted' as const,
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        vendorId: 'vendor-123',
        buyerId: 'buyer-123',
        timestamp: new Date().toISOString(),
        data: {
          riderName: 'John Doe',
        },
      };

      const template = (service as any).generateNotificationTemplate(payload);

      expect(template.title).toBe('✅ Assignment Accepted');
      expect(template.body).toContain('John Doe');
      expect(template.body).toContain('ORD-001');
      expect(template.actions).toHaveLength(1);
      expect(template.actions![0].title).toBe('Track Delivery');
    });

    it('should generate correct template for broadcast_sent', () => {
      const payload = {
        type: 'broadcast_sent' as const,
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        vendorId: 'vendor-123',
        buyerId: 'buyer-123',
        timestamp: new Date().toISOString(),
        data: {
          deliveryFee: 15.50,
        },
      };

      const template = (service as any).generateNotificationTemplate(payload);

      expect(template.title).toBe('🚀 Fast-Finger Assignment');
      expect(template.body).toContain('ORD-001');
      expect(template.body).toContain('15.50');
      expect(template.body).toContain('First to accept wins');
      expect(template.actions).toHaveLength(1);
      expect(template.actions![0].title).toBe('Accept Now');
    });
  });

  describe('queueNotification', () => {
    it('should queue notification for later processing', async () => {
      const userId = 'test-user-id';
      const payload = {
        type: 'assignment_created' as const,
        orderId: 'order-123',
        orderNumber: 'ORD-001',
        riderId: 'rider-123',
        vendorId: 'vendor-123',
        buyerId: 'buyer-123',
        timestamp: new Date().toISOString(),
      };

      await expect(service.queueNotification(userId, payload)).resolves.not.toThrow();
    });
  });

  describe('getNotificationStats', () => {
    it('should return notification statistics', async () => {
      // Mock database response
      jest.spyOn(supabase, 'from').mockReturnValue({
        select: jest.fn().mockReturnValue({
          gte: jest.fn().mockResolvedValue({
            data: [
              {
                id: '1',
                user_id: 'user-1',
                notification_type: 'assignment_created',
                sent_channels: ['push', 'websocket'],
                failed_channels: [],
                created_at: new Date().toISOString(),
              },
              {
                id: '2',
                user_id: 'user-2',
                notification_type: 'assignment_rejected',
                sent_channels: ['push'],
                failed_channels: ['websocket'],
                created_at: new Date().toISOString(),
              },
            ],
            error: null,
          }),
        }),
      } as any);

      const stats = await service.getNotificationStats('24h');

      expect(stats.totalSent).toBe(2);
      expect(stats.totalDelivered).toBe(2);
      expect(stats.totalFailed).toBe(1);
      expect(stats.deliveryRate).toBe(100);
      expect(stats.channelStats).toHaveLength(2);
      expect(stats.typeStats).toHaveLength(2);
    });

    it('should return empty stats when no data', async () => {
      // Mock empty database response
      jest.spyOn(supabase, 'from').mockReturnValue({
        select: jest.fn().mockReturnValue({
          gte: jest.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        }),
      } as any);

      const stats = await service.getNotificationStats('24h');

      expect(stats.totalSent).toBe(0);
      expect(stats.totalDelivered).toBe(0);
      expect(stats.totalFailed).toBe(0);
      expect(stats.deliveryRate).toBe(0);
      expect(stats.channelStats).toHaveLength(0);
      expect(stats.typeStats).toHaveLength(0);
    });
  });

  describe('getUserNotificationPreferences', () => {
    it('should return user preferences when found', async () => {
      // Mock database response
      jest.spyOn(supabase, 'from').mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: {
                user_id: 'user-1',
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
      } as any);

      const preferences = await (service as any).getUserNotificationPreferences('user-1');

      expect(preferences.push_enabled).toBe(true);
      expect(preferences.websocket_enabled).toBe(true);
      expect(preferences.email_enabled).toBe(false);
      expect(preferences.sms_enabled).toBe(false);
    });

    it('should return default preferences when not found', async () => {
      // Mock database error
      jest.spyOn(supabase, 'from').mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: null,
              error: { message: 'Not found' },
            }),
          }),
        }),
      } as any);

      const preferences = await (service as any).getUserNotificationPreferences('user-1');

      expect(preferences.push_enabled).toBe(true);
      expect(preferences.websocket_enabled).toBe(true);
      expect(preferences.email_enabled).toBe(false);
      expect(preferences.sms_enabled).toBe(false);
    });
  });

  describe('getActiveChannels', () => {
    it('should return enabled channels sorted by priority', () => {
      const requestedChannels = [
        { type: 'push' as const, enabled: true, priority: 1 },
        { type: 'email' as const, enabled: true, priority: 3 },
      ];

      const userPreferences = {
        push_enabled: true,
        websocket_enabled: true,
        email_enabled: true,
        sms_enabled: false,
      };

      const activeChannels = (service as any).getActiveChannels(requestedChannels, userPreferences);

      expect(activeChannels).toHaveLength(2);
      expect(activeChannels[0].type).toBe('push');
      expect(activeChannels[1].type).toBe('email');
    });

    it('should filter out disabled channels', () => {
      const requestedChannels = [
        { type: 'push' as const, enabled: true, priority: 1 },
        { type: 'email' as const, enabled: true, priority: 3 },
      ];

      const userPreferences = {
        push_enabled: true,
        websocket_enabled: false,
        email_enabled: false,
        sms_enabled: false,
      };

      const activeChannels = (service as any).getActiveChannels(requestedChannels, userPreferences);

      expect(activeChannels).toHaveLength(1);
      expect(activeChannels[0].type).toBe('push');
    });
  });

  describe('getTimeFilter', () => {
    it('should return correct time filter for 1h', () => {
      const filter = (service as any).getTimeFilter('1h');
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      
      expect(new Date(filter)).toBeInstanceOf(Date);
      expect(new Date(filter).getTime()).toBeCloseTo(oneHourAgo.getTime(), 1000);
    });

    it('should return correct time filter for 24h', () => {
      const filter = (service as any).getTimeFilter('24h');
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      
      expect(new Date(filter)).toBeInstanceOf(Date);
      expect(new Date(filter).getTime()).toBeCloseTo(oneDayAgo.getTime(), 1000);
    });

    it('should return correct time filter for 7d', () => {
      const filter = (service as any).getTimeFilter('7d');
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      expect(new Date(filter)).toBeInstanceOf(Date);
      expect(new Date(filter).getTime()).toBeCloseTo(sevenDaysAgo.getTime(), 1000);
    });

    it('should return correct time filter for 30d', () => {
      const filter = (service as any).getTimeFilter('30d');
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      expect(new Date(filter)).toBeInstanceOf(Date);
      expect(new Date(filter).getTime()).toBeCloseTo(thirtyDaysAgo.getTime(), 1000);
    });

    it('should return default time filter for invalid range', () => {
      const filter = (service as any).getTimeFilter('invalid');
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      
      expect(new Date(filter)).toBeInstanceOf(Date);
      expect(new Date(filter).getTime()).toBeCloseTo(oneDayAgo.getTime(), 1000);
    });
  });
});
