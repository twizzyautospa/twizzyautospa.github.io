-- Each installer can bring their own Google AI key for lighting previews, so the images are billed to them.
-- The key is stored encrypted and is never sent back to a browser.
ALTER TABLE installers ADD COLUMN preview_key TEXT;

-- How many preview images each installer made per calendar month, and how many of those ran on the platform's
-- own AI allowance instead of the installer's key.
CREATE TABLE preview_usage (
  installer_id TEXT NOT NULL REFERENCES installers(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  images INTEGER NOT NULL DEFAULT 0,
  platform_images INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installer_id, month)
);
