-- =============================================================================
-- MASTER INVOICE SYSTEM MIGRATION
-- Date: 2025-10-01
-- Description: Comprehensive invoice system setup with all dependencies
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: UPDATE MESSAGE_TYPE ENUM
-- =============================================================================

-- Add 'call' and 'invoice' to message_type enum if they don't exist
DO $$
BEGIN
    -- Check if 'call' value exists in the enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'call'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'message_type')
    ) THEN
        ALTER TYPE message_type ADD VALUE 'call';
        RAISE NOTICE 'Added "call" to message_type enum';
    END IF;

    -- Check if 'invoice' value exists in the enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'invoice'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'message_type')
    ) THEN
        ALTER TYPE message_type ADD VALUE 'invoice';
        RAISE NOTICE 'Added "invoice" to message_type enum';
    END IF;
END $$;

-- =============================================================================
-- PART 2: CREATE INVOICE TABLES
-- =============================================================================

-- Create chat_invoices table
CREATE TABLE IF NOT EXISTS chat_invoices (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    conversation_id UUID NOT NULL,
    message_id UUID,
    vendor_id UUID NOT NULL,
    buyer_id UUID NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE,
    order_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Foreign key constraints (added conditionally)
    CONSTRAINT fk_invoice_conversation FOREIGN KEY (conversation_id)
        REFERENCES chat_conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_invoice_message FOREIGN KEY (message_id)
        REFERENCES chat_messages(id) ON DELETE SET NULL,
    CONSTRAINT fk_invoice_vendor FOREIGN KEY (vendor_id)
        REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT fk_invoice_buyer FOREIGN KEY (buyer_id)
        REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT fk_invoice_order FOREIGN KEY (order_id)
        REFERENCES orders(id) ON DELETE SET NULL
);

-- Create chat_invoice_items table
CREATE TABLE IF NOT EXISTS chat_invoice_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    invoice_id UUID NOT NULL,
    item_type VARCHAR(20) NOT NULL DEFAULT 'product' CHECK (item_type IN ('product', 'service')),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    total_price DECIMAL(10,2) GENERATED ALWAYS AS (price * quantity) STORED,
    image_url TEXT,
    appointment_date DATE,
    appointment_time TIME,
    product_id UUID,
    service_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT fk_item_invoice FOREIGN KEY (invoice_id)
        REFERENCES chat_invoices(id) ON DELETE CASCADE,
    CONSTRAINT fk_item_product FOREIGN KEY (product_id)
        REFERENCES products(id) ON DELETE SET NULL,
    CONSTRAINT fk_item_service FOREIGN KEY (service_id)
        REFERENCES services(id) ON DELETE SET NULL
);

-- Create function to auto-generate invoice numbers
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS VARCHAR(50) AS $func$
DECLARE
    new_number VARCHAR(50);
    max_number INTEGER;
BEGIN
    -- Get the maximum invoice number for today
    SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 16) AS INTEGER)), 0)
    INTO max_number
    FROM chat_invoices
    WHERE invoice_number LIKE 'INV-' || TO_CHAR(NOW(), 'YYYY-MM-DD') || '-%';

    -- Generate new invoice number with format: INV-YYYY-MM-DD-#####
    new_number := 'INV-' || TO_CHAR(NOW(), 'YYYY-MM-DD') || '-' || LPAD((max_number + 1)::TEXT, 5, '0');

    RETURN new_number;
END;
$func$ LANGUAGE plpgsql;

-- Create trigger to auto-generate invoice numbers
CREATE OR REPLACE FUNCTION set_invoice_number()
RETURNS TRIGGER AS $func$
BEGIN
    IF NEW.invoice_number IS NULL OR NEW.invoice_number = '' THEN
        NEW.invoice_number := generate_invoice_number();
    END IF;
    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_invoice_number ON chat_invoices;
CREATE TRIGGER trigger_set_invoice_number
    BEFORE INSERT ON chat_invoices
    FOR EACH ROW
    EXECUTE FUNCTION set_invoice_number();

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_chat_invoices_conversation_id ON chat_invoices(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_vendor_id ON chat_invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_buyer_id ON chat_invoices(buyer_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_status ON chat_invoices(status);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_expires_at ON chat_invoices(expires_at);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_invoice_number ON chat_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_chat_invoice_items_invoice_id ON chat_invoice_items(invoice_id);

-- =============================================================================
-- PART 3: ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================================

-- Enable RLS on invoice tables
ALTER TABLE chat_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_invoice_items ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for idempotency)
DROP POLICY IF EXISTS "Sellers and riders can create invoices" ON chat_invoices;
DROP POLICY IF EXISTS "Invoice participants can view invoices" ON chat_invoices;
DROP POLICY IF EXISTS "Vendors can update their invoices" ON chat_invoices;
DROP POLICY IF EXISTS "Vendors can delete their invoices" ON chat_invoices;
DROP POLICY IF EXISTS "Users can view invoice items for accessible invoices" ON chat_invoice_items;
DROP POLICY IF EXISTS "Vendors can insert invoice items" ON chat_invoice_items;
DROP POLICY IF EXISTS "Vendors can update invoice items" ON chat_invoice_items;
DROP POLICY IF EXISTS "Vendors can delete invoice items" ON chat_invoice_items;

-- RLS Policies for chat_invoices

-- Sellers and riders can create invoices
CREATE POLICY "Sellers and riders can create invoices"
ON chat_invoices
FOR INSERT
WITH CHECK (
    auth.uid() = vendor_id
    AND EXISTS (
        SELECT 1 FROM user_profiles
        WHERE id = auth.uid()
        AND (is_seller = true OR is_rider = true)
    )
);

-- Both vendor and buyer can view the invoice
CREATE POLICY "Invoice participants can view invoices"
ON chat_invoices
FOR SELECT
USING (
    auth.uid() = vendor_id OR auth.uid() = buyer_id
);

-- Only vendor can update their own invoices
CREATE POLICY "Vendors can update their invoices"
ON chat_invoices
FOR UPDATE
USING (auth.uid() = vendor_id)
WITH CHECK (auth.uid() = vendor_id);

-- Only vendor can delete (cancel) their own invoices
CREATE POLICY "Vendors can delete their invoices"
ON chat_invoices
FOR DELETE
USING (auth.uid() = vendor_id);

-- RLS Policies for chat_invoice_items

-- Users can view items if they can view the invoice
CREATE POLICY "Users can view invoice items for accessible invoices"
ON chat_invoice_items
FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM chat_invoices
        WHERE id = invoice_id
        AND (vendor_id = auth.uid() OR buyer_id = auth.uid())
    )
);

-- Vendors can insert items to their invoices
CREATE POLICY "Vendors can insert invoice items"
ON chat_invoice_items
FOR INSERT
WITH CHECK (
    EXISTS (
        SELECT 1 FROM chat_invoices
        WHERE id = invoice_id AND vendor_id = auth.uid()
    )
);

-- Vendors can update items in their invoices
CREATE POLICY "Vendors can update invoice items"
ON chat_invoice_items
FOR UPDATE
USING (
    EXISTS (
        SELECT 1 FROM chat_invoices
        WHERE id = invoice_id AND vendor_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM chat_invoices
        WHERE id = invoice_id AND vendor_id = auth.uid()
    )
);

-- Vendors can delete items from their invoices
CREATE POLICY "Vendors can delete invoice items"
ON chat_invoice_items
FOR DELETE
USING (
    EXISTS (
        SELECT 1 FROM chat_invoices
        WHERE id = invoice_id AND vendor_id = auth.uid()
    )
);

-- =============================================================================
-- PART 4: UPDATE ORDERS TABLE FOR INVOICE SOURCE
-- =============================================================================

-- Add source column to orders table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'orders' AND column_name = 'source'
    ) THEN
        ALTER TABLE orders ADD COLUMN source VARCHAR(30) DEFAULT 'regular';
        RAISE NOTICE 'Added source column to orders table';
    END IF;
END $$;

-- Drop existing source constraint if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'orders_source_check'
        AND table_name = 'orders'
    ) THEN
        ALTER TABLE orders DROP CONSTRAINT orders_source_check;
        RAISE NOTICE 'Dropped existing orders_source_check constraint';
    END IF;
END $$;

-- Add source constraint with invoice option
ALTER TABLE orders ADD CONSTRAINT orders_source_check
    CHECK (source IN ('regular', 'live_stream', 'auction', 'service_booking', 'invoice'));

-- Create index on orders.source for analytics queries
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source);

-- Add comment for documentation
COMMENT ON COLUMN orders.source IS 'Order source: regular, live_stream, auction, service_booking, or invoice';

-- =============================================================================
-- PART 5: VERIFY is_rider COLUMN EXISTS
-- =============================================================================

-- Verify is_rider column exists in user_profiles (user added it manually)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_profiles' AND column_name = 'is_rider'
    ) THEN
        RAISE NOTICE 'WARNING: is_rider column does not exist in user_profiles table. Please add it manually: ALTER TABLE user_profiles ADD COLUMN is_rider BOOLEAN DEFAULT FALSE;';
    ELSE
        RAISE NOTICE 'Confirmed: is_rider column exists in user_profiles table';
    END IF;
END $$;

-- =============================================================================
-- SUCCESS MESSAGE
-- =============================================================================

DO $$
BEGIN
    RAISE NOTICE '=============================================================================';
    RAISE NOTICE 'INVOICE SYSTEM MIGRATION COMPLETED SUCCESSFULLY';
    RAISE NOTICE '=============================================================================';
    RAISE NOTICE 'Created tables: chat_invoices, chat_invoice_items';
    RAISE NOTICE 'Created functions: generate_invoice_number(), set_invoice_number()';
    RAISE NOTICE 'Created indexes for performance optimization';
    RAISE NOTICE 'Applied RLS policies for invoice tables';
    RAISE NOTICE 'Updated message_type enum with: call, invoice';
    RAISE NOTICE 'Updated orders table with source column';
    RAISE NOTICE '=============================================================================';
END $$;

COMMIT;
