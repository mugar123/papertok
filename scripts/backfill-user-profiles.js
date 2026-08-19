#!/usr/bin/env node
/**
 * Backfills users/{uid}/aggregates/interactions for accounts created before the
 * aggregate existed.
 *
 * Running this is optional. The app rebuilds a missing aggregate on its own the
 * first time an account loads the feed, capped at REBUILD_MAX_DOCUMENTS
 * documents. This script exists to move that one-off cost off the users'
 * sessions and to build complete profiles for accounts whose history is over
 * that cap, since the Admin SDK is not paying for a user's page load.
 *
 * It shares the exact aggregation code the browser uses, so a backfilled
 * profile is byte-identical to one the client would have produced.
 *
 * See scripts/README-backfill-user-profiles.md before running.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

import {
  INTERACTION_PROFILE_SCHEMA_VERSION,
  buildProfileFromInteractionDocuments,
  serializeInteractionProfile,
} from '../src/utils/interactionProfile.js';

const DEFAULT_CHECKPOINT = '.backfill-user-profiles.json';
const USER_PAGE_SIZE = 200;
const INTERACTION_PAGE_SIZE = 500;

function parseArguments(argv) {
  const options = {
    dryRun: false,
    checkpointPath: DEFAULT_CHECKPOINT,
    force: false,
    limit: Infinity,
    maxInteractions: Infinity,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--checkpoint') options.checkpointPath = argv[++index];
    else if (argument === '--limit') options.limit = Number(argv[++index]);
    else if (argument === '--max-interactions') options.maxInteractions = Number(argv[++index]);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/backfill-user-profiles.js [options]

  --dry-run                 Read and aggregate, report what would change, write nothing.
  --force                   Rebuild even for users that already have a current aggregate.
  --checkpoint <path>       Resume file (default: ${DEFAULT_CHECKPOINT}).
  --limit <n>               Stop after n users.
  --max-interactions <n>    Cap the interaction documents read per user.
  -h, --help                Show this message.

Credentials come from GOOGLE_APPLICATION_CREDENTIALS. This script never reads a
service account key from an argument and never prints one.`);
}

function loadCheckpoint(path) {
  if (!existsSync(path)) return { lastUserId: null, processed: 0, skipped: 0, failed: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.warn(`Ignoring unreadable checkpoint at ${path}; starting from the beginning.`);
    return { lastUserId: null, processed: 0, skipped: 0, failed: [] };
  }
}

function saveCheckpoint(path, checkpoint) {
  const directory = dirname(path);
  if (directory && directory !== '.' && !existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function readAllInteractions(firestore, userId, maxInteractions) {
  const collection = firestore.collection('users').doc(userId).collection('interactions');
  const documents = [];
  let cursor = null;
  let truncated = false;

  for (;;) {
    if (documents.length >= maxInteractions) {
      truncated = true;
      break;
    }
    let pageQuery = collection
      .orderBy('__name__')
      .limit(Math.min(INTERACTION_PAGE_SIZE, maxInteractions - documents.length));
    if (cursor) pageQuery = pageQuery.startAfter(cursor);

    const snapshot = await pageQuery.get();
    if (snapshot.empty) break;
    snapshot.docs.forEach(item => documents.push({ id: item.id, data: item.data() }));
    cursor = snapshot.docs[snapshot.docs.length - 1].id;
    if (snapshot.size < INTERACTION_PAGE_SIZE) break;
  }

  // The aggregate keeps its exact id lists in recency order so the oldest
  // entries are the ones that overflow into the Bloom filter.
  documents.sort((a, b) => {
    const left = Date.parse(a.data?.timestamp || a.data?.libraryUpdatedAt || '') || 0;
    const right = Date.parse(b.data?.timestamp || b.data?.libraryUpdatedAt || '') || 0;
    return right - left;
  });
  return { documents, truncated };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at your service account key file;\n'
      + 'see scripts/README-backfill-user-profiles.md.',
    );
    process.exitCode = 1;
    return;
  }

  const { default: admin } = await import('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const firestore = admin.firestore();

  const checkpoint = loadCheckpoint(options.checkpointPath);
  console.log(
    `Backfill starting${options.dryRun ? ' (dry run, nothing will be written)' : ''}`
    + `${checkpoint.lastUserId ? ` — resuming after ${checkpoint.lastUserId}` : ''}`,
  );

  let cursor = checkpoint.lastUserId;
  let handledThisRun = 0;

  outer: for (;;) {
    let usersQuery = firestore.collection('users').orderBy('__name__').limit(USER_PAGE_SIZE);
    if (cursor) usersQuery = usersQuery.startAfter(cursor);
    const users = await usersQuery.get();
    if (users.empty) break;

    for (const userDoc of users.docs) {
      const userId = userDoc.id;
      cursor = userId;

      if (handledThisRun >= options.limit) {
        console.log(`Reached --limit ${options.limit}.`);
        break outer;
      }

      try {
        const aggregateRef = userDoc.ref.collection('aggregates').doc('interactions');
        if (!options.force) {
          const existing = await aggregateRef.get();
          if (
            existing.exists
            && existing.data()?.schemaVersion === INTERACTION_PROFILE_SCHEMA_VERSION
          ) {
            checkpoint.skipped += 1;
            checkpoint.lastUserId = userId;
            saveCheckpoint(options.checkpointPath, checkpoint);
            continue;
          }
        }

        const { documents, truncated } = await readAllInteractions(
          firestore,
          userId,
          options.maxInteractions,
        );
        const profile = buildProfileFromInteractionDocuments(documents);
        profile.truncated = truncated;
        const payload = serializeInteractionProfile(profile);

        if (options.dryRun) {
          console.log(
            `[dry-run] ${userId}: ${documents.length} interactions -> `
            + `${payload.affinities.length + payload.curated.length + (payload.seenFilter?.length || 0)} bytes`
            + `${truncated ? ' (truncated)' : ''}`,
          );
        } else {
          await aggregateRef.set(payload);
          console.log(`${userId}: ${documents.length} interactions aggregated${truncated ? ' (truncated)' : ''}`);
        }

        checkpoint.processed += 1;
        handledThisRun += 1;
      } catch (error) {
        console.error(`${userId}: FAILED — ${error.message}`);
        checkpoint.failed = [...new Set([...(checkpoint.failed || []), userId])];
      }

      checkpoint.lastUserId = userId;
      saveCheckpoint(options.checkpointPath, checkpoint);
    }

    if (users.size < USER_PAGE_SIZE) break;
  }

  console.log(
    `Done. processed=${checkpoint.processed} skipped=${checkpoint.skipped} `
    + `failed=${(checkpoint.failed || []).length}`,
  );
  if ((checkpoint.failed || []).length) {
    console.log(`Failed user ids: ${checkpoint.failed.join(', ')}`);
    console.log('Re-run the script; it retries them and skips everything already done.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
