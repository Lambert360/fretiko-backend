import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { createSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';

const BACKUP_CODE_COUNT = 10;
const TRUSTED_DEVICE_DAYS = 30;

/**
 * MfaService
 *
 * Wraps Supabase Auth's native TOTP MFA APIs (enroll/challenge/verify/unenroll).
 * IMPORTANT: MFA operations require a live Supabase GoTrue session (not our custom
 * app JWT, and not the service-role key). Each call here builds a FRESH anon-key
 * client and sets the session on it, then discards it - this avoids any shared
 * client-state contamination across concurrent requests.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(private configService: ConfigService) {}

  private async withSession(accessToken: string, refreshToken: string) {
    const client = createSupabaseClient(this.configService);
    const { error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) {
      throw new UnauthorizedException('Invalid or expired Supabase session for MFA operation');
    }
    return client;
  }

  async enroll(accessToken: string, refreshToken: string) {
    const client = await this.withSession(accessToken, refreshToken);
    const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp' });
    if (error) {
      this.logger.error(`MFA enroll failed: ${error.message}`);
      throw new BadRequestException(error.message);
    }
    return {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    };
  }

  async verifyEnrollment(accessToken: string, refreshToken: string, factorId: string, code: string) {
    const client = await this.withSession(accessToken, refreshToken);

    const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId });
    if (challengeError) {
      this.logger.error(`MFA challenge failed: ${challengeError.message}`);
      throw new BadRequestException(challengeError.message);
    }

    const { error } = await client.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code,
    });
    if (error) {
      this.logger.warn(`MFA verify failed for factor ${factorId}: ${error.message}`);
      throw new BadRequestException('Invalid or expired code');
    }

    return { success: true, factorId };
  }

  async listFactors(accessToken: string, refreshToken: string) {
    const client = await this.withSession(accessToken, refreshToken);
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) {
      throw new BadRequestException(error.message);
    }
    return {
      totp: (data.totp || []).map((f) => ({
        id: f.id,
        status: f.status,
        createdAt: f.created_at,
      })),
    };
  }

  async unenroll(accessToken: string, refreshToken: string, factorId: string) {
    const client = await this.withSession(accessToken, refreshToken);
    const { error } = await client.auth.mfa.unenroll({ factorId });
    if (error) {
      throw new BadRequestException(error.message);
    }
    return { success: true };
  }

  /**
   * Returns verified TOTP factors and current assurance level for a session,
   * used by AuthService.signIn() to decide whether a step-up challenge is required.
   */
  async getVerifiedFactorsAndLevel(accessToken: string, refreshToken: string) {
    const client = await this.withSession(accessToken, refreshToken);

    const { data: factorsData, error: factorsError } = await client.auth.mfa.listFactors();
    if (factorsError) {
      this.logger.warn(`Could not list MFA factors during sign-in: ${factorsError.message}`);
      return { verifiedFactors: [], currentLevel: 'aal1' as const };
    }

    const verifiedFactors = (factorsData.totp || []).filter((f) => f.status === 'verified');

    const { data: aalData } = await client.auth.mfa.getAuthenticatorAssuranceLevel();

    return {
      verifiedFactors,
      currentLevel: aalData?.currentLevel || 'aal1',
    };
  }

  /**
   * Mints a fresh, short-lived Supabase GoTrue session for an already
   * app-JWT-authenticated user, so Settings > Security can call the
   * enroll/verify/factors/unenroll endpoints above without the mobile app
   * ever having to persist long-lived Supabase tokens. Uses the service-role
   * admin API to generate a magic-link token and immediately redeems it
   * server-side - no email is sent, and no password is required.
   */
  async mintSessionForUser(email: string) {
    const serviceClient = createServiceSupabaseClient(this.configService);
    const { data: linkData, error: linkError } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (linkError || !linkData?.properties?.hashed_token) {
      this.logger.error(`Could not mint MFA session for ${email}: ${linkError?.message}`);
      throw new BadRequestException('Could not start MFA session');
    }

    const client = createSupabaseClient(this.configService);
    const { data, error } = await client.auth.verifyOtp({
      email,
      token: linkData.properties.hashed_token,
      type: 'magiclink',
    });
    if (error || !data.session) {
      this.logger.error(`Could not verify MFA session for ${email}: ${error?.message}`);
      throw new BadRequestException('Could not start MFA session');
    }

    return {
      supabaseAccessToken: data.session.access_token,
      supabaseRefreshToken: data.session.refresh_token,
    };
  }

  async completeLoginChallenge(accessToken: string, refreshToken: string, factorId: string, code: string) {
    const client = await this.withSession(accessToken, refreshToken);

    const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId });
    if (challengeError) {
      throw new UnauthorizedException(challengeError.message);
    }

    const { error } = await client.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code,
    });
    if (error) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    return true;
  }

  /**
   * Generates a fresh set of one-time backup codes for a user, replacing any
   * previously issued (unused or used) codes. Only the bcrypt hash is
   * persisted; the plaintext codes are returned once and must be shown to
   * the user immediately - they cannot be retrieved again.
   */
  async generateBackupCodes(userId: string): Promise<string[]> {
    const service = createServiceSupabaseClient(this.configService);

    const { error: deleteError } = await service
      .from('mfa_backup_codes')
      .delete()
      .eq('user_id', userId);
    if (deleteError) {
      this.logger.error(`Could not clear old backup codes for ${userId}: ${deleteError.message}`);
      throw new BadRequestException('Could not generate backup codes');
    }

    const codes: string[] = [];
    const rows: { user_id: string; code_hash: string }[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const code = this.generateReadableCode();
      codes.push(code);
      rows.push({ user_id: userId, code_hash: await bcrypt.hash(code, 10) });
    }

    const { error: insertError } = await service.from('mfa_backup_codes').insert(rows);
    if (insertError) {
      this.logger.error(`Could not store backup codes for ${userId}: ${insertError.message}`);
      throw new BadRequestException('Could not generate backup codes');
    }

    return codes;
  }

  /**
   * Verifies and consumes a single backup code for a user. Returns true on
   * success (and marks the code used so it cannot be reused).
   */
  async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    const service = createServiceSupabaseClient(this.configService);
    const { data, error } = await service
      .from('mfa_backup_codes')
      .select('id, code_hash')
      .eq('user_id', userId)
      .is('used_at', null);

    if (error || !data) {
      return false;
    }

    for (const row of data) {
      if (await bcrypt.compare(code, row.code_hash)) {
        await service
          .from('mfa_backup_codes')
          .update({ used_at: new Date().toISOString() })
          .eq('id', row.id);
        return true;
      }
    }
    return false;
  }

  /**
   * Issues a trusted-device token after a successful MFA verification when
   * the user opts to "remember this device". Only the hash is stored; the
   * plaintext token is returned once for the client to persist locally and
   * resend on future sign-ins via SignInDto.deviceToken.
   */
  async issueTrustedDeviceToken(userId: string, deviceName?: string): Promise<string> {
    const service = createServiceSupabaseClient(this.configService);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000);

    const { error } = await service.from('mfa_trusted_devices').insert({
      user_id: userId,
      device_token_hash: await bcrypt.hash(token, 10),
      device_name: deviceName || null,
      expires_at: expiresAt.toISOString(),
    });
    if (error) {
      this.logger.error(`Could not store trusted device for ${userId}: ${error.message}`);
      throw new BadRequestException('Could not remember this device');
    }

    return token;
  }

  /**
   * Checks whether a device token is a valid, unexpired trusted device for
   * this user. Used by AuthService.signIn() to decide whether MFA can be
   * skipped. Fails closed (returns false) on any lookup error.
   */
  async isTrustedDevice(userId: string, deviceToken: string): Promise<boolean> {
    if (!deviceToken) return false;
    const service = createServiceSupabaseClient(this.configService);
    const { data, error } = await service
      .from('mfa_trusted_devices')
      .select('device_token_hash')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString());

    if (error || !data) {
      return false;
    }

    for (const row of data) {
      if (await bcrypt.compare(deviceToken, row.device_token_hash)) {
        return true;
      }
    }
    return false;
  }

  private generateReadableCode(): string {
    const bytes = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${bytes.slice(0, 5)}-${bytes.slice(5, 10)}`;
  }
}
