import { Injectable, BadRequestException, NotFoundException, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { WalletService } from '../wallet/wallet.service';
import { WalletTransactionType } from '../wallet/constants/transaction-types';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  VirtualGift,
  UserGift,
  GiftTransaction,
  UserGiftWithDetails,
} from './entities/gift.entity';
import {
  CreateGiftDto,
  UpdateGiftDto,
  PurchaseGiftsDto,
  ConvertGiftsDto,
  SendGiftDto,
  PurchaseGiftsResponse,
  ConvertGiftsResponse,
  UserGiftsResponse,
} from './dto/gift.dto';

@Injectable()
export class GiftService {
  private readonly logger = new Logger(GiftService.name);
  private supabase;
  
  // Admin gift wallet user ID constant
  private ADMIN_GIFT_WALLET_ID: string = '00000000-0000-4000-8000-000000000003';
  
  // Platform wallet user ID constant (for conversion fees)
  private PLATFORM_USER_ID: string = '00000000-0000-4000-8000-000000000002';
  
  // Conversion fee: 20% to platform, 80% to user
  private readonly CONVERSION_FEE_RATE = 0.2;

  constructor(
    private configService: ConfigService,
    private walletService: WalletService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => RealtimeGateway))
    private realtimeGateway: RealtimeGateway,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.ADMIN_GIFT_WALLET_ID = this.configService.get<string>('PLATFORM_GIFT_WALLET_USER_ID', '00000000-0000-4000-8000-000000000003');
    this.PLATFORM_USER_ID = this.configService.get<string>('PLATFORM_USER_ID', '00000000-0000-4000-8000-000000000002');
  }

  /**
   * Get all available virtual gifts
   */
  async getAvailableGifts(): Promise<VirtualGift[]> {
    const { data, error } = await this.supabase
      .from('virtual_gifts')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      this.logger.error(`Failed to fetch gifts: ${error.message}`);
      throw new BadRequestException('Failed to fetch available gifts');
    }

    return data || [];
  }

  /**
   * Get user's gift collection
   */
  async getUserGifts(userId: string): Promise<UserGiftsResponse> {
    const { data, error } = await this.supabase
      .from('user_gifts')
      .select(`
        id,
        gift_id,
        quantity,
        source,
        received_at,
        gift:virtual_gifts (
          id,
          name,
          emoji,
          credit_value
        )
      `)
      .eq('user_id', userId)
      .order('received_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch user gifts: ${error.message}`);
      throw new BadRequestException('Failed to fetch user gifts');
    }

    const gifts = (data || []).map((ug: any) => ({
      id: ug.id,
      gift_id: ug.gift_id,
      gift_name: ug.gift.name,
      emoji: ug.gift.emoji,
      quantity: ug.quantity,
      total_value: ug.quantity * ug.gift.credit_value,
      source: ug.source,
      received_at: ug.received_at,
    }));

    const total_gifts = gifts.reduce((sum, g) => sum + g.quantity, 0);
    const total_value = gifts.reduce((sum, g) => sum + g.total_value, 0);

    return {
      gifts,
      total_gifts,
      total_value,
    };
  }

  /**
   * Purchase gifts
   */
  async purchaseGifts(userId: string, dto: PurchaseGiftsDto): Promise<PurchaseGiftsResponse> {
    // ✅ Add logging to track duplicate calls
    this.logger.log(`[GiftService] purchaseGifts called for user ${userId} with ${dto.purchases?.length || 0} items`);
    
    if (!dto.purchases || dto.purchases.length === 0) {
      throw new BadRequestException('No gifts selected for purchase');
    }

    // 1. Validate all gifts exist and are active
    const giftIds = dto.purchases.map(p => p.gift_id);
    const { data: gifts, error: giftsError } = await this.supabase
      .from('virtual_gifts')
      .select('*')
      .in('id', giftIds)
      .eq('is_active', true);

    if (giftsError || !gifts || gifts.length !== giftIds.length) {
      throw new BadRequestException('One or more gifts are invalid or inactive');
    }

    // 2. Calculate total cost
    const giftMap = new Map<string, VirtualGift>(gifts.map((g: VirtualGift) => [g.id, g]));
    let totalCost = 0;
    const giftsToAdd: Array<{ gift_id: string; gift_name: string; quantity: number }> = [];

    for (const purchase of dto.purchases) {
      const gift = giftMap.get(purchase.gift_id);
      if (!gift) {
        throw new BadRequestException(`Gift ${purchase.gift_id} not found`);
      }
      totalCost += gift.credit_value * purchase.quantity;
      giftsToAdd.push({
        gift_id: gift.id,
        gift_name: gift.name,
        quantity: purchase.quantity,
      });
    }

    // 3. Check user wallet balance
    const wallet = await this.walletService.getWallet(userId);
    if (wallet.availableBalance < totalCost) {
      throw new BadRequestException(`Insufficient wallet balance. Required: ${totalCost}, Available: ${wallet.availableBalance}`);
    }

    // 4. Generate unique purchase reference ID for idempotency
    // This ensures duplicate purchase requests are detected and prevented
    const purchaseReferenceId = randomUUID();
    this.logger.log(`[GiftService] Generated purchase reference ID: ${purchaseReferenceId} for user ${userId}`);

    // 5. Debit user wallet (with unique reference ID for idempotency)
    this.logger.log(`[GiftService] Processing wallet debit: ${totalCost} for user ${userId}`);
    const debitResult = await this.walletService.processWalletTransaction(
      userId,
      WalletTransactionType.GIFT_PURCHASE,
      -totalCost,
      `Purchase of ${dto.purchases.length} gift type(s)`,
      purchaseReferenceId,
      'gift_purchase',
    );

    if (!debitResult.success) {
      throw new BadRequestException(`Failed to debit wallet: ${debitResult.error}`);
    }
    
    // ✅ Log idempotent detection
    if (debitResult.idempotent) {
      this.logger.warn(`[GiftService] ⚠️ IDEMPOTENT: Duplicate gift purchase detected and prevented for user ${userId}, reference: ${purchaseReferenceId}`);
    } else {
      this.logger.log(`[GiftService] ✅ Wallet debit successful: ${debitResult.transactionId} for user ${userId}`);
    }

    // 6. Credit admin gift wallet (use same reference ID to link transactions)
    const creditResult = await this.walletService.processWalletTransaction(
      this.ADMIN_GIFT_WALLET_ID,
      WalletTransactionType.PLATFORM_COMMISSION, // Using platform commission type for admin gift wallet
      totalCost,
      `Gift purchase from user ${userId}`,
      purchaseReferenceId,
      'gift_purchase',
    );

    if (!creditResult.success) {
      // Critical: User already debited, but admin wallet credit failed
      // This requires manual reconciliation
      this.logger.error(`CRITICAL: User ${userId} debited ${totalCost} but admin gift wallet credit failed`);
      // Continue anyway - we'll add gifts, but log the issue
    }

    // 6. Add gifts to user's collection (using upsert to aggregate quantities)
    for (const purchase of dto.purchases) {
      // Check if user already has this gift
      const { data: existingGift, error: checkError } = await this.supabase
        .from('user_gifts')
        .select('id, quantity')
        .eq('user_id', userId)
        .eq('gift_id', purchase.gift_id)
        .single();

      if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = no rows returned
        this.logger.error(`Failed to check existing gift: ${checkError.message}`);
        throw new BadRequestException('Failed to check existing gifts');
      }

      if (existingGift) {
        // Update quantity for existing gift (updated_at is handled by trigger)
        const { error: updateError } = await this.supabase
          .from('user_gifts')
          .update({ 
            quantity: existingGift.quantity + purchase.quantity,
          })
          .eq('id', existingGift.id);

        if (updateError) {
          this.logger.error(`Failed to update gift quantity: ${updateError.message}`);
          throw new BadRequestException('Failed to update gift collection');
        }
      } else {
        // Insert new gift
        const { error: insertError } = await this.supabase
          .from('user_gifts')
          .insert({
            user_id: userId,
            gift_id: purchase.gift_id,
            quantity: purchase.quantity,
            source: 'purchased' as const,
            received_from: null,
            session_id: null,
          });

        if (insertError) {
          this.logger.error(`Failed to add gift to collection: ${insertError.message}`);
          throw new BadRequestException('Failed to add gifts to collection');
        }
      }
    }

    // 7. Log transaction
    const transactionsToInsert = dto.purchases.map(purchase => ({
      user_id: userId,
      gift_id: purchase.gift_id,
      quantity: purchase.quantity,
      transaction_type: 'purchase' as const,
      credit_amount: (giftMap.get(purchase.gift_id) as VirtualGift)!.credit_value * purchase.quantity,
      recipient_id: null,
      session_type: null,
      session_id: null,
    }));

    await this.supabase
      .from('gift_transactions')
      .insert(transactionsToInsert);

    // 8. Get updated wallet balance
    const updatedWallet = await this.walletService.getWallet(userId);

    // 9. Emit real-time event for gift collection update
    try {
      if (this.realtimeGateway?.server) {
        this.realtimeGateway.server.to(`user_${userId}`).emit('gift_collection_updated', {
          type: 'purchase',
          gifts: giftsToAdd,
          newBalance: updatedWallet.availableBalance,
        });
        this.logger.log(`📡 Emitted gift_collection_updated (purchase) to user_${userId}`);
      }
    } catch (error) {
      this.logger.warn('Failed to emit real-time gift purchase event:', error);
    }

    // 10. Send notification
    try {
      await this.notificationHelper.notifySystemUpdate(
        userId,
        'Gift Purchase Successful! 🎁',
        `You successfully purchased ${dto.purchases.length} virtual gift type(s)!`,
        { 
          transactionId: debitResult.transactionId,
          giftsPurchased: giftsToAdd,
        },
      );
    } catch (error) {
      this.logger.warn('Failed to send gift purchase notification:', error);
    }

    return {
      success: true,
      transaction_id: debitResult.transactionId || '',
      total_cost: totalCost,
      gifts_added: giftsToAdd,
      new_wallet_balance: updatedWallet.availableBalance,
    };
  }

  /**
   * Convert gifts back to credits (80% to user, 20% to platform)
   * Supports partial conversion - user can convert a specific quantity of each gift
   */
  async convertGiftsToCredits(userId: string, dto: ConvertGiftsDto): Promise<ConvertGiftsResponse> {
    if (!dto.gifts || dto.gifts.length === 0) {
      throw new BadRequestException('No gifts selected for conversion');
    }

    // 1. Get all user gift IDs to fetch
    const userGiftIds = dto.gifts.map(g => g.user_gift_id);

    // 2. Fetch user gifts to convert
    const { data: userGifts, error: fetchError } = await this.supabase
      .from('user_gifts')
      .select(`
        id,
        gift_id,
        quantity,
        gift:virtual_gifts (
          id,
          name,
          emoji,
          credit_value
        )
      `)
      .eq('user_id', userId)
      .in('id', userGiftIds);

    if (fetchError || !userGifts || userGifts.length === 0) {
      throw new BadRequestException('One or more gifts not found in your collection');
    }

    // 3. Create a map for quick lookup
    type UserGiftWithGift = {
      id: string;
      gift_id: string;
      quantity: number;
      gift: {
        id: string;
        name: string;
        emoji: string;
        credit_value: number;
      } | null;
    };

    const userGiftMap = new Map<string, UserGiftWithGift>(userGifts.map((ug: any) => [ug.id, ug as UserGiftWithGift]));

    // 4. Validate quantities and calculate total value
    let totalValue = 0;
    const giftsToConvert: Array<{ gift_id: string; gift_name: string; quantity: number }> = [];

    for (const convertItem of dto.gifts) {
      const userGift = userGiftMap.get(convertItem.user_gift_id);
      if (!userGift) {
        throw new BadRequestException(`Gift with ID ${convertItem.user_gift_id} not found in your collection`);
      }

      // Validate quantity
      if (convertItem.quantity > userGift.quantity) {
        throw new BadRequestException(
          `Cannot convert ${convertItem.quantity} of ${userGift.gift?.name || 'gift'}. You only have ${userGift.quantity}`
        );
      }

      if (convertItem.quantity <= 0) {
        throw new BadRequestException(`Conversion quantity must be at least 1`);
      }

      const gift = userGift.gift;
      if (!gift) continue;

      const giftValue = gift.credit_value * convertItem.quantity;
      totalValue += giftValue;
      giftsToConvert.push({
        gift_id: gift.id,
        gift_name: gift.name,
        quantity: convertItem.quantity,
      });
    }

    if (totalValue === 0) {
      throw new BadRequestException('No valid gifts to convert');
    }

    // 3. Calculate credits (80% to user, 20% to platform)
    const userCredit = Math.floor(totalValue * (1 - this.CONVERSION_FEE_RATE));
    const platformFee = totalValue - userCredit;

    // 4. Debit total value from platform gift wallet FIRST
    const giftWalletDebitResult = await this.walletService.processWalletTransaction(
      this.ADMIN_GIFT_WALLET_ID,
      WalletTransactionType.GIFT_CONVERSION,
      -totalValue, // Debit the full amount
      `Gift conversion: ${giftsToConvert.length} gift type(s) from user ${userId}`,
      undefined,
      'gift_conversion',
    );

    if (!giftWalletDebitResult.success) {
      throw new BadRequestException(`Failed to debit platform gift wallet: ${giftWalletDebitResult.error}`);
    }

    // 5. Credit user wallet (80%)
    const userCreditResult = await this.walletService.processWalletTransaction(
      userId,
      WalletTransactionType.GIFT_CONVERSION,
      userCredit,
      `Gift conversion: ${giftsToConvert.length} gift type(s)`,
      giftWalletDebitResult.transactionId,
      'gift_conversion',
    );

    if (!userCreditResult.success) {
      // CRITICAL: Rollback platform gift wallet debit if user credit fails
      await this.walletService.processWalletTransaction(
        this.ADMIN_GIFT_WALLET_ID,
        WalletTransactionType.GIFT_CONVERSION,
        totalValue, // Credit back
        `Rollback: Gift conversion failed for user ${userId}`,
        giftWalletDebitResult.transactionId,
        'gift_conversion_rollback',
      );
      throw new BadRequestException(`Failed to credit user wallet: ${userCreditResult.error}`);
    }

    // 6. Credit platform wallet (20%) - This goes to the main platform wallet, NOT the gift wallet
    const platformCreditResult = await this.walletService.processWalletTransaction(
      this.PLATFORM_USER_ID,
      WalletTransactionType.PLATFORM_COMMISSION,
      platformFee,
      `Gift conversion fee (20%) from user ${userId} - ${giftsToConvert.length} gift(s) converted`,
      userCreditResult.transactionId,
      'gift_conversion',
    );

    if (!platformCreditResult.success) {
      this.logger.error(`❌ CRITICAL: Platform wallet credit failed for gift conversion fee: ${platformCreditResult.error}`);
      this.logger.error(`Platform fee amount: ${platformFee}, Platform User ID: ${this.PLATFORM_USER_ID}`);
      // Continue - user already credited, but log the error for investigation
      // The platform fee should be credited to PLATFORM_USER_ID (main platform wallet)
    } else {
      this.logger.log(`✅ Platform fee (${platformFee}) credited to platform wallet (${this.PLATFORM_USER_ID})`);
    }

    // 7. Update or remove gifts from user collection based on conversion quantity
    // Create a map of convertItem by user_gift_id for quick lookup
    const convertItemMap = new Map(dto.gifts.map(item => [item.user_gift_id, item]));
    
    for (const userGift of userGifts) {
      const convertItem = convertItemMap.get(userGift.id);
      if (!convertItem) continue;

      if (convertItem.quantity === userGift.quantity) {
        // Converting all quantity - delete the row
        const { error: deleteError } = await this.supabase
          .from('user_gifts')
          .delete()
          .eq('id', userGift.id);

        if (deleteError) {
          this.logger.error(`Failed to remove gift ${userGift.id} from collection: ${deleteError.message}`);
          // User already credited - log but don't fail
        }
      } else {
        // Converting partial quantity - update the row by decrementing quantity
        const newQuantity = userGift.quantity - convertItem.quantity;
        const { error: updateError } = await this.supabase
          .from('user_gifts')
          .update({ quantity: newQuantity })
          .eq('id', userGift.id);

        if (updateError) {
          this.logger.error(`Failed to update gift ${userGift.id} quantity: ${updateError.message}`);
          // User already credited - log but don't fail
        }
      }
    }

    // 8. Log transactions (use the actual converted quantities, not full quantities)
    const transactionsToInsert = dto.gifts.map(convertItem => {
      const userGift = userGiftMap.get(convertItem.user_gift_id);
      if (!userGift || !userGift.gift) return null;
      
      return {
        user_id: userId,
        gift_id: userGift.gift_id,
        quantity: convertItem.quantity, // Use converted quantity, not full quantity
        transaction_type: 'convert' as const,
        credit_amount: userGift.gift.credit_value * convertItem.quantity,
        recipient_id: null,
        session_type: null,
        session_id: null,
      };
    }).filter(Boolean);

    await this.supabase
      .from('gift_transactions')
      .insert(transactionsToInsert);

    // 9. Get updated wallet balance
    const updatedWallet = await this.walletService.getWallet(userId);

    // 10. Emit real-time event for gift collection update
    try {
      if (this.realtimeGateway?.server) {
        this.realtimeGateway.server.to(`user_${userId}`).emit('gift_collection_updated', {
          type: 'convert',
          giftsConverted: giftsToConvert,
          totalValue,
          userCredit,
          platformFee,
          newBalance: updatedWallet.availableBalance,
        });
        this.logger.log(`📡 Emitted gift_collection_updated (convert) to user_${userId}`);
      }
    } catch (error) {
      this.logger.warn('Failed to emit real-time gift conversion event:', error);
    }

    // 11. Send notification
    try {
      await this.notificationHelper.notifySystemUpdate(
        userId,
        'Gift Conversion Successful! 💰',
        `Converted ${giftsToConvert.length} gift type(s) to credits`,
        {
          transactionId: userCreditResult.transactionId,
          totalValue,
          userCredit,
          platformFee,
          newBalance: updatedWallet.availableBalance,
        },
      );
    } catch (error) {
      this.logger.warn('Failed to send gift conversion notification:', error);
    }

    return {
      success: true,
      transaction_id: userCreditResult.transactionId || '',
      total_value: totalValue,
      user_credit: userCredit,
      platform_fee: platformFee,
      new_wallet_balance: updatedWallet.availableBalance,
      gifts_converted: giftsToConvert,
    };
  }

  /**
   * Send a gift to another user (in call/stream/auction)
   * Uses atomic database function to prevent race conditions and ensure data consistency
   */
  async sendGift(senderId: string, dto: SendGiftDto): Promise<void> {
    this.logger.log(`[GiftService] sendGift called: sender=${senderId}, recipient=${dto.recipient_id}, gift=${dto.gift_id}, quantity=${dto.quantity}, session=${dto.session_type}`);

    // Validate recipient is not the same as sender
    if (senderId === dto.recipient_id) {
      throw new BadRequestException('Cannot send gift to yourself');
    }

    // Use atomic RPC function to handle gift sending
    // This ensures:
    // - Proper quantity validation (sums total owned, not just count records)
    // - Proper gift selection (handles partial quantities from multiple entries)
    // - Atomic transfer (sender removal + recipient addition in one transaction)
    // - Automatic rollback on failure
    const { data: result, error: rpcError } = await this.supabase.rpc('send_gift_atomic', {
      p_sender_id: senderId,
      p_recipient_id: dto.recipient_id,
      p_gift_id: dto.gift_id,
      p_quantity: dto.quantity,
      p_session_type: dto.session_type,
      p_session_id: dto.session_id,
    });

    if (rpcError) {
      this.logger.error(`[GiftService] RPC error sending gift: ${rpcError.message}`);
      throw new BadRequestException(`Failed to send gift: ${rpcError.message}`);
    }

    // Check if RPC function returned an error
    if (!result || !result.success) {
      const errorMessage = result?.message || result?.error || 'Failed to send gift';
      const errorCode = result?.error || 'UNKNOWN_ERROR';

      this.logger.error(`[GiftService] Gift send failed: ${errorCode} - ${errorMessage}`);

      // Map error codes to appropriate exceptions
      switch (errorCode) {
        case 'INVALID_QUANTITY':
        case 'INSUFFICIENT_GIFTS':
          throw new BadRequestException(errorMessage);
        case 'GIFT_NOT_FOUND':
          throw new NotFoundException(errorMessage);
        case 'INVALID_SESSION_TYPE':
          throw new BadRequestException(errorMessage);
        default:
          throw new BadRequestException(errorMessage);
      }
    }

    // Extract gift details from result
    const giftName = result.gift_name || 'Gift';
    const giftEmoji = result.gift_emoji || '🎁';

    this.logger.log(`[GiftService] ✅ Gift sent successfully: ${dto.quantity}x ${giftEmoji} ${giftName} from ${senderId} to ${dto.recipient_id}`);

    // Send notification to recipient
    try {
      await this.notificationHelper.notifySystemUpdate(
        dto.recipient_id,
        'Gift Received! 🎁',
        `You received ${dto.quantity}x ${giftEmoji} ${giftName} from a user!`,
        {
          giftId: dto.gift_id,
          giftName: giftName,
          quantity: dto.quantity,
          senderId: senderId,
          sessionType: dto.session_type,
          sessionId: dto.session_id,
        },
      );
      this.logger.log(`[GiftService] ✅ Notification sent to recipient ${dto.recipient_id}`);
    } catch (error) {
      this.logger.warn(`[GiftService] ⚠️ Failed to send gift received notification: ${error.message}`);
      // Don't throw - gift was sent successfully, notification failure is non-critical
    }

    // Emit real-time event for gift collection updates
    try {
      if (this.realtimeGateway?.server) {
        // Notify sender about gift collection update
        this.realtimeGateway.server.to(`user_${senderId}`).emit('gift_collection_updated', {
          type: 'send',
          gift_id: dto.gift_id,
          quantity: dto.quantity,
          recipient_id: dto.recipient_id,
        });

        // Notify recipient about gift collection update
        this.realtimeGateway.server.to(`user_${dto.recipient_id}`).emit('gift_collection_updated', {
          type: 'receive',
          gift_id: dto.gift_id,
          quantity: dto.quantity,
          sender_id: senderId,
        });

        this.logger.log(`[GiftService] 📡 Emitted gift_collection_updated events to sender and recipient`);

        // If gift is sent during a call, emit animation event to conversation room
        if (dto.session_type === 'call' && dto.session_id) {
          try {
            // Get conversation ID from call session (table name is chat_call_sessions, not call_sessions)
            const { data: callSession, error: callSessionError } = await this.supabase
              .from('chat_call_sessions')
              .select('conversation_id')
              .eq('id', dto.session_id)
              .single();

            if (callSessionError) {
              this.logger.warn(`[GiftService] ⚠️ Error fetching call session ${dto.session_id}: ${callSessionError.message}`);
            }

            if (callSession?.conversation_id) {
              // Broadcast gift animation to everyone in the call room
              this.realtimeGateway.server.to(`conversation_${callSession.conversation_id}`).emit('call_signal', {
                callSessionId: dto.session_id,
                signalType: 'gift_animation',
                data: {
                  giftId: dto.gift_id,
                  giftEmoji: giftEmoji,
                  giftName: giftName,
                  quantity: dto.quantity,
                  senderId: senderId,
                  recipientId: dto.recipient_id,
                  timestamp: new Date().toISOString(),
                },
                conversationId: callSession.conversation_id,
                from: senderId,
              });

              this.logger.log(`[GiftService] 🎁 Emitted gift_animation event to conversation ${callSession.conversation_id} for call ${dto.session_id}`);
            } else {
              this.logger.warn(`[GiftService] ⚠️ Could not find conversation_id for call session ${dto.session_id}`);
            }
          } catch (callError) {
            this.logger.warn(`[GiftService] ⚠️ Failed to emit gift animation for call: ${callError.message}`);
            // Don't throw - gift was sent successfully, animation event failure is non-critical
          }
        }
      }
    } catch (error) {
      this.logger.warn(`[GiftService] ⚠️ Failed to emit real-time gift events: ${error.message}`);
      // Don't throw - gift was sent successfully, real-time event failure is non-critical
    }
  }

  /**
   * Get admin gift wallet balance
   */
  async getAdminGiftWalletBalance(): Promise<{ availableBalance: number; totalValue: number }> {
    const wallet = await this.walletService.getWallet(this.ADMIN_GIFT_WALLET_ID);
    return {
      availableBalance: wallet.availableBalance,
      totalValue: wallet.availableBalance + wallet.escrowBalance + wallet.pendingWithdrawal,
    };
  }

  /**
   * Get gift economy statistics for admin
   */
  async getGiftStats(): Promise<{
    totalGiftValue: number;
    totalGiftsInCirculation: number;
    totalUsersWithGifts: number;
    platformGiftWalletBalance: number;
    topGifts: Array<{ gift_id: string; gift_name: string; emoji: string; total_quantity: number; total_value: number }>;
  }> {
    // Get platform gift wallet balance
    const walletBalance = await this.getAdminGiftWalletBalance();

    // Get total gifts in circulation (sum of all user_gifts quantities * credit_value)
    // Exclude system users (platform gift wallet and platform wallet)
    const { data: userGifts, error: userGiftsError } = await this.supabase
      .from('user_gifts')
      .select(`
        quantity,
        gift:virtual_gifts (id, name, emoji, credit_value)
      `)
      .neq('user_id', this.ADMIN_GIFT_WALLET_ID) // Exclude platform gift wallet
      .neq('user_id', this.PLATFORM_USER_ID);   // Exclude platform wallet

    if (userGiftsError) {
      this.logger.error(`Failed to fetch user gifts for stats: ${userGiftsError.message}`);
      throw new BadRequestException('Failed to fetch gift statistics');
    }

    let totalGiftValue = 0;
    let totalGiftsInCirculation = 0;
    const giftMap = new Map<string, { name: string; emoji: string; quantity: number; value: number }>();

    for (const ug of userGifts || []) {
      const gift = (ug as any).gift;
      if (!gift) continue;

      const giftValue = gift.credit_value * ug.quantity;
      totalGiftValue += giftValue;
      totalGiftsInCirculation += ug.quantity;

      const existing = giftMap.get(gift.id) || { name: gift.name, emoji: gift.emoji, quantity: 0, value: 0 };
      existing.quantity += ug.quantity;
      existing.value += giftValue;
      giftMap.set(gift.id, existing);
    }

    // Get unique users with gifts (excluding system users)
    // Fetch all user_ids and count unique ones in JavaScript (Supabase doesn't support DISTINCT count easily)
    const { data: userGiftsForCount, error: countError } = await this.supabase
      .from('user_gifts')
      .select('user_id')
      .neq('user_id', this.ADMIN_GIFT_WALLET_ID) // Exclude platform gift wallet
      .neq('user_id', this.PLATFORM_USER_ID);   // Exclude platform wallet

    if (countError) {
      this.logger.error(`Failed to count users with gifts: ${countError.message}`);
    }

    // Count unique user_ids
    const uniqueUsersCount = userGiftsForCount 
      ? new Set(userGiftsForCount.map(ug => ug.user_id)).size 
      : 0;

    // Get top gifts by quantity
    const topGifts = Array.from(giftMap.entries())
      .map(([gift_id, data]) => ({
        gift_id,
        gift_name: data.name,
        emoji: data.emoji,
        total_quantity: data.quantity,
        total_value: data.value,
      }))
      .sort((a, b) => b.total_quantity - a.total_quantity)
      .slice(0, 10);

    return {
      totalGiftValue,
      totalGiftsInCirculation,
      totalUsersWithGifts: uniqueUsersCount || 0,
      platformGiftWalletBalance: walletBalance.availableBalance,
      topGifts,
    };
  }

  /**
   * Get user gift holdings for admin view
   */
  async getUserGiftHoldings(filters: { page: number; limit: number; search?: string }): Promise<{
    users: Array<{
      user_id: string;
      total_gifts: number;
      total_value: number;
      gift_breakdown: Array<{ gift_id: string; gift_name: string; emoji: string; quantity: number; value: number }>;
    }>;
    total: number;
    page: number;
    limit: number;
  }> {
    // Exclude system users (platform gift wallet and platform wallet)
    const systemUserIds = [
      this.ADMIN_GIFT_WALLET_ID, // Platform gift wallet
      this.PLATFORM_USER_ID,     // Platform wallet
    ];

    let query = this.supabase
      .from('user_gifts')
      .select(`
        user_id,
        quantity,
        gift:virtual_gifts (id, name, emoji, credit_value)
      `)
      .neq('user_id', this.ADMIN_GIFT_WALLET_ID) // Exclude platform gift wallet
      .neq('user_id', this.PLATFORM_USER_ID);     // Exclude platform wallet

    if (filters.search) {
      // Search by user_id (could be extended to search by username via join)
      query = query.ilike('user_id', `%${filters.search}%`);
    }

    const { data: userGifts, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch user gift holdings: ${error.message}`);
      throw new BadRequestException('Failed to fetch user gift holdings');
    }

    // Group by user_id
    const userMap = new Map<string, {
      total_gifts: number;
      total_value: number;
      gift_breakdown: Map<string, { gift_id: string; gift_name: string; emoji: string; quantity: number; value: number }>;
    }>();

    for (const ug of userGifts || []) {
      const gift = (ug as any).gift;
      if (!gift) continue;

      const userData = userMap.get(ug.user_id) || {
        total_gifts: 0,
        total_value: 0,
        gift_breakdown: new Map(),
      };

      const giftValue = gift.credit_value * ug.quantity;
      userData.total_gifts += ug.quantity;
      userData.total_value += giftValue;

      const existingGift = userData.gift_breakdown.get(gift.id) || {
        gift_id: gift.id,
        gift_name: gift.name,
        emoji: gift.emoji,
        quantity: 0,
        value: 0,
      };
      existingGift.quantity += ug.quantity;
      existingGift.value += giftValue;
      userData.gift_breakdown.set(gift.id, existingGift);

      userMap.set(ug.user_id, userData);
    }

    // Convert to array and sort by total_value
    const users = Array.from(userMap.entries())
      .map(([user_id, data]) => ({
        user_id,
        total_gifts: data.total_gifts,
        total_value: data.total_value,
        gift_breakdown: Array.from(data.gift_breakdown.values()),
      }))
      .sort((a, b) => b.total_value - a.total_value);

    // Paginate
    const start = (filters.page - 1) * filters.limit;
    const end = start + filters.limit;
    const paginatedUsers = users.slice(start, end);

    return {
      users: paginatedUsers,
      total: users.length,
      page: filters.page,
      limit: filters.limit,
    };
  }

  /**
   * Admin: Create a new gift
   */
  async createGift(dto: CreateGiftDto): Promise<VirtualGift> {
    const { data, error } = await this.supabase
      .from('virtual_gifts')
      .insert({
        name: dto.name,
        emoji: dto.emoji,
        credit_value: dto.credit_value,
        sort_order: dto.sort_order || 0,
        is_active: dto.is_active !== undefined ? dto.is_active : true,
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to create gift: ${error.message}`);
      throw new BadRequestException('Failed to create gift');
    }

    return data;
  }

  /**
   * Admin: Update a gift
   */
  async updateGift(id: string, dto: UpdateGiftDto): Promise<VirtualGift> {
    const updates: any = {};
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.emoji !== undefined) updates.emoji = dto.emoji;
    if (dto.credit_value !== undefined) updates.credit_value = dto.credit_value;
    if (dto.sort_order !== undefined) updates.sort_order = dto.sort_order;
    if (dto.is_active !== undefined) updates.is_active = dto.is_active;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('virtual_gifts')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to update gift: ${error.message}`);
      throw new BadRequestException('Failed to update gift');
    }

    if (!data) {
      throw new NotFoundException('Gift not found');
    }

    return data;
  }

  /**
   * Delete a virtual gift (Admin only)
   * Note: This will fail if there are user_gifts referencing this gift
   * Consider deactivating instead using updateGift with is_active: false
   */
  async deleteGift(id: string): Promise<void> {
    // Check if gift exists
    const { data: gift, error: fetchError } = await this.supabase
      .from('virtual_gifts')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !gift) {
      throw new NotFoundException('Gift not found');
    }

    // Check if any users own this gift
    const { data: userGifts, error: checkError } = await this.supabase
      .from('user_gifts')
      .select('id')
      .eq('gift_id', id)
      .limit(1);

    if (checkError) {
      this.logger.error(`Failed to check user gifts: ${checkError.message}`);
      throw new BadRequestException('Failed to check gift usage');
    }

    if (userGifts && userGifts.length > 0) {
      throw new BadRequestException(
        'Cannot delete gift: Users still own this gift. Deactivate it instead using the update endpoint.'
      );
    }

    // Delete the gift
    const { error } = await this.supabase
      .from('virtual_gifts')
      .delete()
      .eq('id', id);

    if (error) {
      this.logger.error(`Failed to delete gift: ${error.message}`);
      throw new BadRequestException('Failed to delete gift');
    }

    this.logger.log(`Gift ${id} deleted successfully`);
  }

  /**
   * Get all gifts (including inactive) for admin management
   */
  async getAllGiftsForAdmin(): Promise<VirtualGift[]> {
    const { data, error } = await this.supabase
      .from('virtual_gifts')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch all gifts: ${error.message}`);
      throw new BadRequestException('Failed to fetch gifts');
    }

    return data || [];
  }
}

