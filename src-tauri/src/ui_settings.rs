//! Personal-to-this-installation UI preferences (currently just the color
//! theme) - same persistence pattern as content::AuthorSettings and git's
//! GitAuthConfig (a JSON file under config_dir()), not browser localStorage,
//! since this needs to survive and apply consistently across this app's
//! several windows (main, preview, log), not just one webview's storage.

use std::sync::Mutex;

use crate::site::config_dir;

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    // "blue" (default/unset) or "bee" - anything else the frontend doesn't
    // recognize just falls back to blue, so this never needs validating.
    theme: String,
}

const UI_SETTINGS_FILE: &str = "ui-settings.json";

pub struct UiSettingsState(pub Mutex<UiSettings>);

pub fn load_ui_settings() -> UiSettings {
    config_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(UI_SETTINGS_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_ui_settings(state: tauri::State<UiSettingsState>) -> UiSettings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_ui_settings(settings: UiSettings, state: tauri::State<UiSettingsState>) -> Result<(), String> {
    *state.0.lock().unwrap() = settings.clone();

    if let Some(dir) = config_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(UI_SETTINGS_FILE), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}
