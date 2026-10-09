#!/usr/bin/env node
// Runs the full Jest suite behind an exclusive lock and a hard timeout, so two full suites never
// compete for the CPU and a hung run can't block anyone for an hour. Plain Node, no packages.
//   node scripts/run-tests.mjs [jest args...]      (npm run test:full)
//
// - Lock: `.test-lock/` (mkdir is atomic). A lock older than 30 min, or whose owner pid is dead,
//   is stale and gets taken over.
// - Waits up to 20 min for a running suite instead of competing with it.
// - Kills jest (whole process group) with a clear error if it runs longer than 25 min.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockDir = path.join(root, ".test-lock");
const pidFile = path.join(lockDir, "pid");
const STALE_MS = 30 * 60_000;
const WAIT_MS = 20 * 60_000;
const RUN_MS = 25 * 60_000;
const POLL_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function isStale() {
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs > STALE_MS) return true;
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    return Number.isInteger(pid) && pid > 0 && !alive(pid);
  } catch {
    return false; // being created or released right now: just retry
  }
}

function tryLock() {
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(pidFile, String(process.pid));
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return false;
  }
}

function unlock() {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

async function acquire() {
  const start = Date.now();
  let announced = false;
  while (!tryLock()) {
    if (isStale()) {
      console.error(
        "[test:full] taking over a stale lock (older than 30 min or owner gone)",
      );
      unlock();
      continue;
    }
    if (Date.now() - start > WAIT_MS) {
      console.error(
        "[test:full] ERROR: waited 20 min for another full suite to finish. Giving up.",
      );
      process.exit(2);
    }
    if (!announced) {
      console.error(
        "[test:full] another full suite is running; waiting for it (max 20 min)...",
      );
      announced = true;
    }
    await sleep(POLL_MS);
  }
}

await acquire();

let child;
let timedOut = false;
const killTree = (signal) => {
  try {
    process.kill(-child.pid, signal); // jest + its workers (own process group)
  } catch {
    child.kill(signal);
  }
};
const release = () => unlock();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (child) killTree("SIGTERM");
    release();
    process.exit(130);
  });
}

const jestBin = path.join(root, "node_modules", "jest", "bin", "jest.js");
child = spawn(
  process.execPath,
  [...process.execArgv, jestBin, "--ci", ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
    detached: true,
  },
);
const timer = setTimeout(() => {
  timedOut = true;
  console.error(
    "\n[test:full] ERROR: jest ran longer than 25 min (hung?). Killing it.",
  );
  killTree("SIGTERM");
  setTimeout(() => killTree("SIGKILL"), 5_000).unref();
}, RUN_MS);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  release();
  if (timedOut) process.exit(124);
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (err) => {
  clearTimeout(timer);
  release();
  console.error("[test:full] failed to start jest:", err.message);
  process.exit(1);
});
