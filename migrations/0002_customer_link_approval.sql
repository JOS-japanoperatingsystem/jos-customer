ALTER TABLE customer_profiles ADD COLUMN approval_key TEXT;

UPDATE customer_profiles
   SET approval_key = lower(hex(randomblob(16)))
 WHERE approval_key IS NULL OR approval_key = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_profiles_approval_key
  ON customer_profiles(approval_key);
