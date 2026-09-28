// First-run onboarding: a brief welcome, then Settings (name + optional
// GitHub PAT/username), then a choice between the bundled sample site or
// cloning a real one from GitHub. Skippable at every step - this never
// blocks using the app, just nudges toward the setup that makes the rest of
// it (attribution, GitHub sync) actually useful from the start.

import { switchToSiteDir, wirePanelKeys, describeGitError, showError } from "./editor-core.js";

const { invoke } = window.__TAURI__.core;

const welcomePanel = document.getElementById("onboarding-welcome-panel");
const sitePanel = document.getElementById("onboarding-site-panel");
const siteStatus = document.getElementById("onboarding-site-status");
const cloneUrlInput = document.getElementById("onboarding-clone-url");
const cloneDestinationLabel = document.getElementById("onboarding-clone-destination");
const cloneSshHint = document.getElementById("onboarding-clone-ssh-hint");

// A pasted SSH-style link (git@github.com:... or ssh://...) works fine for
// someone who already has SSH set up (Sean, Dave) but is a dead end for
// anyone who doesn't - a failure there surfaces as raw SSH/git errors this
// app has no way to make friendly (see describeGitError). Flagged as soon
// as it's typed rather than only after a failed clone.
cloneUrlInput.addEventListener("input", () => {
  const url = cloneUrlInput.value.trim();
  const looksLikeSsh = /^git@/.test(url) || /^ssh:\/\//.test(url);
  cloneSshHint.style.display = looksLikeSsh ? "block" : "none";
  cloneSshHint.textContent = looksLikeSsh
    ? "This looks like an SSH link. If you're not sure what that means, use the HTTPS link instead (see above)."
    : "";
});

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
  welcomePanel.style.display = "none";
  // Reuses the real Settings page (settings.js already owns its load/save
  // logic) instead of a separate onboarding-specific form - clicking its
  // own link fires the exact same wiring a real click would. "This
  // installation" (name, GitHub PAT - what onboarding actually cares
  // about) is the first, top-most zone on that page now, so there's
  // nothing left to switch to like the old tabbed dialog needed.
  document.getElementById("open-settings").click();
  // Settings is a persistent page now, not a modal with its own "close" -
  // move on to the next onboarding step once the user navigates away from
  // it to anywhere else, rather than waiting for an explicit close.
  const onPageChange = (e) => {
    if (e.detail.page === "settings") return;
    document.removeEventListener("beedance:page-changed", onPageChange);
    openSiteStep();
  };
  document.addEventListener("beedance:page-changed", onPageChange);
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
    showError(err);
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
    siteStatus.textContent = "";
    showError(describeGitError(err));
  }
});

wirePanelKeys(welcomePanel, "onboarding-welcome-continue", "onboarding-welcome-skip");
wirePanelKeys(sitePanel, null, "onboarding-site-start-fresh");

invoke("has_completed_onboarding").then((done) => {
  if (!done) {
    welcomePanel.style.display = "flex";
  }
});
