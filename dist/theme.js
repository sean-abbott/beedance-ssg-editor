// Color theme (Blue/Bee) - persisted the same way as this app's other
// personal-to-this-installation settings (a JSON file under config_dir(),
// via ui_settings.rs), not browser localStorage, so it's consistent across
// this app's several windows rather than per-webview-origin state. That
// real persistence is async (a Tauri IPC round-trip below), which on its
// own was a visible 1-2s flash of the Blue theme on every startup before
// settling on Bee - localStorage is used here purely as a same-launch
// CACHE of the last applied theme, read synchronously by a tiny inline
// script in index.html/log.html's own <head> (before first paint), and
// kept fresh by this same function every time it actually runs - never
// the source of truth itself, just there to avoid the flash.
const { invoke } = window.__TAURI__.core;

const applyTheme = (theme) => {
  if (theme === "bee") {
    document.documentElement.setAttribute("data-theme", "bee");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  try {
    localStorage.setItem("beedance-theme", theme === "bee" ? "bee" : "blue");
  } catch {
    // Private window, cleared site data, etc. - the inline <head> script
    // already tolerates a missing/unreadable cache the same way, so this
    // just means next startup flashes once more, nothing worse.
  }
  document.querySelectorAll("[data-theme-option]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeOption === (theme || "blue"));
  });
};

invoke("get_ui_settings")
  .then((settings) => applyTheme(settings.theme))
  .catch(() => {});

document.querySelectorAll("[data-theme-option]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const theme = btn.dataset.themeOption;
    applyTheme(theme);
    try {
      await invoke("set_ui_settings", { settings: { theme } });
    } catch (err) {
      console.error("couldn't save theme choice:", err);
    }
  });
});
