/**
 * Copyright (c) 2026 Amar Micro Inc. Licensed under MIT; see LICENSE.
 * Designer: Jacques Amar
 * Release version: 0.5.8
 * Last updated: 2026-11-11
 *
 * Filesystem cleanup policy for VS Code Stable servers on a Linux SSH host.
 * Scan validated installations, keep the newest release and active resources,
 * and classify the rest as removable or requiring review. Apply rescans the
 * approved plan, backs up and replaces existing LRU metadata, then checks each
 * resource for activity before deleting it. Launchers and server folders have
 * independent protection; cleanup can stop after partial removal.
 */

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const SHA = "[a-f0-9]{40}";

async function stat(p) {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Reject symlinks and non-directories at every validated path component.
async function directory(p) {
  const s = await stat(p);
  if (!s?.isDirectory() || s.isSymbolicLink())
    throw new Error(`Unsafe directory: ${p}`);
}

// Read metadata only from regular files, never through a symlink.
async function json(p) {
  const s = await stat(p);
  if (!s?.isFile() || s.isSymbolicLink())
    throw new Error(`Unsafe metadata: ${p}`);
  return JSON.parse(await fs.readFile(p, "utf8"));
}

// Compare validated major.minor.patch server versions numerically.
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    const n = Number(a.split(".")[i]) - Number(b.split(".")[i]);
    if (n) return n;
  }
  return 0;
}

// Extract kind:commit resource keys from process paths. An old launcher may
// run a newer server, so launcher activity must not protect its matching folder.
function processReferences(cmd, exe = "") {
  const refs = new Set();
  const text = `${cmd}\0${exe}`;
  for (const [kind, prefix] of [
    ["server", "/cli/servers/Stable-"],
    ["legacy", "/bin/"],
    ["launcher", "/code-"],
  ]) {
    for (const m of text.matchAll(
      new RegExp(`${prefix}(${SHA})(?=[/\\s\\x00]|$)`, "g"),
    ))
      refs.add(`${kind}:${m[1]}`);
  }
  return refs;
}

// Inspect Linux processes on this server owned by the current account. Exited
// processes are harmless; unreadable owned command lines abort cleanup because
// active resources cannot be ruled out.
async function activeCommits() {
  const active = new Set();
  for (const pid of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const base = `/proc/${pid}`;
    const s = await stat(base);
    if (!s || s.uid !== process.getuid()) continue;
    try {
      const cmd = await fs.readFile(`${base}/cmdline`, "utf8");
      let exe = "";
      try {
        exe = await fs.readlink(`${base}/exe`);
      } catch (e) {
        if (!["ENOENT", "EACCES"].includes(e.code)) throw e;
      }
      for (const ref of processReferences(cmd, exe)) active.add(ref);
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ESRCH")
        throw new Error(`Cannot inspect process ${pid}: ${e.message}`);
    }
  }
  return active;
}

// Build a read-only plan from validated metadata and supplied active resource keys.
// Unknown launcher/legacy entries remain REVIEW; LRU contains kept servers only.
async function scan(root, active = new Set()) {
  root = path.resolve(root);

  // Validate every ancestor so a symlink cannot redirect cleanup outside the chosen root.
  for (let p = root; ; p = path.dirname(p)) {
    await directory(p);
    if (path.dirname(p) === p) break;
  }

  const servers = path.join(root, "cli", "servers");
  await directory(path.join(root, "cli"));
  await directory(servers);

  const installs = [];
  for (const name of await fs.readdir(servers)) {
    if (!name.startsWith("Stable-")) continue;
    if (!new RegExp(`^Stable-${SHA}$`).test(name))
      throw new Error(`Unknown server name: ${name}`);
    const dir = path.join(servers, name);
    await directory(dir);
    await directory(path.join(dir, "server"));
    const meta = await json(path.join(dir, "server", "product.json"));
    if (!/^\d+\.\d+\.\d+$/.test(meta.version) || meta.commit !== name.slice(7))
      throw new Error(`Invalid metadata: ${dir}`);
    installs.push({ commit: meta.commit, version: meta.version, path: dir });
  }
  if (!installs.length)
    throw new Error("No supported Stable server installations found.");

  installs.sort((a, b) => compare(b.version, a.version));
  const newest = installs[0];

  // Preserve all commits tied for newest, plus installed servers whose files are in use.
  const newestCommits = new Set(
    installs
      .filter((x) => compare(x.version, newest.version) === 0)
      .map((x) => x.commit),
  );
  const keep = new Set([
    ...newestCommits,
    ...installs
      .filter((x) => active.has(`server:${x.commit}`))
      .map((x) => x.commit),
  ]);

  const items = installs.map((x) => ({
    ...x,
    kind: "server",
    action: keep.has(x.commit) ? "KEEP" : "DELETE",
    reason: newestCommits.has(x.commit)
      ? "newest server"
      : active.has(`server:${x.commit}`)
        ? "server files in use"
        : "obsolete server",
  }));

  for (const name of await fs.readdir(root)) {
    if (!name.startsWith("code-")) continue;
    const p = path.join(root, name),
      s = await stat(p),
      commit = name.slice(5);
    items.push({
      path: p,
      kind: "launcher",
      reason: newestCommits.has(commit)
        ? "newest launcher"
        : active.has(`launcher:${commit}`)
          ? "launcher running (does not protect matching server folder)"
          : "obsolete launcher (not newest or running)",
      action:
        !new RegExp(`^${SHA}$`).test(commit) ||
        !s?.isFile() ||
        s.isSymbolicLink()
          ? "REVIEW"
          : newestCommits.has(commit) || active.has(`launcher:${commit}`)
            ? "KEEP"
            : "DELETE",
    });
  }

  const bin = path.join(root, "bin");
  if (await stat(bin)) {
    await directory(bin);
    for (const name of await fs.readdir(bin)) {
      const p = path.join(bin, name),
        s = await stat(p);
      items.push({
        path: p,
        kind: "legacy",
        reason: active.has(`legacy:${name}`)
          ? "legacy server files in use"
          : "legacy installation",
        action:
          newestCommits.has(name) || active.has(`legacy:${name}`)
            ? "KEEP"
            : installs.some((x) => x.commit === name) &&
                s?.isDirectory() &&
                !s.isSymbolicLink()
              ? "DELETE"
              : "REVIEW",
      });
    }
  }

  const lru = path.join(servers, "lru.json");
  let current = null;
  if (await stat(lru)) {
    current = await json(lru);
    if (
      !Array.isArray(current) ||
      !current.every(
        (x) => typeof x === "string" && new RegExp(`^Stable-${SHA}$`).test(x),
      )
    )
      throw new Error("Unrecognized lru.json format");
  }

  const desired = installs
    .filter((x) => keep.has(x.commit))
    .map((x) => `Stable-${x.commit}`);
  return {
    root,
    items,
    newest,
    keep: [...keep].sort(),
    active: [...active].sort(),
    lru,
    current,
    desired,
  };
}

// Compare the complete scan result so a changed preview requires fresh review.
function signature(plan) {
  return JSON.stringify(plan);
}

// Apply only an unchanged, caller-confirmed plan. LRU replacement precedes removal;
// per-resource checks reduce races but provide no installer lock or rollback.
// getActive is injectable so tests can simulate activity without real processes.
async function apply(plan, getActive = activeCommits) {
  const fresh = await scan(plan.root, await getActive());
  if (signature(plan) !== signature(fresh))
    throw new Error(
      "Installations or running sessions changed. Preview again.",
    );

  if (
    fresh.current &&
    JSON.stringify(fresh.current) !== JSON.stringify(fresh.desired)
  ) {
    const backup = `${fresh.lru}.bak.${Date.now()}`;
    await fs.copyFile(
      fresh.lru,
      backup,
      require("node:fs").constants.COPYFILE_EXCL,
    );
    const temp = `${fresh.lru}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fs.writeFile(temp, JSON.stringify(fresh.desired) + "\n", {
        flag: "wx",
        mode: (await fs.stat(fresh.lru)).mode & 0o777,
      });
      await fs.rename(temp, fresh.lru);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  const deleted = [];
  for (const item of fresh.items.filter((x) => x.action === "DELETE")) {
    const active = await getActive();
    const commit = path.basename(item.path).replace(/^(Stable-|code-)/, "");
    if (active.has(`${item.kind}:${commit}`))
      throw new Error(
        `Version became active; stopped before deleting ${item.path}`,
      );
    await directory(path.dirname(item.path));
    const s = await stat(item.path);
    if (!s || s.isSymbolicLink())
      throw new Error(`Entry changed: ${item.path}`);
    await fs.rm(item.path, { recursive: s.isDirectory(), force: false });
    deleted.push(item.path);
  }
  return deleted;
}

module.exports = { scan, apply, activeCommits, processReferences, signature };
