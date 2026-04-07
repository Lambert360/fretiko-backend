import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';

// Retry utility for network resilience
const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> => {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Don't retry on certain errors
      if (error?.code && !['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)) {
        throw error;
      }

      if (attempt === maxRetries) {
        throw lastError;
      }

      // Exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
};

// Export SupabaseClient type and utilities for other modules
export { SupabaseClient, withRetry };

// Shared Supabase client that all services can use
export const createSupabaseClient = (configService?: ConfigService) => {
  const supabaseUrl = configService?.get<string>('SUPABASE_URL');
  const supabaseKey = configService?.get<string>('SUPABASE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials not found in environment');
  }

  return createClient(supabaseUrl, supabaseKey, {
    db: {
      schema: 'public',
    },
    auth: {
      autoRefreshToken: true,
      persistSession: true,
    },
    global: {
      fetch: async (url, options = {}) => {
        // Enhance fetch with timeout and retry
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

        try {
          return await withRetry(async () => {
            return fetch(url, {
              ...options,
              signal: controller.signal,
            });
          });
        } finally {
          clearTimeout(timeoutId);
        }
      },
    },
  });
};

// Service role client for backend operations (bypasses RLS)
export const createServiceSupabaseClient = (configService: ConfigService) => {
  const supabaseUrl = configService.get<string>('SUPABASE_URL');
  const serviceRoleKey = configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase service role credentials not found in environment');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    db: {
      schema: 'public',
    },
    auth: {
      autoRefreshToken: false, // Service role doesn't need refresh
      persistSession: false,
    },
    global: {
      fetch: async (url, options = {}) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
          return await withRetry(async () => {
            return fetch(url, {
              ...options,
              signal: controller.signal,
            });
          });
        } finally {
          clearTimeout(timeoutId);
        }
      },
    },
  });
};

// Create user-specific client with auth token
export const createUserSupabaseClient = (configService: ConfigService, accessToken: string) => {
  const supabaseUrl = configService.get<string>('SUPABASE_URL');
  const supabaseKey = configService.get<string>('SUPABASE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials not found in environment');
  }

  // Create client and set global headers with user token
  const client = createClient(supabaseUrl, supabaseKey, {
    db: {
      schema: 'public',
    },
    auth: {
      autoRefreshToken: true,
      persistSession: true,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      fetch: async (url, options = {}) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
          return await withRetry(async () => {
            return fetch(url, {
              ...options,
              signal: controller.signal,
            });
          });
        } finally {
          clearTimeout(timeoutId);
        }
      },
    },
  });
  
  return client;
};