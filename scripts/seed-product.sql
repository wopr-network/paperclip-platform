-- Seed the Paperclip product config.
-- Run after migrations on first deploy or when products table is empty.
-- Idempotent: ON CONFLICT DO UPDATE refreshes all fields.
--
-- Usage:
--   docker exec paperclip-platform-postgres-1 psql -U paperclip -d paperclip_platform -f /scripts/seed-product.sql
--   OR
--   psql "$DATABASE_URL" -f scripts/seed-product.sql

INSERT INTO products (
  slug, brand_name, product_name, tagline, domain, app_domain, cookie_domain,
  company_legal, price_label, default_image, email_support, email_privacy,
  email_legal, from_email, home_path, storage_prefix
) VALUES (
  'paperclip',
  'Paperclip',
  'Paperclip',
  'AI agents that run your business.',
  'runpaperclip.com',
  'app.runpaperclip.com',
  '.runpaperclip.com',
  'Paperclip AI Inc.',
  '$5/month',
  'ghcr.io/wopr-network/paperclip:latest',
  'support@runpaperclip.com',
  'privacy@runpaperclip.com',
  'legal@runpaperclip.com',
  'noreply@runpaperclip.com',
  '/instances',
  'paperclip'
) ON CONFLICT (slug) DO UPDATE SET
  brand_name = EXCLUDED.brand_name,
  product_name = EXCLUDED.product_name,
  tagline = EXCLUDED.tagline,
  domain = EXCLUDED.domain,
  app_domain = EXCLUDED.app_domain,
  cookie_domain = EXCLUDED.cookie_domain,
  company_legal = EXCLUDED.company_legal,
  price_label = EXCLUDED.price_label,
  default_image = EXCLUDED.default_image,
  email_support = EXCLUDED.email_support,
  email_privacy = EXCLUDED.email_privacy,
  email_legal = EXCLUDED.email_legal,
  from_email = EXCLUDED.from_email,
  home_path = EXCLUDED.home_path,
  storage_prefix = EXCLUDED.storage_prefix,
  updated_at = now();
