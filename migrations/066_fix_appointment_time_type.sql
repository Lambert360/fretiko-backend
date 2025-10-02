-- Fix appointment_time column to accept formatted time strings like "2:43 AM"
ALTER TABLE chat_invoice_items 
ALTER COLUMN appointment_time TYPE VARCHAR(50);
