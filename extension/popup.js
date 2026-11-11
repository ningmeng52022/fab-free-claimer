const els = {
  badge: document.getElementById("badge"),
  account: document.getElementById("account"),
  listings: document.getElementById("listings"),
  claimed: document.getElementById("claimed"),
  failed: document.getElementById("failed"),
  run: document.getElementById("run"),
  bar: document.getElementById("bar"),
  hint: document.getElementById("hint"),
  mode: document.getElementById("mode"),
  incremental: document.getElementById("incremental"),
  reconcile: document.getElementById("reconcile"),
  start: document.getElementById("start"),
  pause: document.getElementById("pause"),
  stop: document.getElementById("stop"),
  verify: document.getElementById("verify"),
  reset: document.getElementById("reset"),
  log: document.getElementById("log"),
};

const lines = [];

function log(text) {
  const stamp = new Date().toLocaleTimeString();
  lines.unshift(`[${stamp}] ${text}`);
  els.log.textContent = lines.slice(0, 30).join("\n");
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: "no response" });
      }
    });
  });
}

function renderState(summary) {
  const { control = {}, checkpoint = {}, counts = {}, account } = summary;
  const state = control.state || "idle";

  els.badge.textContent = state;
  els.badge.className = `badge ${state}`;
  els.account.textContent = account ? account.name : "not signed in";
  els.listings.textContent = counts.listings ?? 0;
  els.claimed.textContent = counts.claimed ?? 0;
  els.failed.textContent = counts.failed ?? 0;

  const total = counts.listings || 0;
  const done = counts.claimed || 0;
  els.bar.max = Math.max(total, 1);
  els.bar.value = Math.min(done, total);

  els.start.disabled = state === "running";
  els.pause.disabled = state !== "running";
  els.stop.disabled = state === "idle" && !total;

  if (state === "error") {
    els.hint.textContent = control.error || "Authentication failed - sign in to fab.com again.";
  } else if (checkpoint.phase === "enumerate" && state === "running") {
    els.hint.textContent = `Enumerating the catalogue (${(checkpoint.enumDone || []).length} partitions done)...`;
  } else if (checkpoint.phase === "claim" && state === "running") {
    const rate = control.rate ? ` - ${control.rate}/s` : "";
    els.hint.textContent = `Claiming: ${done}/${total}${rate}`;
  } else if (total && done >= total) {
    els.hint.textContent = "Everything free is in your library. Re-run with Incremental to catch new releases.";
  } else if (state === "paused") {
    els.hint.textContent = "Paused. Progress is saved.";
  } else {
    els.hint.textContent = "Pick a scope and press Start.";
  }
}

async function refresh() {
  const response = await send({ type: "status" });
  if (!response.ok) {
    els.hint.textContent = response.error || "worker unavailable";
    return;
  }
  renderState(response.data);
  if (response.data.checkpoint && response.data.checkpoint.phase === "done") {
    const { ok = 0, fail = 0, recovered = 0 } = response.data.run || {};
    if (!lines.length) log(`finished: ok=${ok} fail=${fail} recovered=${recovered}`);
  }
}

els.start.addEventListener("click", async () => {
  const incremental = els.incremental.checked;
  log(`start: ${els.mode.value}${incremental ? " (incremental)" : ""}`);
  const response = await send({
    type: "start",
    mode: els.mode.value,
    knownPages: incremental ? 3 : 0,
    reconcile: els.reconcile.checked,
  });
  if (!response.ok) log(`start failed: ${response.error}`);
  refresh();
});

els.pause.addEventListener("click", async () => {
  const response = await send({ type: "pause" });
  if (!response.ok) log(`pause failed: ${response.error}`);
  refresh();
});

els.stop.addEventListener("click", async () => {
  const response = await send({ type: "stop" });
  if (!response.ok) log(`stop failed: ${response.error}`);
  log("stopped");
  refresh();
});

els.verify.addEventListener("click", async () => {
  log("spot checking 30 claimed listings...");
  const response = await send({ type: "verifySample", sample: 30 });
  if (response.ok) log(`spot check: ${response.data.owned}/${response.data.checked} owned`);
  else log(`verify failed: ${response.error}`);
});

els.reset.addEventListener("click", async () => {
  if (!confirm("Delete all local listings and claim history? Your Fab library is not touched.")) return;
  const response = await send({ type: "reset" });
  if (!response.ok) log(`reset failed: ${response.error}`);
  else log("local data cleared");
  refresh();
});

refresh();
setInterval(refresh, 2000);
