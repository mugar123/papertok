# Backfill: user interaction profiles

`scripts/backfill-user-profiles.js` builds `users/{uid}/aggregates/interactions`
for accounts that predate that document.

**Running it is optional.** The app rebuilds a missing or outdated aggregate by
itself, once per account, the first time it loads the feed — capped at 5.000
interaction documents. This script only exists to move that one-off cost off
your users' sessions, and to build *complete* profiles for any account whose
history is over that cap.

If you never run it, nothing breaks.

## What it does

For every document under `users/`:

1. Skips the user if they already have an aggregate at the current schema
   version (unless `--force`).
2. Pages through `users/{uid}/interactions` ordered by document id.
3. Builds the aggregate with the same code the browser uses
   (`src/utils/interactionProfile.js`), so the result is identical to what the
   client would have written.
4. Writes it to `users/{uid}/aggregates/interactions`.

It **never deletes or modifies** any interaction document. The subcollection
stays the source of truth.

## Before running

```bash
npm install --no-save firebase-admin
```

`firebase-admin` is deliberately not a project dependency — it is a server-side
SDK and has no business in the browser bundle. `--no-save` keeps it out of
`package.json`.

## Credentials

The script reads credentials from `GOOGLE_APPLICATION_CREDENTIALS` and nothing
else. It never takes a key as an argument and never prints one.

1. Firebase console → Project settings → Service accounts → *Generate new
   private key*. This downloads a JSON file.
2. Store it outside the repository. `.gitignore` does not cover it and a
   committed service account key is a full project compromise.
3. Export the path in the shell you run the script from:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.papertok/service-account.json"
```

Delete the key from the Firebase console once the backfill is done.

## Running it

Always start with a dry run. It reads and aggregates but writes nothing:

```bash
node scripts/backfill-user-profiles.js --dry-run
```

Then a small live batch to confirm the writes look right:

```bash
node scripts/backfill-user-profiles.js --limit 5
```

Then the rest:

```bash
node scripts/backfill-user-profiles.js
```

## Resuming

Progress goes to `.backfill-user-profiles.json` after every user. If the script
is interrupted, run the same command again and it picks up after the last user
it finished. Users that errored are listed in the checkpoint under `failed` and
are retried on the next run.

To start over from scratch, delete the checkpoint file.

## Options

| Flag | Effect |
| --- | --- |
| `--dry-run` | Aggregate and report, write nothing. |
| `--force` | Rebuild even for users that already have a current aggregate. |
| `--checkpoint <path>` | Use a different resume file. |
| `--limit <n>` | Stop after `n` users this run. |
| `--max-interactions <n>` | Cap interaction documents read per user. |
| `-h`, `--help` | Usage. |

## Cost

One read per interaction document, plus one read and one write per user. This is
the same total the app would have paid across users' own sessions; running it
here just makes it a single predictable batch. Use `--limit` to spread it across
days if you want to stay inside the free tier's daily allowance.

## Schema changes

The aggregate carries `schemaVersion`. When the format changes, bump
`INTERACTION_PROFILE_SCHEMA_VERSION` in `src/utils/interactionProfile.js`. Every
client then treats its stored aggregate as unreadable and rebuilds it once, so
running this script after a bump is again optional.
