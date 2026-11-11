-- Installers sign in with a username taken from their business name, not an email address.
ALTER TABLE installers ADD COLUMN username TEXT;

UPDATE installers SET username = left(regexp_replace(lower(company_name), '[^a-z0-9]', '', 'g'), 40);

-- Two businesses with the same name get a number added.
UPDATE installers i SET username = left(i.username, 36) || d.n
FROM (SELECT id, row_number() OVER (PARTITION BY username ORDER BY created_at, id) AS n FROM installers) d
WHERE d.id = i.id AND d.n > 1;

UPDATE installers SET username = 'installer' || left(replace(id, '-', ''), 10) WHERE length(username) < 3;

ALTER TABLE installers ALTER COLUMN username SET NOT NULL;
CREATE UNIQUE INDEX installers_username_idx ON installers (username);

-- Email becomes an optional contact detail. Placeholder addresses are cleared.
ALTER TABLE installers ALTER COLUMN email DROP NOT NULL;
UPDATE installers SET email = NULL WHERE email LIKE '%.invalid';

-- Lockouts were keyed by email. Start clean.
DELETE FROM login_attempts;
