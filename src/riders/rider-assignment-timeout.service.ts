import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { RidersService } from '../riders/riders.service';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RiderReplacementWorkflowService } from './rider-replacement-workflow.service';

@Injectable()
export class RiderAssignmentTimeoutService {
  private readonly logger = new Logger(RiderAssignmentTimeoutService.name);
  private supabase: SupabaseClient;

  constructor(
    private configService: ConfigService,
    private ridersService: RidersService,
    private notificationHelper: NotificationHelperService,
    private replacementService: RiderReplacementWorkflowService,
  ) {
    this.supabase = createClient(
      this.configService.get<string>('SUPABASE_URL')!,
      this.configService.get<string>('SUPABASE_SERVICE_KEY')!,
    );
  }

  // Run every minute to check for timeouts
  @Cron(CronExpression.EVERY_MINUTE)
  async handleRiderAssignmentTimeouts() {
    try {
      console.log('⏰ Checking for rider assignment timeouts...');
      
      // Find all pending assignments that have passed their deadline
      const { data: timeoutAssignments, error } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          rider_id,
          rider_assignment_deadline,
          vendor_id,
          buyer_id,
          replacement_attempts
        `)
        .eq('rider_acceptance_status', 'pending')
        .lt('rider_assignment_deadline', new Date().toISOString())
        .order('rider_assignment_deadline', { ascending: true });

      if (error) {
        console.error('❌ Error fetching timeout assignments:', error);
        return;
      }

      if (!timeoutAssignments || timeoutAssignments.length === 0) {
        console.log('✅ No timeout assignments found');
        return;
      }

      console.log(`⏰ Found ${timeoutAssignments.length} timeout assignments`);

      // Process each timeout assignment
      for (const assignment of timeoutAssignments) {
        await this.processTimeoutAssignment(assignment);
      }

    } catch (error) {
      console.error('❌ Error in timeout monitoring:', error);
    }
  }

  private async processTimeoutAssignment(assignment: any) {
    try {
      console.log(`⏰ Processing timeout for order ${assignment.order_number}`);

      // Update order status to timeout
      const { error: updateError } = await this.supabase
        .from('orders')
        .update({
          rider_acceptance_status: 'timeout',
          rider_id: null, // Remove rider from order
          replacement_attempts: (assignment.replacement_attempts || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', assignment.id);

      if (updateError) {
        console.error(`❌ Error updating timeout status for order ${assignment.order_number}:`, updateError);
        return;
      }

      // Notify vendor and buyer about timeout
      try {
        await this.notificationHelper.notifySystemUpdate(assignment.vendor_id, 'Rider Assignment Timeout', `Rider assignment timeout for order ${assignment.order_number}`, {
          orderId: assignment.id,
          orderNumber: assignment.order_number,
          riderId: assignment.rider_id,
          replacementAttempts: (assignment.replacement_attempts || 0) + 1,
        });

        console.log(`✅ Notifications sent for timeout assignment ${assignment.order_number}`);
      } catch (notifyError) {
        console.error('Failed to send timeout notifications (non-critical):', notifyError);
      }

      // Trigger replacement workflow
      try {
        await this.replacementService.initiateReplacementWorkflow(assignment.id);
        console.log(`🔄 Replacement workflow triggered for timeout assignment ${assignment.order_number}`);
      } catch (replacementError) {
        console.error('Failed to trigger replacement workflow:', replacementError);
      }

      console.log(`✅ Processed timeout for order ${assignment.order_number}`);

    } catch (error) {
      console.error(`❌ Error processing timeout for order ${assignment.order_number}:`, error);
    }
  }

  // Manual method to check specific order timeout
  async checkOrderTimeout(orderId: string): Promise<{
    isTimeout: boolean;
    message: string;
  }> {
    try {
      const { data: order, error } = await this.supabase
        .from('orders')
        .select('rider_acceptance_status, rider_assignment_deadline')
        .eq('id', orderId)
        .single();

      if (error || !order) {
        return { isTimeout: false, message: 'Order not found' };
      }

      if (order.rider_acceptance_status !== 'pending') {
        return { isTimeout: false, message: 'Assignment not pending' };
      }

      const deadline = new Date(order.rider_assignment_deadline);
      const now = new Date();

      if (deadline < now) {
        // Process the timeout
        await this.handleRiderAssignmentTimeouts();
        return { isTimeout: true, message: 'Assignment timeout processed' };
      }

      const timeRemaining = Math.floor((deadline.getTime() - now.getTime()) / 1000);
      return { 
        isTimeout: false, 
        message: `Assignment active, ${timeRemaining} seconds remaining` 
      };

    } catch (error) {
      console.error('❌ Error checking order timeout:', error);
      return { isTimeout: false, message: 'Error checking timeout' };
    }
  }

  // Get statistics about timeouts
  async getTimeoutStats(): Promise<{
    totalPending: number;
    totalTimeouts: number;
    avgReplacementAttempts: number;
  }> {
    try {
      const { data: pendingAssignments } = await this.supabase
        .from('orders')
        .select('replacement_attempts')
        .eq('rider_acceptance_status', 'pending');

      const { data: timeoutAssignments } = await this.supabase
        .from('orders')
        .select('replacement_attempts')
        .eq('rider_acceptance_status', 'timeout');

      const totalPending = pendingAssignments?.length || 0;
      const totalTimeouts = timeoutAssignments?.length || 0;

      // Calculate average replacement attempts
      const allAttempts = [
        ...(pendingAssignments || []),
        ...(timeoutAssignments || [])
      ];
      
      const avgReplacementAttempts = allAttempts.length > 0
        ? allAttempts.reduce((sum, order) => sum + (order.replacement_attempts || 0), 0) / allAttempts.length
        : 0;

      return {
        totalPending,
        totalTimeouts,
        avgReplacementAttempts: Math.round(avgReplacementAttempts * 100) / 100,
      };

    } catch (error) {
      console.error('❌ Error getting timeout stats:', error);
      return {
        totalPending: 0,
        totalTimeouts: 0,
        avgReplacementAttempts: 0,
      };
    }
  }
}
