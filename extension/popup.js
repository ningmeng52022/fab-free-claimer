const t = (key, ...subs) => chrome.i18n.getMessage(key, subs) || key;

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

/** Fill every element carrying a data-i18n key with the localized string. */
function applyTranslations() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.title = t("extName");
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const text = t(node.dataset.i18n);
    if (text && text !== node.dataset.i18n) node.textContent = text;
  }
}

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

const BADGE = {
  idle: "badgeIdle",
  running: "badgeRunning",
  paused: "badgePaused",
  error: "badgeError",
};

function renderState(summary) {
  const { control = {}, checkpoint = {}, counts = {}, account, run = {} } = summary;
  const state = control.state || "idle";

  els.badge.textContent = t(BADGE[state] || BADGE.idle);
  els.badge.className = `badge ${state}`;
  els.account.textContent = account ? account.name : t("notSignedIn");
  els.listings.textContent = counts.listings ?? 0;
  els.claimed.textContent = counts.claimed ?? 0;
  els.failed.textContent = counts.failed ?? 0;

  if (run.ok !== undefined) {
    els.run.textContent = `+${run.ok ?? 0} / -${run.fail ?? 0}${
      run.recovered ? ` / ~${run.recovered}` : ""
    }`;
  }

  const total = counts.listings || 0;
  const done = counts.claimed || 0;
  els.bar.max = Math.max(total, 1);
  els.bar.value = Math.min(done, total);

  els.start.disabled = state === "running";
  els.pause.disabled = state !== "running";
  els.stop.disabled = state === "idle" && !total;

  if (state === "error") {
    els.hint.textContent = control.error || t("hintAuthError");
  } else if (checkpoint.phase === "enumerate" && state === "running") {
    els.hint.textContent = t("hintEnumerating", (checkpoint.enumDone || []).length);
  } else if (checkpoint.phase === "claim" && state === "running") {
    els.hint.textContent = t("hintClaiming", done, total);
  } else if (total && done >= total) {
    els.hint.textContent = t("hintDone");
  } else if (state === "paused") {
    els.hint.textContent = t("hintPaused");
  } else {
    els.hint.textContent = t("hintIdle");
  }
  return summary;
}

let finishedLogged = false;

async function refresh() {
  const response = await send({ type: "status" });
  if (!response.ok) {
    els.hint.textContent = t("hintWorkerDown");
    return;
  }
  const summary = renderState(response.data);
  if (summary.checkpoint?.phase === "done" && !finishedLogged) {
    finishedLogged = true;
    const run = summary.run || {};
    log(t("logFinished", run.ok ?? 0, run.fail ?? 0, run.recovered ?? 0));
  }
}

function scopeLabel() {
  return els.mode.selectedOptions[0]?.textContent || els.mode.value;
}

els.start.addEventListener("click", async () => {
  const incremental = els.incremental.checked;
  finishedLogged = false;
  log(incremental ? t("logStartIncremental", scopeLabel()) : t("logStart", scopeLabel()));
  const response = await send({
    type: "start",
    mode: els.mode.value,
    knownPages: incremental ? 3 : 0,
    reconcile: els.reconcile.checked,
  });
  if (!response.ok) log(t("logStartFailed", response.error));
  refresh();
});

els.pause.addEventListener("click", async () => {
  const response = await send({ type: "pause" });
  if (!response.ok) log(t("logPauseFailed", response.error));
  refresh();
});

els.stop.addEventListener("click", async () => {
  const response = await send({ type: "stop" });
  if (!response.ok) log(t("logStopFailed", response.error));
  else log(t("logStopped"));
  refresh();
});

els.verify.addEventListener("click", async () => {
  log(t("logVerifying"));
  const response = await send({ type: "verifySample", sample: 30 });
  if (response.ok) {
    log(t("logVerifyResult", response.data.owned, response.data.checked));
  } else {
    log(t("logVerifyFailed", response.error));
  }
});

els.reset.addEventListener("click", async () => {
  if (!confirm(t("confirmReset"))) return;
  const response = await send({ type: "reset" });
  if (!response.ok) log(t("logResetFailed", response.error));
  else log(t("logResetDone"));
  refresh();
});

applyTranslations();
refresh();
setInterval(refresh, 2000);
