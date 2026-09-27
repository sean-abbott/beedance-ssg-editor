// First-run onboarding: a brief welcome, then Settings (name + optional
// GitHub PAT/username), then a choice between the bundled sample site or
// cloning a real one from GitHub. Skippable at every step - this never
// blocks using the app, just nudges toward the setup that makes the rest of
// it (attribution, GitHub sync) actually useful from the start.

import { switchToSiteDir, wirePanelKeys } from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

const welcomePanel = document.getElementById("onboarding-welcome-panel");
const sitePanel = document.getElementById("onboarding-site-panel");
const siteStatus = document.getElementById("onboarding-site-status");
const cloneUrlInput = document.getElementById("onboarding-clone-url");
const cloneDestinationLabel = document.getElementById("onboarding-clone-destination");

let chosenDestination = null;

const finishOnboarding = async () => {
  sitePanel.style.display = "none";
  welcomePanel.style.display = "none";
  try {
    await invoke("mark_onboarding_complete");
  } catch (err) {
    console.error("couldn't record onboarding completion:", err);
  }
};

const openSiteStep = () => {
  welcomePanel.style.display = "none";
  siteStatus.textContent = "";
  cloneUrlInput.value = "";
  chosenDestination = null;
  cloneDestinationLabel.textContent = "(none chosen)";
  sitePanel.style.display = "flex";
};

document.getElementById("onboarding-welcome-continue").addEventListener("click", () => {
  // Reuses the real Settings dialog (settings.js already owns its load/
  // save logic) instead of a separate onboarding-specific form - clicking
  // its own buttons fires the exact same wiring a real click would.
  // Defaults to the personal tab since that's what onboarding cares about
  // (name, GitHub PAT), not the site-level fieldsets.
  document.getElementById("open-settings").click();
  document.querySelector('.settings-tab-btn[data-settings-tab="personal"]').click();
  document.getElementById("close-settings").addEventListener("click", openSiteStep, { once: true });
});

document.getElementById("onboarding-welcome-skip").addEventListener("click", finishOnboarding);
document.getElementById("onboarding-site-start-fresh").addEventListener("click", finishOnboarding);

document.getElementById("onboarding-clone-choose-folder").addEventListener("click", async () => {
  try {
    const folder = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: "Choose where to clone this site",
    });
    if (!folder) return;
    chosenDestination = folder;
    cloneDestinationLabel.textContent = folder;
  } catch (err) {
    siteStatus.textContent = "ERROR: " + err;
  }
});

document.getElementById("onboarding-clone-confirm").addEventListener("click", async () => {
  const url = cloneUrlInput.value.trim();
  if (!url) {
    siteStatus.textContent = "Enter a repository URL first.";
    return;
  }
  if (!chosenDestination) {
    siteStatus.textContent = "Choose a destination folder first.";
    return;
  }
  siteStatus.textContent = "Cloning...";
  try {
    await invoke("git_clone_repo", { url, destination: chosenDestination });
    await switchToSiteDir(chosenDestination);
    siteStatus.textContent = "Cloned.";
    await finishOnboarding();
  } catch (err) {
    siteStatus.textContent = "ERROR: " + err;
  }
});

wirePanelKeys(welcomePanel, "onboarding-welcome-continue", "onboarding-welcome-skip");
wirePanelKeys(sitePanel, null, "onboarding-site-start-fresh");

invoke("has_completed_onboarding").then((done) => {
  if (!done) {
    welcomePanel.style.display = "flex";
  }
});
