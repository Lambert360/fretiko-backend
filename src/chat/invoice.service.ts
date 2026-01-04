import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { createUserSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import { CreateInvoiceDto, UpdateInvoiceDto, InvoiceResponseDto, InvoiceItemResponseDto } from './dto/invoice.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EscrowService } from '../escrow/escrow.service';

@Injectable()
export class InvoiceService {
  private supabase: SupabaseClient;

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => RealtimeGateway))
    private realtimeGateway: RealtimeGateway,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
  ) {
    this.supabase = createServiceSupabaseClient(configService);
  }

  /**
   * Create a new invoice with items
   */
  async createInvoice(userId: string, createInvoiceDto: CreateInvoiceDto, userToken?: string): Promise<InvoiceResponseDto> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user is seller or rider
      const { data: userProfile } = await client
        .from('user_profiles')
        .select('is_seller, is_rider')
        .eq('id', userId)
        .single();

      if (!userProfile || (!userProfile.is_seller && !userProfile.is_rider)) {
        throw new ForbiddenException('Only vendors and riders can create invoices');
      }

      // Verify user is participant in the conversation
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', createInvoiceDto.conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new ForbiddenException('You are not a participant in this conversation');
      }

      // Determine buyer ID if not provided
      // The "buyer" is simply the other person in the conversation (regardless of their role)
      let buyerId = createInvoiceDto.buyerId;

      if (!buyerId) {
        // Find the other participant in the conversation (not the invoice creator)
        const { data: participants, error: participantsError } = await client
          .from('chat_participants')
          .select('user_id')
          .eq('conversation_id', createInvoiceDto.conversationId)
          .neq('user_id', userId);

        if (participantsError || !participants || participants.length === 0) {
          throw new BadRequestException('Could not identify the other person in this conversation');
        }

        // For one-on-one conversations, use the other participant
        // For group conversations, this would need additional logic (not implemented yet)
        if (participants.length > 1) {
          throw new BadRequestException('Invoices in group conversations must specify a buyer ID');
        }

        buyerId = participants[0].user_id;
        console.log(`✅ Auto-determined buyer (other participant): ${buyerId} for invoice creator: ${userId}`);
      }

      // Calculate total amount
      const totalAmount = createInvoiceDto.items.reduce((sum, item) => {
        return sum + (item.price * item.quantity);
      }, 0);

      // Create invoice message first
      const { data: message, error: messageError } = await client
        .from('chat_messages')
        .insert({
          conversation_id: createInvoiceDto.conversationId,
          sender_id: userId,
          message_type: 'invoice',
          content: `Invoice for ${createInvoiceDto.items.length} item(s) - ₣${totalAmount.toFixed(2)}`,
        })
        .select()
        .single();

      if (messageError) throw messageError;

      // Create invoice
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours from now

      const { data: invoice, error: invoiceError } = await client
        .from('chat_invoices')
        .insert({
          conversation_id: createInvoiceDto.conversationId,
          message_id: message.id,
          vendor_id: userId,
          buyer_id: buyerId,
          total_amount: totalAmount,
          status: 'pending',
          expires_at: expiresAt.toISOString(),
        })
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // Create invoice items
      // Note: total_price is a generated column, so we don't insert it
      const invoiceItems = createInvoiceDto.items.map(item => ({
        invoice_id: invoice.id,
        item_type: item.itemType,
        name: item.name,
        description: item.description,
        price: item.price,
        quantity: item.quantity,
        image_url: item.imageUrl,
        appointment_date: item.appointmentDate,
        appointment_time: item.appointmentTime,
        product_id: item.productId,
        service_id: item.serviceId,
      }));

      const { data: items, error: itemsError } = await client
        .from('chat_invoice_items')
        .insert(invoiceItems)
        .select();

      if (itemsError) throw itemsError;

      // Broadcast invoice creation via WebSocket
      await this.realtimeGateway.notifyInvoiceCreated(
        createInvoiceDto.conversationId,
        this.mapToInvoiceResponse(invoice, items),
        userId,
      );

      return this.mapToInvoiceResponse(invoice, items);
    } catch (error) {
      console.error('Error creating invoice:', error);
      throw new BadRequestException(error.message || 'Failed to create invoice');
    }
  }

  /**
   * Get invoice details by ID
   */
  async getInvoiceById(userId: string, invoiceId: string, userToken?: string): Promise<InvoiceResponseDto> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: invoice, error: invoiceError } = await client
        .from('chat_invoices')
        .select('*')
        .eq('id', invoiceId)
        .single();

      if (invoiceError || !invoice) {
        throw new NotFoundException('Invoice not found');
      }

      // Verify user is vendor or buyer
      if (invoice.vendor_id !== userId && invoice.buyer_id !== userId) {
        throw new ForbiddenException('You do not have access to this invoice');
      }

      // Get invoice items
      const { data: items, error: itemsError } = await client
        .from('chat_invoice_items')
        .select('*')
        .eq('invoice_id', invoiceId);

      if (itemsError) throw itemsError;

      return this.mapToInvoiceResponse(invoice, items || []);
    } catch (error) {
      console.error('Error getting invoice:', error);
      throw error;
    }
  }

  /**
   * Update invoice (vendor only, pending invoices only)
   */
  async updateInvoice(
    userId: string,
    invoiceId: string,
    updateInvoiceDto: UpdateInvoiceDto,
    userToken?: string,
  ): Promise<InvoiceResponseDto> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get existing invoice
      const { data: invoice, error: invoiceError } = await client
        .from('chat_invoices')
        .select('*')
        .eq('id', invoiceId)
        .single();

      if (invoiceError || !invoice) {
        throw new NotFoundException('Invoice not found');
      }

      // Verify user is the vendor
      if (invoice.vendor_id !== userId) {
        throw new ForbiddenException('Only the vendor can update this invoice');
      }

      // Verify invoice is pending and not expired
      if (invoice.status !== 'pending') {
        throw new BadRequestException('Only pending invoices can be updated');
      }

      if (new Date(invoice.expires_at) < new Date()) {
        throw new BadRequestException('Cannot update expired invoice');
      }

      // If updating items, delete old items and create new ones
      if (updateInvoiceDto.items && updateInvoiceDto.items.length > 0) {
        // Delete old items
        await client.from('chat_invoice_items').delete().eq('invoice_id', invoiceId);

        // Calculate new total
        const totalAmount = updateInvoiceDto.items.reduce((sum, item) => {
          return sum + (item.price * item.quantity);
        }, 0);

        // Update invoice total
        const { error: updateError } = await client
          .from('chat_invoices')
          .update({ total_amount: totalAmount })
          .eq('id', invoiceId);

        if (updateError) throw updateError;

        // Create new items
        // Note: total_price is a generated column, so we don't insert it
        const invoiceItems = updateInvoiceDto.items.map(item => ({
          invoice_id: invoiceId,
          item_type: item.itemType,
          name: item.name,
          description: item.description,
          price: item.price,
          quantity: item.quantity,
          image_url: item.imageUrl,
          appointment_date: item.appointmentDate,
          appointment_time: item.appointmentTime,
          product_id: item.productId,
          service_id: item.serviceId,
        }));

        const { data: newItems, error: itemsError } = await client
          .from('chat_invoice_items')
          .insert(invoiceItems)
          .select();

        if (itemsError) throw itemsError;

        // Get updated invoice
        const { data: updatedInvoice } = await client
          .from('chat_invoices')
          .select('*')
          .eq('id', invoiceId)
          .single();

        // Broadcast update
        await this.realtimeGateway.notifyInvoiceUpdated(
          invoice.conversation_id,
          this.mapToInvoiceResponse(updatedInvoice, newItems),
          userId,
        );

        return this.mapToInvoiceResponse(updatedInvoice, newItems);
      }

      // If only updating status
      if (updateInvoiceDto.status) {
        const { error: updateError } = await client
          .from('chat_invoices')
          .update({ status: updateInvoiceDto.status })
          .eq('id', invoiceId);

        if (updateError) throw updateError;
      }

      return await this.getInvoiceById(userId, invoiceId, userToken);
    } catch (error) {
      console.error('Error updating invoice:', error);
      throw error;
    }
  }

  /**
   * Cancel invoice (vendor only)
   */
  async cancelInvoice(userId: string, invoiceId: string, userToken?: string): Promise<{ success: boolean }> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: invoice, error: invoiceError } = await client
        .from('chat_invoices')
        .select('*')
        .eq('id', invoiceId)
        .single();

      if (invoiceError || !invoice) {
        throw new NotFoundException('Invoice not found');
      }

      if (invoice.vendor_id !== userId) {
        throw new ForbiddenException('Only the vendor can cancel this invoice');
      }

      if (invoice.status !== 'pending') {
        throw new BadRequestException('Only pending invoices can be cancelled');
      }

      const { error: updateError } = await client
        .from('chat_invoices')
        .update({ status: 'cancelled' })
        .eq('id', invoiceId);

      if (updateError) throw updateError;

      // Broadcast cancellation
      await this.realtimeGateway.notifyInvoiceCancelled(invoice.conversation_id, invoiceId, userId);

      return { success: true };
    } catch (error) {
      console.error('Error cancelling invoice:', error);
      throw error;
    }
  }

  /**
   * Create order from invoice (buyer action)
   */
  async createOrderFromInvoice(userId: string, invoiceId: string, userToken?: string): Promise<{ orderId: string }> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get invoice with items
      const invoice = await this.getInvoiceById(userId, invoiceId, userToken);

      // Verify user is the buyer
      if (invoice.buyerId !== userId) {
        throw new ForbiddenException('Only the buyer can create an order from this invoice');
      }

      // Verify invoice is pending and not expired
      if (invoice.status !== 'pending') {
        throw new BadRequestException('Invoice is not in pending status');
      }

      if (new Date(invoice.expiresAt) < new Date()) {
        throw new BadRequestException('Invoice has expired');
      }

      // Check if order already exists
      if (invoice.orderId) {
        return { orderId: invoice.orderId };
      }

      // Generate order number
      const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;

      // Create order
      const { data: order, error: orderError } = await client
        .from('orders')
        .insert({
          order_number: orderNumber,
          buyer_id: userId,
          vendor_id: invoice.vendorId,
          total_amount: invoice.totalAmount,
          delivery_fee: 0,
          platform_fee: invoice.totalAmount * 0.02, // 2% platform commission
          status: 'created',
          escrow_enabled: true,
          source: 'invoice',
          metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
        })
        .select()
        .single();

      if (orderError) throw orderError;

      // Create order items
      const orderItems = invoice.items.map(item => ({
        order_id: order.id,
        product_name: item.name,
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.price,
        total_price: item.totalPrice,
        product_metadata: {
          description: item.description,
          imageUrl: item.imageUrl,
          appointmentDate: item.appointmentDate,
          appointmentTime: item.appointmentTime,
          itemType: item.itemType,
        },
      }));

      const { error: itemsError } = await client.from('order_items').insert(orderItems);

      if (itemsError) throw itemsError;

      // Link order to invoice
      const { error: updateError } = await client
        .from('chat_invoices')
        .update({ order_id: order.id })
        .eq('id', invoiceId);

      if (updateError) throw updateError;

      // Note: Escrow will be created when payment is processed
      // For now, order is created with escrow_enabled: true
      // Payment processing should call escrowService.createEscrow() after payment

      return { orderId: order.id };
    } catch (error) {
      console.error('Error creating order from invoice:', error);
      throw error;
    }
  }

  /**
   * Mark invoice as paid (called when order is delivered)
   */
  async markInvoiceAsPaid(invoiceId: string, orderId: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('chat_invoices')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          order_id: orderId,
        })
        .eq('id', invoiceId);

      if (error) throw error;

      // Get invoice details for broadcasting
      const { data: invoice } = await this.supabase
        .from('chat_invoices')
        .select('conversation_id, id')
        .eq('id', invoiceId)
        .single();

      if (invoice) {
        await this.realtimeGateway.notifyInvoicePaid(invoice.conversation_id, invoiceId);
      }
    } catch (error) {
      console.error('Error marking invoice as paid:', error);
    }
  }

  /**
   * Expire pending invoices (cron job)
   */
  async expireInvoices(): Promise<{ expired: number }> {
    try {
      const { data, error } = await this.supabase
        .from('chat_invoices')
        .update({ status: 'expired' })
        .eq('status', 'pending')
        .lt('expires_at', new Date().toISOString())
        .select('id, conversation_id');

      if (error) throw error;

      // Broadcast expiration for each invoice
      if (data && data.length > 0) {
        for (const invoice of data) {
          await this.realtimeGateway.notifyInvoiceExpired(invoice.conversation_id, invoice.id);
        }
      }

      return { expired: data?.length || 0 };
    } catch (error) {
      console.error('Error expiring invoices:', error);
      return { expired: 0 };
    }
  }

  /**
   * Helper: Map database records to response DTO
   */
  private mapToInvoiceResponse(invoice: any, items: any[]): InvoiceResponseDto {
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoice_number,
      conversationId: invoice.conversation_id,
      messageId: invoice.message_id,
      vendorId: invoice.vendor_id,
      buyerId: invoice.buyer_id,
      totalAmount: parseFloat(invoice.total_amount),
      status: invoice.status,
      expiresAt: invoice.expires_at,
      paidAt: invoice.paid_at,
      orderId: invoice.order_id,
      items: items.map(item => ({
        id: item.id,
        invoiceId: item.invoice_id,
        itemType: item.item_type,
        name: item.name,
        description: item.description,
        price: parseFloat(item.price),
        quantity: item.quantity,
        totalPrice: parseFloat(item.total_price),
        imageUrl: item.image_url,
        appointmentDate: item.appointment_date,
        appointmentTime: item.appointment_time,
        productId: item.product_id,
        serviceId: item.service_id,
        createdAt: item.created_at,
      })),
      createdAt: invoice.created_at,
      updatedAt: invoice.updated_at,
    };
  }
}
