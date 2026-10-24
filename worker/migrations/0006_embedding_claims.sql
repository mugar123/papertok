-- Until when an embedding pass holds the work (paper-store.ts `claimUnembedded`):
-- passes that overlap (the daily run, a followed lanes' run, a reader's lookup)
-- never embed one paper twice.
ALTER TABLE works ADD COLUMN embedding_claimed_until TEXT;
