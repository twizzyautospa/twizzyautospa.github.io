-- Rename the platform from the placeholder name to Lumiquote where the old name was saved.
UPDATE app_settings SET value = jsonb_set(value, '{name}', '"Lumiquote"'::jsonb)
WHERE key = 'platform' AND value->>'name' = 'Lumaquote';
