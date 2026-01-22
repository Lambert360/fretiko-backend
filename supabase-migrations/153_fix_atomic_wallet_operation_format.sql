BEGIN;

-- =====================================================
-- FIX ATOMIC WALLET OPERATION FORMAT() ERRORS
-- Migration: 153
-- Date: 2026-01-21
-- Description: 
--   Fix PostgreSQL format() function calls in atomic_wallet_operation
--   Replace invalid '%' placeholders with '%s' for proper string formatting
-- =====================================================

CREATE OR REPLACE FUNCTION atomic_wallet_operation(
    p_user_id UUID,
    p_available_delta DECIMAL(18,6),
    p_escrow_delta DECIMAL(18,6),
    p_pending_withdrawal_delta DECIMAL(18,6),
    p_transaction_type VARCHAR(50),
    p_reference_type VARCHAR(50),
    p_reference_id UUID,
    p_idempotency_key VARCHAR(255),
    p_description TEXT,
    p_metadata JSONB DEFAULT '{}'::JSONB,
    p_created_by UUID DEFAULT NULL
)
RETURNS TABLE(
    success BOOLEAN,
    wallet_id UUID,
    available_balance_after DECIMAL(18,6),
    escrow_balance_after DECIMAL(18,6),
    pending_withdrawal_after DECIMAL(18,6),
    ledger_entry_id UUID,
    error_message TEXT
) AS $$
DECLARE
    v_wallet_id UUID;
    v_current_available DECIMAL(18,6);
    v_current_escrow DECIMAL(18,6);
    v_current_pending DECIMAL(18,6);
    v_new_available DECIMAL(18,6);
    v_new_escrow DECIMAL(18,6);
    v_new_pending DECIMAL(18,6);
    v_ledger_id UUID;
    v_idempotency_exists BOOLEAN;
BEGIN
    -- Check idempotency key first (before any balance operations)
    SELECT EXISTS(
        SELECT 1 FROM wallet_ledger 
        WHERE idempotency_key = p_idempotency_key
    ) INTO v_idempotency_exists;
    
    IF v_idempotency_exists THEN
        -- Return existing ledger entry
        SELECT 
            wallet_id,
            available_balance_after,
            escrow_balance_after,
            pending_withdrawal_after,
            id
        INTO v_wallet_id, v_new_available, v_new_escrow, v_new_pending, v_ledger_id
        FROM wallet_ledger
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;
        
        RETURN QUERY SELECT 
            TRUE as success,
            v_wallet_id,
            v_new_available,
            v_new_escrow,
            v_new_pending,
            v_ledger_id,
            NULL::TEXT as error_message;
        RETURN;
    END IF;
    
    -- Get wallet with row-level lock (FOR UPDATE prevents concurrent modifications)
    SELECT id, available_balance, escrow_balance, pending_withdrawal
    INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF v_wallet_id IS NULL THEN
        RETURN QUERY SELECT 
            FALSE as success,
            NULL::UUID as wallet_id,
            NULL::DECIMAL as available_balance_after,
            NULL::DECIMAL as escrow_balance_after,
            NULL::DECIMAL as pending_withdrawal_after,
            NULL::UUID as ledger_entry_id,
            'Wallet not found'::TEXT as error_message;
        RETURN;
    END IF;
    
    -- Calculate new balances
    v_new_available := v_current_available + p_available_delta;
    v_new_escrow := v_current_escrow + p_escrow_delta;
    v_new_pending := v_current_pending + p_pending_withdrawal_delta;
    
    -- Validate balances are non-negative
    IF v_new_available < 0 OR v_new_escrow < 0 OR v_new_pending < 0 THEN
        RETURN QUERY SELECT 
            FALSE as success,
            v_wallet_id,
            NULL::DECIMAL as available_balance_after,
            NULL::DECIMAL as escrow_balance_after,
            NULL::DECIMAL as pending_withdrawal_after,
            NULL::UUID as ledger_entry_id,
            format('Insufficient balance. Available: %s, Required: %s', 
                v_current_available, ABS(p_available_delta))::TEXT as error_message;
        RETURN;
    END IF;
    
    -- Generate ledger entry ID
    v_ledger_id := gen_random_uuid();
    
    -- Insert ledger entry (trigger will update wallet balances)
    INSERT INTO wallet_ledger (
        id,
        wallet_id,
        user_id,
        transaction_type,
        available_delta,
        escrow_delta,
        pending_withdrawal_delta,
        available_balance_after,
        escrow_balance_after,
        pending_withdrawal_after,
        reference_type,
        reference_id,
        idempotency_key,
        description,
        metadata,
        created_by
    ) VALUES (
        v_ledger_id,
        v_wallet_id,
        p_user_id,
        p_transaction_type,
        p_available_delta,
        p_escrow_delta,
        p_pending_withdrawal_delta,
        v_new_available,  -- Calculated balance
        v_new_escrow,     -- Calculated balance
        v_new_pending,    -- Calculated balance
        p_reference_type,
        p_reference_id,
        p_idempotency_key,
        p_description,
        p_metadata,
        p_created_by
    );
    
    -- Update wallet balances (redundant with trigger, but ensures consistency)
    UPDATE wallets 
    SET 
        available_balance = v_new_available,
        escrow_balance = v_new_escrow,
        pending_withdrawal = v_new_pending,
        updated_at = NOW()
    WHERE id = v_wallet_id;
    
    RETURN QUERY SELECT 
        TRUE as success,
        v_wallet_id,
        v_new_available,
        v_new_escrow,
        v_new_pending,
        v_ledger_id,
        NULL::TEXT as error_message;
END;
$$ LANGUAGE plpgsql;

-- Also fix validate_daily_limit function format() calls
CREATE OR REPLACE FUNCTION validate_daily_limit(
    p_user_id UUID,
    p_amount DECIMAL(18,6),
    p_limit_type VARCHAR(20), -- 'deposit' or 'withdrawal'
    p_transaction_type VARCHAR(50) -- 'deposit_mint' or 'withdrawal_burn'
)
RETURNS TABLE(
    is_valid BOOLEAN,
    daily_limit DECIMAL(18,6),
    daily_used DECIMAL(18,6),
    remaining DECIMAL(18,6),
    error_message TEXT
) AS $$
DECLARE
    v_wallet_limit DECIMAL(18,6);
    v_daily_used DECIMAL(18,6);
    v_today_start TIMESTAMP WITH TIME ZONE;
    v_today_end TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Set today's time bounds (UTC)
    v_today_start := date_trunc('day', NOW())::TIMESTAMP WITH TIME ZONE;
    v_today_end := v_today_start + INTERVAL '1 day';
    
    -- Get wallet limit based on type
    IF p_limit_type = 'deposit' THEN
        SELECT daily_deposit_limit INTO v_wallet_limit
        FROM wallets
        WHERE user_id = p_user_id;
        
        -- Calculate daily deposits (must be in same transaction for atomicity)
        SELECT COALESCE(SUM(available_delta), 0)
        INTO v_daily_used
        FROM wallet_ledger
        WHERE user_id = p_user_id
        AND transaction_type = 'deposit_mint'
        AND created_at >= v_today_start
        AND created_at < v_today_end;
    ELSIF p_limit_type = 'withdrawal' THEN
        SELECT daily_withdrawal_limit INTO v_wallet_limit
        FROM wallets
        WHERE user_id = p_user_id;
        
        -- Calculate daily withdrawals (must be in same transaction for atomicity)
        SELECT COALESCE(SUM(ABS(available_delta)), 0)
        INTO v_daily_used
        FROM wallet_ledger
        WHERE user_id = p_user_id
        AND transaction_type = p_transaction_type
        AND created_at >= v_today_start
        AND created_at < v_today_end;
    ELSE
        RETURN QUERY SELECT 
            FALSE as is_valid,
            NULL::DECIMAL as daily_limit,
            NULL::DECIMAL as daily_used,
            NULL::DECIMAL as remaining,
            format('Invalid limit type: %s', p_limit_type)::TEXT as error_message;
        RETURN;
    END IF;
    
    -- Validate
    IF v_wallet_limit IS NULL THEN
        RETURN QUERY SELECT 
            FALSE as is_valid,
            NULL::DECIMAL as daily_limit,
            NULL::DECIMAL as daily_used,
            NULL::DECIMAL as remaining,
            'Wallet not found'::TEXT as error_message;
        RETURN;
    END IF;
    
    IF v_daily_used + p_amount > v_wallet_limit THEN
        RETURN QUERY SELECT 
            FALSE as is_valid,
            v_wallet_limit as daily_limit,
            v_daily_used as daily_used,
            GREATEST(0, v_wallet_limit - v_daily_used) as remaining,
            format('Daily %s limit exceeded. Limit: %s, Used: %s, Requested: %s, Remaining: %s',
                p_limit_type, v_wallet_limit, v_daily_used, p_amount,
                GREATEST(0, v_wallet_limit - v_daily_used))::TEXT as error_message;
        RETURN;
    END IF;
    
    RETURN QUERY SELECT 
        TRUE as is_valid,
        v_wallet_limit as daily_limit,
        v_daily_used as daily_used,
        GREATEST(0, v_wallet_limit - v_daily_used - p_amount) as remaining,
        NULL::TEXT as error_message;
END;
$$ LANGUAGE plpgsql;

COMMIT;

