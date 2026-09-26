#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod content;
mod frontmatter;
mod git;
mod images;
mod preview;
mod r2;
mod site;
mod zola;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::Manager;

use content::AuthorSettingsState;
use images::TierSettingsState;
use preview::{LogBacklog, ServeState, LOG_LABEL, PREVIEW_LABEL};
use r2::{R2PersonalConfigState, R2SiteConfigState};
use site::{OpenFiles, SelfWriteTracker, WatcherState};

fn main() {
    // Both ureq and rust-s3 pull in rustls transitively; with more than one
    // in the dependency graph, rustls refuses to guess which crypto backend
    // to use and panics on first TLS use unless told explicitly, once, up
    // front - this must run before any HTTPS request anywhere in this app
    // (found the hard way via beedance-cli's own real-world test-upload run).
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServeState(Mutex::new(None)))
        .manage(LogBacklog(Mutex::new(Vec::new())))
        .manage(SelfWriteTracker(Mutex::new(HashMap::new())))
        .manage(OpenFiles(Mutex::new(HashSet::new())))
        .manage(WatcherState(Mutex::new(None)))
        .manage(TierSettingsState(Mutex::new(images::load_tier_settings())))
        .manage(R2SiteConfigState(Mutex::new(r2::load_r2_site_config())))
        .manage(R2PersonalConfigState(Mutex::new(r2::load_r2_personal_config())))
        .manage(AuthorSettingsState(Mutex::new(content::load_author_settings())))
        .setup(|app| {
            site::spawn_content_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window should take the preview (window + zola
            // serve process) down with it, not leave it orphaned.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                if let Some(state) = app.try_state::<ServeState>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
                if let Some(preview) = app.get_webview_window(PREVIEW_LABEL) {
                    let _ = preview.close();
                }
                if let Some(log_win) = app.get_webview_window(LOG_LABEL) {
                    let _ = log_win.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            preview::zola_version,
            git::git_status,
            git::git_commit,
            git::current_branch,
            git::start_draft,
            preview::zola_serve,
            preview::zola_stop,
            preview::open_log_window,
            preview::set_preview_phone_mode,
            site::list_editable_files,
            site::list_editable_files_detailed,
            content::create_post,
            content::create_page,
            content::delete_content,
            content::rename_content,
            content::list_page_sections,
            content::get_front_matter_date,
            content::get_front_matter_title,
            content::list_all_tags,
            content::get_content_tags,
            content::set_content_tags,
            content::get_author_settings,
            content::set_author_settings,
            content::set_front_matter_date,
            content::remove_front_matter_date,
            site::get_site_dir,
            site::set_site_dir,
            site::read_file,
            site::close_file,
            site::write_file,
            images::insert_image,
            images::read_image_preview,
            preview::get_lan_ip,
            site::is_bundle_page,
            images::get_tier_settings,
            images::set_tier_settings,
            images::resize_image_in_place,
            images::get_image_dimensions,
            images::localize_remote_image,
            r2::get_r2_site_config,
            r2::set_r2_site_config,
            r2::get_r2_personal_config,
            r2::set_r2_personal_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
