-- Migration: Create Chat Invoices System
-- Date: 2025-10-01
-- Description: Enable vendors and riders to create invoices in chat for private transactions

BEGIN;

-- Create chat_invoices table
CREATE TABLE IF NOT EXISTS chat_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    vendor_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    total_amount DECIMAL(18,6) NOT NULL CHECK (total_amount > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create chat_invoice_items table
CREATE TABLE IF NOT EXISTS chat_invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES chat_invoices(id) ON DELETE CASCADE,
    item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('product', 'service')),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(18,6) NOT NULL CHECK (price > 0),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    total_price DECIMAL(18,6) NOT NULL CHECK (total_price > 0),
    image_url TEXT,
    appointment_date TIMESTAMP WITH TIME ZONE,
    appointment_time VARCHAR(50),
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    service_id UUID REFERENCES services(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_chat_invoices_conversation_id ON chat_invoices(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_message_id ON chat_invoices(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_vendor_id ON chat_invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_buyer_id ON chat_invoices(buyer_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_status ON chat_invoices(status);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_expires_at ON chat_invoices(expires_at);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_order_id ON chat_invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoices_created_at ON chat_invoices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_invoice_items_invoice_id ON chat_invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoice_items_product_id ON chat_invoice_items(product_id);
CREATE INDEX IF NOT EXISTS idx_chat_invoice_items_service_id ON chat_invoice_items(service_id);

-- Function to generate invoice number
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS VARCHAR(50) AS $$
DECLARE
    new_number VARCHAR(50);
    max_number INTEGER;
BEGIN
    -- Get the current max invoice number for today
    SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 10) AS INTEGER)), 0)
    INTO max_number
    FROM chat_invoices
    WHERE invoice_number LIKE 'INV-' || TO_CHAR(NOW(), 'YYYY-MM-DD') || '-%';

    -- Generate new invoice number
    new_number := 'INV-' || TO_CHAR(NOW(), 'YYYY-MM-DD') || '-' || LPAD((max_number + 1)::TEXT, 5, '0');

    RETURN new_number;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate invoice number
CREATE OR REPLACE FUNCTION set_invoice_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invoice_number IS NULL OR NEW.invoice_number = '' THEN
        NEW.invoice_number := generate_invoice_number();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_set_invoice_number
    BEFORE INSERT ON chat_invoices
    FOR EACH ROW
    EXECUTE FUNCTION set_invoice_number();

-- Trigger to update updated_at timestamp
CREATE TRIGGER update_chat_invoices_updated_at
    BEFORE UPDATE ON chat_invoices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_invoices TO authenticated;
GRANT SELECT, INSERT, DELETE ON chat_invoice_items TO authenticated;

-- Service role needs full access
GRANT ALL ON chat_invoices TO service_role;
GRANT ALL ON chat_invoice_items TO service_role;

COMMIT;
