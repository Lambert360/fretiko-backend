/**
 * FRETIKO BACKEND - PIN VERIFICATION SERVICE
 * Handles secure PIN creation, verification, and management
 */

import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import * as crypto from 'crypto';

@Injectable()
export class PinService {
  private readonly logger = new Logger(PinService.name);
  private readonly supabase: SupabaseClient;

  constructor(private readonly configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Hash a PIN with salt
   */
  private hashPin(pin: string, salt: string): string {
    return crypto.pbkdf2Sync(pin, salt, 100000, 64, 'sha512').toString('hex');
  }

  /**
   * Generate a random salt
   */
  private generateSalt(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Check if user has a PIN
   */
  async hasPin(userId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('user_pins')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    return !!data && !error;
  }

  /**
   * Create a new PIN for user
   */
  async createPin(userId: string, pin: string): Promise<{ success: boolean; message: string }> {
    try {
      // Validate PIN format (6 digits)
      if (!/^\d{6}$/.test(pin)) {
        throw new BadRequestException('PIN must be exactly 6 digits');
      }

      // Check if user already has a PIN
      const existingPin = await this.hasPin(userId);
      if (existingPin) {
        throw new BadRequestException('User already has a PIN. Use change PIN instead.');
      }

      // Generate salt and hash
      const salt = this.generateSalt();
      const pinHash = this.hashPin(pin, salt);

      // Insert PIN record
      const { error } = await this.supabase
        .from('user_pins')
        .insert({
          user_id: userId,
          pin_hash: pinHash,
          pin_salt: salt,
          is_active: true,
          failed_attempts: 0,
        });

      if (error) {
        this.logger.error(`Failed to create PIN for user ${userId}:`, error);
        throw new BadRequestException('Failed to create PIN');
      }

      this.logger.log(`✅ PIN created successfully for user ${userId}`);
      return {
        success: true,
        message: 'PIN created successfully',
      };
    } catch (error) {
      this.logger.error(`Error creating PIN for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Verify a PIN
   */
  async verifyPin(
    userId: string,
    pin: string,
    actionType?: string,
    referenceId?: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Validate PIN format
      if (!/^\d{6}$/.test(pin)) {
        throw new BadRequestException('Invalid PIN format');
      }

      // Get user's PIN record
      const { data: pinRecord, error: fetchError } = await this.supabase
        .from('user_pins')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      if (fetchError || !pinRecord) {
        this.logger.warn(`No active PIN found for user ${userId}`);
        
        // Log failed attempt
        await this.logVerificationAttempt(userId, false, actionType, referenceId, ipAddress, userAgent);
        
        throw new UnauthorizedException('PIN not set up. Please create a PIN first.');
      }

      // Check if PIN is locked
      if (pinRecord.locked_until && new Date(pinRecord.locked_until) > new Date()) {
        const lockMinutes = Math.ceil((new Date(pinRecord.locked_until).getTime() - Date.now()) / 60000);
        throw new UnauthorizedException(`PIN is locked. Try again in ${lockMinutes} minutes.`);
      }

      // Verify PIN
      const pinHash = this.hashPin(pin, pinRecord.pin_salt);
      const isValid = pinHash === pinRecord.pin_hash;

      if (isValid) {
        // Reset failed attempts and update last used
        await this.supabase
          .from('user_pins')
          .update({
            failed_attempts: 0,
            locked_until: null,
            last_used_at: new Date().toISOString(),
          })
          .eq('user_id', userId);

        // Log successful attempt
        await this.logVerificationAttempt(userId, true, actionType, referenceId, ipAddress, userAgent);

        this.logger.log(`✅ PIN verified successfully for user ${userId}`);
        return {
          success: true,
          message: 'PIN verified successfully',
        };
      } else {
        // Increment failed attempts
        const newFailedAttempts = (pinRecord.failed_attempts || 0) + 1;
        const maxAttempts = 5;

        // Lock PIN if max attempts reached
        let lockedUntil: string | null = null;
        if (newFailedAttempts >= maxAttempts) {
          lockedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // Lock for 30 minutes
        }

        await this.supabase
          .from('user_pins')
          .update({
            failed_attempts: newFailedAttempts,
            locked_until: lockedUntil,
          })
          .eq('user_id', userId);

        // Log failed attempt
        await this.logVerificationAttempt(userId, false, actionType, referenceId, ipAddress, userAgent);

        const remainingAttempts = maxAttempts - newFailedAttempts;
        if (remainingAttempts > 0) {
          throw new UnauthorizedException(`Incorrect PIN. ${remainingAttempts} attempts remaining.`);
        } else {
          throw new UnauthorizedException('PIN locked due to too many failed attempts. Try again in 30 minutes.');
        }
      }
    } catch (error) {
      this.logger.error(`Error verifying PIN for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Change PIN (requires old PIN)
   */
  async changePin(userId: string, oldPin: string, newPin: string): Promise<{ success: boolean; message: string }> {
    try {
      // Verify old PIN first
      await this.verifyPin(userId, oldPin, 'pin_change');

      // Validate new PIN
      if (!/^\d{6}$/.test(newPin)) {
        throw new BadRequestException('New PIN must be exactly 6 digits');
      }

      if (oldPin === newPin) {
        throw new BadRequestException('New PIN must be different from old PIN');
      }

      // Generate new salt and hash
      const salt = this.generateSalt();
      const pinHash = this.hashPin(newPin, salt);

      // Update PIN
      const { error } = await this.supabase
        .from('user_pins')
        .update({
          pin_hash: pinHash,
          pin_salt: salt,
          failed_attempts: 0,
          locked_until: null,
        })
        .eq('user_id', userId);

      if (error) {
        this.logger.error(`Failed to change PIN for user ${userId}:`, error);
        throw new BadRequestException('Failed to change PIN');
      }

      this.logger.log(`✅ PIN changed successfully for user ${userId}`);
      return {
        success: true,
        message: 'PIN changed successfully',
      };
    } catch (error) {
      this.logger.error(`Error changing PIN for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Reset PIN (requires email verification - to be implemented)
   */
  async requestPinReset(userId: string): Promise<{ success: boolean; message: string }> {
    try {
      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

      // Update PIN record with reset token
      const { error } = await this.supabase
        .from('user_pins')
        .update({
          reset_token: resetToken,
          reset_token_expires_at: expiresAt,
          requires_reset: true,
        })
        .eq('user_id', userId);

      if (error) {
        this.logger.error(`Failed to request PIN reset for user ${userId}:`, error);
        throw new BadRequestException('Failed to request PIN reset');
      }

      // TODO: Send reset email with token
      this.logger.log(`📧 PIN reset requested for user ${userId}. Token: ${resetToken}`);

      return {
        success: true,
        message: 'PIN reset email sent. Check your inbox.',
      };
    } catch (error) {
      this.logger.error(`Error requesting PIN reset for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get PIN status
   */
  async getPinStatus(userId: string): Promise<{
    hasPin: boolean;
    isLocked: boolean;
    failedAttempts: number;
    lockedUntil: string | null;
  }> {
    const { data: pinRecord } = await this.supabase
      .from('user_pins')
      .select('is_active, failed_attempts, locked_until')
      .eq('user_id', userId)
      .single();

    if (!pinRecord) {
      return {
        hasPin: false,
        isLocked: false,
        failedAttempts: 0,
        lockedUntil: null,
      };
    }

    const isLocked = pinRecord.locked_until && new Date(pinRecord.locked_until) > new Date();

    return {
      hasPin: pinRecord.is_active,
      isLocked: !!isLocked,
      failedAttempts: pinRecord.failed_attempts || 0,
      lockedUntil: pinRecord.locked_until,
    };
  }

  /**
   * Log verification attempt
   */
  private async logVerificationAttempt(
    userId: string,
    success: boolean,
    actionType?: string,
    referenceId?: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    try {
      await this.supabase.from('pin_verification_attempts').insert({
        user_id: userId,
        success,
        action_type: actionType,
        reference_id: referenceId,
        ip_address: ipAddress,
        user_agent: userAgent,
      });
    } catch (error) {
      this.logger.error(`Failed to log PIN verification attempt:`, error);
      // Don't throw - logging failure shouldn't block the main operation
    }
  }
}

