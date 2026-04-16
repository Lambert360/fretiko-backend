-- Add attachment_url column to support_messages table
ALTER TABLE support_messages 
ADD COLUMN attachment_url TEXT;

-- Add index for better performance if needed
CREATE INDEX idx_support_messages_attachment_url ON support_messages(attachment_url) WHERE attachment_url IS NOT NULL;
