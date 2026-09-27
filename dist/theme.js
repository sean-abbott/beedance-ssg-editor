// Color theme (Blue/Bee) - persisted the same way as this app's other
// personal-to-this-installation settings (a JSON file under config_dir(),
// via ui_settings.rs), not browser localStorage, so it's consistent across
// this app's several windows rather than per-webview-origin state.

const { invoke } = window.__TAURI__.core;

const applyTheme = (theme) => {
  if (theme === "bee") {
    document.documentElement.setAttribute("data-theme", "bee");
  } else {
    document.documentElement.removeAttribute("data-theme");
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
