import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseClient, createServiceSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';

/**
 * SupabaseClientManager
 * 
 * Manages Supabase client instances to ensure proper client separation:
 * - Service Client: For backend operations, bypasses RLS, never gets contaminated
 * - User Client: For user-specific operations, respects RLS, can have sessions
 * 
 * CLIENT USAGE RULES:
 * 
 * ✅ Service Client (getServiceClient):
 * - Use for backend operations only
 * - Never set sessions on it
 * - Bypasses RLS automatically
 * - Used for: token operations, admin tasks, background jobs
 * 
 * ✅ User Client (getUserClient):
 * - Use for user-specific operations
 * - Can set sessions
 * - Respects RLS policies
 * - Used for: user data queries, profile operations
 * 
 * ❌ NEVER:
 * - Set session on service client
 * - Use service client for user data
 * - Mix client types
 */
@Injectable()
export class SupabaseClientManager {
  private serviceClient: SupabaseClient;
  
  constructor(private configService: ConfigService) {
    // Initialize service client once - never gets contaminated
    this.serviceClient = createServiceSupabaseClient(this.configService);
  }
  
  /**
   * Get the service role client
   * This client bypasses RLS and should never have sessions set on it
   */
  getServiceClient(): SupabaseClient {
    return this.serviceClient;
  }
  
  /**
   * Get a user client (anon key)
   * This client respects RLS policies
   */
  getUserClient(): SupabaseClient {
    return createSupabaseClient(this.configService);
  }
  
  /**
   * Get a user client with an access token
   * This client respects RLS policies and has the user's session
   */
  getUserClientWithToken(accessToken: string): SupabaseClient {
    return createUserSupabaseClient(this.configService, accessToken);
  }
}
