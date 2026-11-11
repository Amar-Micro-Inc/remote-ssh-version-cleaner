/**
 * Copyright (c) 2026 Amar Micro Inc. Licensed under MIT; see LICENSE.
 * Designer: Jacques Amar
 * Release version: 0.5.7
 * Last updated: 2026-11-10
 *
 * Remote SSH extension entry point and cleanup review UI.
 * A read-only startup scan updates the status button. Opening the view scans
 * again; review and explicit confirmation lead to cleaner.apply(), followed by
 * a fresh scan of remaining entries. The extension host owns cleanup and state;
 * the webview only displays results and sends button actions.
 */

"use strict";

const vscode = require("vscode");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const cleaner = require("./cleaner");

const appIcon =
  "data:image/png;base64," +
  require("node:fs")
    .readFileSync(path.join(__dirname, "..", "assets", "cleaner-icon.png"))
    .toString("base64");

// Load once and embed in the nonce-protected style block; no webview file access is needed.
const webviewCss = require("node:fs").readFileSync(
  path.join(__dirname, "..", "assets", "webview.css"),
  "utf8",
);

// Escape host metadata and paths before inserting them into webview HTML.
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Summarize each resource independently: running old entries do not block
// cleanup of other obsolete entries. Review entries remain outside deletion.
function inventorySummary(plan) {
  const counts = (items) => [
    ["server", "server folder"],
    ["launcher", "launcher file"],
    ["legacy", "legacy folder"],
  ].map(([kind, label]) => {
    const count = items.filter((item) => item.kind === kind).length;
    return `${count} ${label}${count === 1 ? "" : "s"}`;
  }).join(" · ");
  const removable = plan.items.filter((item) => item.action === "DELETE");
  const running = plan.items.filter((item) => item.action === "KEEP" &&
    ["server files in use", "legacy server files in use",
      "launcher running (does not protect matching server folder)"].includes(item.reason));
  const review = plan.items.filter((item) => item.action === "REVIEW");
  const messages = [removable.length
    ? `Available to remove: ${counts(removable)}. Review and confirm cleanup.`
    : "No entries are currently removable."];
  if (running.length) {
    messages.push(`Older entries protected by running processes: ${counts(running)}.`);
    messages.push("A running process does not necessarily mean a VS Code window is connected. These entries are preserved; other removable entries can still be cleaned. Refresh after the old processes exit.");
  }
  if (review.length)
    messages.push(`${review.length} unrecognized ${review.length === 1 ? "entry needs" : "entries need"} review and will be preserved.`);
  if (!removable.length && !running.length && !review.length)
    messages.push("Only newest entries remain.");
  return messages.join(" ");
}

// Render the current review, confirmation, or result state with nonce-restricted
// scripts/styles and separate server, launcher, and legacy resource lists.
function page(state, version) {
  const nonce = randomBytes(18).toString("base64");
  const plan = state.plan;
  const deletions = plan?.items.filter((x) => x.action === "DELETE") || [];
  const servers = plan?.items.filter((x) => x.kind === "server") || [];
  const removalBreakdown = [
    ["server", "server folder", "server folders"],
    ["launcher", "launcher file", "launcher files"],
    ["legacy", "legacy folder", "legacy folders"],
  ]
    .map(([kind, singular, plural]) => {
      const count = deletions.filter((x) => x.kind === kind).length;
      return `${count} ${count === 1 ? singular : plural}`;
    })
    .join(" · ");

  const section = (kind, title, description) => {
    const items = plan?.items.filter((x) => x.kind === kind) || [];
    const articles = items.map((x) => `
      <article>
        <div class="row">
          <strong>${escape(x.version ? "v" + x.version : path.basename(x.path))}</strong>
          <span class="badge ${x.action.toLowerCase()}">${{
            KEEP: "Keep",
            DELETE: "Remove",
            REVIEW: "Review · preserved",
          }[x.action]}</span>
        </div>
        <p>${escape(x.reason)}</p>
        <code>${escape(x.path)}</code>
      </article>
    `).join("");

    return `
      <section>
        <h2>${title} <span class="count">${items.length}</span></h2>
        <p class="muted">${description}</p>
        ${items.length ? articles : "<p>None found.</p>"}
      </section>
    `;
  };

  const errorNotice = state.error ? `
    <div class="notice error" role="alert">
      <strong>Cleanup needs attention</strong>
      <p>${escape(state.error)}</p>
      <p>Some entries may already have been removed if cleanup started. Refresh to inspect the current state.</p>
    </div>
  ` : "";

  const summary = plan ? `
    <div class="summary">
      <div class="metric">
        <strong>${servers.length}</strong>Installed server folders
      </div>
      <div class="metric">
        <strong>${escape(plan.newest.version)}</strong>Latest server version
      </div>
      <div class="metric">
        <strong>${deletions.length}</strong>Total entries to remove
        <p class="muted">${escape(removalBreakdown)}</p>
      </div>
    </div>
  ` : "";

  const scanDescription = plan
    ? `Last scanned ${escape(state.scanned)} · ${
        state.confirm
          ? "Review the exact removal list below."
          : "Running resources and the newest server are protected."
      }`
    : "Inspect this host before cleaning.";

  const confirmation = state.confirm ? `
    <section class="notice">
      <h2>Confirm permanent removal</h2>
      <p>These ${deletions.length} entries will be permanently deleted: ${escape(removalBreakdown)}. Extensions and settings are preserved. Running resources are checked again before removal.</p>
      <ul>
        ${deletions.map((x) => `<li><code>${escape(x.path)}</code></li>`).join("")}
      </ul>
      <p>Avoid starting another VS Code connection to this account during cleanup.</p>
      <button data-action="confirm">Delete ${deletions.length} obsolete entries</button>
      <button class="secondary" data-action="cancel">Cancel</button>
    </section>
  ` : "";

  const removedEntries = state.removed?.length ? `
    <section class="notice">
      <h2>Removed ${state.removed.length} entries</h2>
      <ul>
        ${state.removed.map((p) => `<li><code>${escape(p)}</code></li>`).join("")}
      </ul>
    </section>
  ` : "";

  const inventory = plan ? [
    section(
      "server",
      "Installed servers",
      "Server versions installed on this host, with the reason each folder is kept or removable.",
    ),
    section(
      "launcher",
      "Launcher files",
      "Separate executables, not installed server versions. An old launcher can run a newer server.",
    ),
    section(
      "legacy",
      "Legacy server folders",
      "Older installation layout. Unknown entries are preserved for review.",
    ),
  ].join("") : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
    >
    <title>Remote SSH Version Cleaner</title>

    <style nonce="${nonce}">
${webviewCss}
    </style>
  </head>

  <body>
    <main>
      <header>
        <div class="eyebrow">Remote SSH Version Cleaner · extension ${escape(version)}</div>
        <div class="brand">
          <img src="${appIcon}" alt="Remote SSH Version Cleaner" width="88" height="88">
          <div>
            <h1>Clean Old VS Code Server Versions</h1>
            <p class="byline">by Amar Micro Inc.</p>
          </div>
        </div>
        <p>${escape(os.hostname())}</p>
        <code>${escape(plan?.root || state.root)}</code>
      </header>

      <div role="status" aria-live="polite">
        ${state.busy ? `<div class="notice">${escape(state.busy)}</div>` : ""}
        ${state.message ? `<div class="notice">${escape(state.message)}</div>` : ""}
      </div>

      ${errorNotice}
      ${summary}

      <div class="toolbar">
        <p class="muted">${scanDescription}</p>
        <div>
          <button class="secondary" data-action="refresh" ${state.busy ? "disabled" : ""}>Refresh</button>
          <button
            data-action="review"
            ${state.busy || !deletions.length || state.confirm ? "disabled" : ""}
          >Review cleanup (${deletions.length})</button>
        </div>
      </div>

      ${confirmation}
      ${removedEntries}
      ${inventory}
    </main>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      document.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (button && !button.disabled) {
          vscode.postMessage({ action: button.dataset.action });
        }
      });
    </script>
  </body>
</html>`;
}

// Register the remote-only status button, shared view state, commands, and disposables.
function activate(context) {
  const button = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  button.text = "$(trash) Clean Up VS Code";
  button.tooltip =
    "Review and remove old VS Code server versions on this remote host";
  button.command = "remoteServerCleaner.clean";
  context.subscriptions.push(button);
  if (process.platform === "linux" && vscode.env.remoteName === "ssh-remote")
    button.show();

  // Invalidate startup results when a view operation or disposal supersedes them.
  let statusRevision = 0;

  // Summarize removable resources; an inspection failure means availability is unknown.
  const updateStatus = (plan, error) => {
    const entries =
      plan?.items.filter((item) => item.action === "DELETE") || [];
    button.color = entries.length
      ? new vscode.ThemeColor("editorWarning.foreground")
      : undefined;
    button.tooltip = error
      ? "Unable to check for obsolete entries. Click to inspect this host."
      : plan
        ? `${inventorySummary(plan)} Click to inspect this host.`
        : "Checking for obsolete VS Code server entries…";
  };

  context.subscriptions.push({
    dispose: () => {
      statusRevision++;
    },
  });

  let panel;
  let state;
  context.subscriptions.push({ dispose: () => panel?.dispose() });

  const root =
    process.env.VSCODE_AGENT_FOLDER ||
    path.join(os.homedir(), ".vscode-server");

  const render = () => {
    if (panel)
      panel.webview.html = page(state, context.extension.packageJSON.version);
  };

  // Discard the previous plan before inspection so failures cannot leave stale results.
  const scan = async () => {
    state.plan = null;
    const plan = await cleaner.scan(root, await cleaner.activeCommits());
    state.plan = plan;
    updateStatus(plan);
    state.scanned = new Date().toLocaleTimeString();
  };

  // Serialize view actions and require the review state before accepting confirmation.
  // After apply, replace the deletion plan with a fresh inventory of what remains.
  const run = async (action) => {
    if (state.busy) return;

    if (action === "review") {
      if (state.plan?.items.some((x) => x.action === "DELETE"))
        state.confirm = true;
      render();
      return;
    }

    if (action === "cancel") {
      state.confirm = false;
      render();
      return;
    }

    if (!["refresh", "confirm"].includes(action)) return;
    if (action === "confirm" && (!state.confirm || !state.plan)) return;

    statusRevision++;
    updateStatus();
    const applying = action === "confirm";
    state.confirm = false;
    state.error = null;
    state.message = null;
    state.removed = [];
    state.busy = applying
      ? "Cleaning obsolete entries…"
      : "Inspecting installed servers…";
    render();

    try {
      if (
        process.platform !== "linux" ||
        vscode.env.remoteName !== "ssh-remote"
      )
        throw new Error(
          "Connect to a Linux host using Remote SSH and install this extension on that host.",
        );

      if (applying) {
        const plan = state.plan;
        state.plan = null;
        state.removed = await cleaner.apply(plan);
        state.message = `Deletion complete. Removed ${state.removed.length} obsolete entries. Checking what remains…`;
        render();
      }

      await scan();
      state.message = `${applying ? "Cleanup complete. " : ""}${inventorySummary(state.plan)}`;
    } catch (e) {
      state.plan = null;
      state.error = e.message;
      updateStatus(null, e);
    } finally {
      state.busy = null;
      render();
    }
  };

  // Reuse one panel and retain operation state across closing/reopening the view.
  const open = async () => {
    if (panel) {
      panel.reveal();
      return;
    }

    if (!state) state = { root, busy: null, plan: null };

    panel = vscode.window.createWebviewPanel(
      "remoteServerCleaner",
      "Remote SSH Version Cleaner",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [],
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = vscode.Uri.file(
      path.join(__dirname, "..", "assets", "cleaner-icon.png"),
    );

    // Keep an in-flight operation attached to its state even if the view is closed.
    const openedPanel = panel;
    const messageListener = openedPanel.webview.onDidReceiveMessage(
      (message) => {
        if (message && typeof message.action === "string")
          void run(message.action);
      },
    );
    const closeListener = openedPanel.onDidDispose(() => {
      messageListener.dispose();
      closeListener.dispose();
      if (panel === openedPanel) panel = undefined;
    });

    render();
    if (!state.busy) await run("refresh");
  };

  if (process.platform === "linux" && vscode.env.remoteName === "ssh-remote") {
    // Startup inspection never deletes; ignore its result if newer work has started.
    const revision = ++statusRevision;
    updateStatus();
    void (async () => {
      try {
        const plan = await cleaner.scan(root, await cleaner.activeCommits());
        if (revision === statusRevision) updateStatus(plan);
      } catch (error) {
        if (revision === statusRevision) updateStatus(null, error);
      }
    })();
  }

  for (const command of ["clean", "preview"])
    context.subscriptions.push(
      vscode.commands.registerCommand(`remoteServerCleaner.${command}`, open),
    );
}

module.exports = { activate, page };
