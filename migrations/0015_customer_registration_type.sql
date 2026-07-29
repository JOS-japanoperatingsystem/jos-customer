ALTER TABLE customer_profiles
ADD COLUMN registration_type TEXT NOT NULL DEFAULT 'existing';

ALTER TABLE customer_profiles
ADD COLUMN customer_type TEXT NOT NULL DEFAULT '';

ALTER TABLE customer_profiles
ADD COLUMN birthday TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_customer_profiles_registration_type
ON customer_profiles(link_status, registration_type, created_at);
