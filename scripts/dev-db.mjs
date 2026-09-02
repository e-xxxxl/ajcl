/**
 * Local development database.
 *
 * Starts a standalone MongoDB (binary downloaded + cached once by
 * mongodb-memory-server) and keeps it running:
 *
 *   npm run db          # terminal 1 - prints a mongodb:// URI and waits
 *   # copy the URI into .env.local as MONGODB_URI, then:
 *   npm run dev         # terminal 2
 *
 * Data lives under .dev-db/ and survives restarts. The script pins MongoDB 7.0
 * (8.x needs a newer VC++ runtime than many Windows 10 boxes have), kills
 * orphaned mongod processes, clears stale locks, and - if the data directory is
 * corrupted by an unclean shutdown (mongod exit code 14 / 100 / 62) - wipes it
 * and retries automatically.
 *
 *   DEV_DB_FRESH=1 npm run db                 # force a clean data directory
 *   DEV_DB_PORT=27018 npm run db              # different port (default 27017)
 *   DEV_DB_MONGO_VERSION=6.0.14 npm run db    # pin a different MongoDB build
 *   DEV_DB_LAUNCH_TIMEOUT=120000 npm run db   # allow a slower cold start (ms)
 *   MONGOMS_DEBUG=1 npm run db                # verbose logs
 *
 * If the bundled mongod can't run on this machine at all, use MongoDB Atlas
 * (free) and set MONGODB_URI to its connection string instead.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { existsSync, mkdirSync, rmSync, readdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const dbPath = resolve(process.cwd(), ".dev-db");
const port = Number(process.env.DEV_DB_PORT || 27017);

/* ── helpers ─────────────────────────────────────────────────────────────── */

function wipeDataDir() {
  try {
    rmSync(dbPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  mkdirSync(dbPath, { recursive: true });
}

/** Remove stale WiredTiger / mongod lock files left by a hard kill. */
function clearStaleLocks() {
  if (!existsSync(dbPath)) return;
  for (const name of readdirSync(dbPath)) {
    if (name === "mongod.lock" || name === "WiredTiger.lock") {
      try {
        unlinkSync(join(dbPath, name));
      } catch {
        /* held open -> a mongod is probably still running */
      }
    }
  }
}

function portFree(p) {
  return new Promise((res) => {
    const tester = net
      .createServer()
      .once("error", () => res(false))
      .once("listening", () => tester.close(() => res(true)))
      .listen(p, "127.0.0.1");
  });
}

/** Wait until `p` is free, up to `timeoutMs` (a crashed mongod's socket can linger in TIME_WAIT). */
async function waitForPortFree(p, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(p)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Kill any mongod binary started by mongodb-memory-server that's still running.
 * This script is the sole owner of the dev DB, so such a process is always an
 * orphan from a previous run that didn't shut down cleanly. The binary name is
 * always `mongod-*` regardless of where the cache lives.
 */
function killStaleMongo() {
  try {
    if (process.platform === "win32") {
      // `mongod-x64-win32-*.exe` is the mongodb-memory-server binary name; a
      // system-installed MongoDB service is plain `mongod.exe` and is left alone.
      execSync('taskkill /F /T /IM "mongod-x64-win32-*.exe"', {
        stdio: "ignore",
        timeout: 15_000,
      });
    } else {
      execSync("pkill -f 'mongodb-binaries.*mongod|mongodb-memory-server.*mongod' 2>/dev/null || true", {
        stdio: "ignore",
        timeout: 15_000,
      });
    }
  } catch {
    /* best effort — taskkill exits non-zero when nothing matches */
  }
}

/** Errors that a wipe + retry can plausibly fix. */
function isRetryable(err) {
  const msg = String(err?.message ?? err);
  return (
    /code "?(14|100|62)"?/.test(msg) || // 14 startup, 100 unclean data, 62 version
    /DBPathInUse|WiredTiger|Unclean/i.test(msg) ||
    /failed to start within|Exited before being ready/i.test(msg) // slow / flaky boot
  );
}

/** mongod on a cold, AV-heavy Windows box can take well over the 10s default. */
const LAUNCH_TIMEOUT = Number(process.env.DEV_DB_LAUNCH_TIMEOUT || 60_000);

/**
 * Pin the MongoDB binary. mongodb-memory-server defaults to 8.x, which needs a
 * newer VC++ runtime / OS build than many Windows 10 machines have and fails
 * with exit code 14 or 4294967295. 7.0.x runs cleanly on Windows 10 x64.
 * Override with DEV_DB_MONGO_VERSION if you need a specific build.
 */
const MONGO_VERSION = process.env.DEV_DB_MONGO_VERSION || "7.0.14";

function startMongo() {
  return MongoMemoryServer.create({
    binary: { version: MONGO_VERSION },
    instance: {
      port,
      dbPath,
      storageEngine: "wiredTiger",
      dbName: "ajcl",
      launchTimeout: LAUNCH_TIMEOUT,
    },
  });
}

function banner(uri) {
  const line = `  MONGODB_URI=${uri}`;
  console.log(`\n${"-".repeat(Math.max(line.length + 2, 56))}`);
  console.log("  Local MongoDB is running");
  console.log(line);
  console.log("-".repeat(Math.max(line.length + 2, 56)));
  console.log("\n  Put that line in backend/.env, then run `npm run dev`.");
  console.log("  Press Ctrl+C to stop.\n");
}

/* ── boot ────────────────────────────────────────────────────────────────── */

if (process.env.DEV_DB_FRESH === "1") {
  console.log("  DEV_DB_FRESH=1 - starting with an empty data directory.");
  wipeDataDir();
} else {
  mkdirSync(dbPath, { recursive: true });
}

// Clear anything left over from a previous run before we start.
killStaleMongo();
clearStaleLocks();

if (!(await portFree(port))) {
  console.log(`  Port ${port} is busy - waiting for a stale server to release it...`);
  if (!(await waitForPortFree(port))) {
    console.error(
      `\n  x Port ${port} is still in use by another process (not ours).\n` +
        `    Stop whatever is on it, or use another port:\n` +
        `      DEV_DB_PORT=27018 npm run db\n`,
    );
    process.exit(1);
  }
}

function atlasHint() {
  return (
    "\n  The local mongod binary won't run on this machine. Easiest fix:\n" +
    "  use a free MongoDB Atlas cluster instead -\n" +
    "    1. https://www.mongodb.com/cloud/atlas/register  (free M0 tier)\n" +
    "    2. copy its connection string into .env.local as MONGODB_URI\n" +
    "    3. skip `npm run db` - just run `npm run dev`\n\n" +
    "  To keep trying locally: install the Microsoft Visual C++ Redistributable\n" +
    "  (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe, or pin an older\n" +
    "  build with  DEV_DB_MONGO_VERSION=6.0.14 npm run db\n"
  );
}

let mongod;
try {
  mongod = await startMongo();
} catch (err) {
  const msg = String(err?.message ?? err);
  // 4294967295 / huge exit codes = missing VC++ runtime - a retry can't fix it.
  if (/4294967295|vc_redist|large, commonly/i.test(msg)) {
    console.error("\n  x MongoDB failed to start (missing system runtime).\n" + atlasHint(), err);
    process.exit(1);
  }
  if (!isRetryable(err)) {
    console.error(
      "\n  x MongoDB failed to start.\n" +
        "    Re-run with MONGOMS_DEBUG=1 npm run db for details.\n" +
        atlasHint(),
      err,
    );
    process.exit(1);
  }

  console.warn(
    "\n  ! MongoDB did not start cleanly (corrupted data dir or a slow boot).\n" +
      "    Wiping .dev-db/ and retrying...\n",
  );
  wipeDataDir();
  killStaleMongo();
  clearStaleLocks();
  // The failed mongod's socket can sit in TIME_WAIT - wait it out so the retry
  // reuses the same port instead of falling back to a random one.
  await waitForPortFree(port, 60_000);

  let lastErr;
  for (let attempt = 1; attempt <= 2 && !mongod; attempt += 1) {
    try {
      mongod = await startMongo();
    } catch (retryErr) {
      lastErr = retryErr;
      if (attempt < 2) {
        wipeDataDir();
        killStaleMongo();
        await waitForPortFree(port, 60_000);
      }
    }
  }

  if (!mongod) {
    console.error(
      "\n  x MongoDB still failed to start after retries.\n" + atlasHint(),
      lastErr,
    );
    process.exit(1);
  }
}

const uri = mongod.getUri("ajcl");
banner(uri);

if (new URL(uri).port !== String(port)) {
  console.warn(
    `  Note: port ${port} was busy, so MongoDB started on ${new URL(uri).port} instead.\n` +
      `  Use exactly the URI printed above.\n`,
  );
}

/* ── keep alive + graceful shutdown ─────────────────────────────────────── */

// In a non-TTY (npm script) the signal listeners alone won't hold the event
// loop open - this heartbeat does.
const heartbeat = setInterval(() => {}, 1 << 30);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  console.log(`\n  Stopping local MongoDB${signal ? ` (${signal})` : ""}...`);
  try {
    await mongod.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
