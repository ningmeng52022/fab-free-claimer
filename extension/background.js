/**
 * Service worker: message router plus the tick scheduler.
 *
 * Chrome terminates MV3 workers aggressively, so every tick is short and the
 * next one is scheduled with an alarm. If the worker is killed mid-run the
 * checkpoints in IndexedDB make the next tick continue where it stopped.
 */

import { AuthError } from "./lib/api.js";
import * as engine from "./lib/engine.js";

const ALARM = "fab-free-claimer-tick";
const MAX_CONTINUOUS_MS = 4 * 60 * 1000; // Chrome kills a worker after ~5 min

let ticking = false;

async function schedule(running) {
  const existing = await chrome.alarms.get(ALARM);
  if (running) {
    if (!existing) chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  } else if (existing) {
    await chrome.alarms.clear(ALARM);
  }
}

/**
 * Run slices back to back while the worker is alive, then fall back to the
 * alarm. This keeps throughput high without relying on a single long task.
 */
async function runTick() {
  if (ticking) return;
  ticking = true;
  const startedAt = Date.now();
  try {
    for (;;) {
      const result = await engine.tick();
      const running = result.state === "running";

      await chrome.action.setBadgeText({
        text: running ? "on" : result.state === "error" ? "!" : "",
      });
      await chrome.action.setBadgeBackgroundColor({ color: "#2f6f4f" });

      if (!running) {
        await schedule(false);
        break;
      }
      if (Date.now() - startedAt > MAX_CONTINUOUS_MS) {
        await schedule(true);
        break;
      }
      if (result.state === "paused" || result.state === "idle") break;
    }
  } catch (error) {
    console.error("tick failed", error);
    await schedule(true);
  } finally {
    ticking = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  schedule(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runTick();
});

chrome.runtime.onStartup.addListener(async () => {
  const control = await engine.getControl();
  if (control.state === "running") runTick();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "status":
          sendResponse({ ok: true, data: await engine.getSummary() });
          break;
        case "start": {
          await engine.start({
            mode: message.mode,
            knownPages: message.knownPages,
            reconcile: message.reconcile,
          });
          runTick();
          sendResponse({ ok: true });
          break;
        }
        case "pause":
          await engine.pause();
          sendResponse({ ok: true });
          break;
        case "resume":
          await engine.resume();
          runTick();
          sendResponse({ ok: true });
          break;
        case "stop":
          await engine.stop();
          await schedule(false);
          await chrome.action.setBadgeText({ text: "" });
          sendResponse({ ok: true });
          break;
        case "reset":
          await engine.stop();
          await engine.hardReset();
          await schedule(false);
          sendResponse({ ok: true });
          break;
        case "verifySample":
          sendResponse({ ok: true, data: await engine.verifySample(message.sample || 30) });
          break;
        case "verifyFull":
          sendResponse({ ok: true, data: await engine.verifyFull() });
          break;
        default:
          sendResponse({ ok: false, error: `unknown message: ${message.type}` });
      }
    } catch (error) {
      const auth = error instanceof AuthError;
      sendResponse({
        ok: false,
        error: String(error.message || error),
        authRequired: auth,
      });
    }
  })();
  return true; // keep the channel open for the async reply
});
