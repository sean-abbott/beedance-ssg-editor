// Preview server control (start/stop, phone-mode, network exposure, log
// window) and the old raw "debug tools" git buttons. Owns the network-serve
// toggle itself (rather than settings.js, even though the checkbox lives in
// the Settings dialog's markup) purely to avoid a circular import: this
// module needs to know whether preview is running to decide whether to
// restart it when the toggle flips, and settings.js has no other reason to
// depend on this module.

import { activeTab } from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

const wire = (buttonId, resultId, run) => {
  document.getElementById(buttonId).addEventListener("click", async () => {
    const el = document.getElementById(resultId);
    try {
      el.textContent = await run();
    } catch (err) {
      el.textContent = "ERROR: " + err;
    }
  });
};

wire("check", "result", () => invoke("zola_version"));
wire("branch", "branch-result", () => invoke("current_branch"));
wire("status", "status-result", () => invoke("git_status"));

wire("commit", "commit-result", () => {
  const message = document.getElementById("commit-msg").value || "Update from beedance-ssg-editor";
  return invoke("git_commit", { message });
});

wire("start-draft", "draft-result", () => {
  const name = document.getElementById("draft-name").value || "untitled";
  return invoke("start_draft", { name });
});

document.getElementById("open-log-window").addEventListener("click", () => {
  invoke("open_log_window").catch((err) => console.error("couldn't open log window:", err));
});

let networkServeEnabled = false;
const networkServeToggle = document.getElementById("network-serve-toggle");
const lanAddressEl = document.getElementById("lan-address");

document.getElementById("open-settings").addEventListener("click", async () => {
  try {
    const ip = await invoke("get_lan_ip");
    // No fixed port to show here - each "Start preview" picks a fresh free
    // one (see preview.rs), reported in the editor's status message once
    // it's actually running.
    lanAddressEl.textContent = `This machine's address on your network: ${ip} (the port shows in the status message after you start the preview)`;
  } catch (err) {
    lanAddressEl.textContent = "Couldn't determine a network address: " + err;
  }
});

let previewRunning = false;

const startPreview = async () => {
  const status = document.getElementById("editor-status");
  try {
    await invoke("zola_serve", { network: networkServeEnabled, currentContentPath: activeTab });
    previewRunning = true;
    status.textContent = "";
  } catch (err) {
    previewRunning = false;
    status.textContent = "ERROR: " + err;
  }
};

const stopPreview = async () => {
  const status = document.getElementById("editor-status");
  try {
    await invoke("zola_stop");
    previewRunning = false;
    document.getElementById("phone-toggle").checked = false;
  } catch (err) {
    status.textContent = "ERROR: " + err;
  }
};

networkServeToggle.addEventListener("change", async (e) => {
  networkServeEnabled = e.target.checked;
  // The network setting only takes effect at zola serve's own startup
  // (it's a CLI flag) - if preview is already running, restart it so
  // flipping this toggle doesn't silently do nothing until the next
  // unrelated stop/start.
  if (previewRunning) {
    await stopPreview();
    await startPreview();
  }
});

document.getElementById("preview-start").addEventListener("click", startPreview);
document.getElementById("preview-stop").addEventListener("click", stopPreview);

document.getElementById("phone-toggle").addEventListener("change", async (e) => {
  const status = document.getElementById("editor-status");
  try {
    await invoke("set_preview_phone_mode", { phone: e.target.checked });
  } catch (err) {
    status.textContent = "ERROR: " + err;
    e.target.checked = !e.target.checked;
  }
});
