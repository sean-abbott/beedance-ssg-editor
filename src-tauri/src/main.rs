#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod content;
mod frontmatter;
mod git;
mod github;
mod images;
mod media;
mod menu;
mod preview;
mod r2;
mod site;
mod ui_settings;
mod zola;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::Manager;

use content::AuthorSettingsState;
use git::GitAuthConfigState;
use images::TierSettingsState;
use preview::{LogBacklog, ServeState, LOG_LABEL, PREVIEW_LABEL};
use r2::{R2PersonalConfigState, R2SiteConfigState};
use site::{OpenFiles, SelfWriteTracker, WatcherState};
use ui_settings::UiSettingsState;

/// Kills the zola sidecar (if running) and closes the preview/log windows
/// (if open) - called from both an ordinary main-window close AND an
/// app-level quit (see main()'s run callback for why both are needed).
fn cleanup_preview(app: &tauri::AppHandle) {
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

fn main() {
    // Both ureq and rust-s3 pull in rustls transitively; with more than one
    // in the dependency graph, rustls refuses to guess which crypto backend
    // to use and panics on first TLS use unless told explicitly, once, up
    // front - this must run before any HTTPS request anywhere in this app
    // (found the hard way via beedance-cli's own real-world test-upload run).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServeState(Mutex::new(None)))
        .manage(preview::PreviewPortState(Mutex::new(None)))
        .manage(LogBacklog(Mutex::new(Vec::new())))
        .manage(SelfWriteTracker(Mutex::new(HashMap::new())))
        .manage(OpenFiles(Mutex::new(HashSet::new())))
        .manage(WatcherState(Mutex::new(None)))
        .manage(TierSettingsState(Mutex::new(images::load_tier_settings())))
        .manage(R2SiteConfigState(Mutex::new(r2::load_r2_site_config())))
        .manage(R2PersonalConfigState(Mutex::new(r2::load_r2_personal_config())))
        .manage(AuthorSettingsState(Mutex::new(content::load_author_settings())))
        .manage(UiSettingsState(Mutex::new(ui_settings::load_ui_settings())))
        .manage(GitAuthConfigState(Mutex::new(git::load_git_auth_config())))
        .setup(|app| {
            site::spawn_content_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            preview::zola_version,
            git::git_status,
            git::git_changed_files,
            git::git_diff_for_file,
            git::git_commit,
            git::current_branch,
            git::start_draft,
            git::get_git_auth_config,
            git::set_git_auth_config,
            git::git_get_remote_url,
            git::git_set_remote_url,
            git::git_push,
            git::git_pull,
            git::git_list_local_branches,
            git::git_checkout_branch,
            git::git_checkout_remote_branch,
            git::git_check_main_drift,
            git::git_clone_repo,
            github::github_list_open_prs,
            github::github_create_pull_request,
            github::github_approve_pull_request,
            preview::zola_serve,
            preview::zola_stop,
            preview::open_log_window,
            preview::set_preview_phone_mode,
            site::list_editable_files,
            site::list_editable_files_detailed,
            content::create_post,
            content::create_page,
            content::create_section,
            content::delete_content,
            content::rename_content,
            content::list_page_sections,
            menu::get_site_menu,
            menu::set_site_menu,
            content::get_front_matter_date,
            content::get_front_matter_title,
            content::detect_external_content,
            content::list_all_tags,
            content::list_all_tags_with_counts,
            content::get_content_tags,
            content::set_content_tags,
            content::rewrite_tag,
            content::find_taxonomy_term_template_refs,
            media::list_local_shared_images,
            media::list_r2_images,
            media::scan_image_usage,
            media::delete_local_shared_image,
            media::delete_r2_shared_image,
            media::rename_shared_image,
            media::move_shared_image,
            media::list_image_alt_text_usages,
            media::set_image_alt_text,
            content::get_author_settings,
            content::set_author_settings,
            ui_settings::get_ui_settings,
            ui_settings::set_ui_settings,
            content::set_front_matter_date,
            content::remove_front_matter_date,
            site::get_site_dir,
            site::set_site_dir,
            site::has_completed_onboarding,
            site::mark_onboarding_complete,
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
            images::delete_r2_image_by_url,
            r2::get_r2_site_config,
            r2::set_r2_site_config,
            r2::get_r2_personal_config,
            r2::set_r2_personal_config
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // A plain .on_window_event(CloseRequested) hook (what this used to be)
    // only reliably fires for a literal click on the main window's own
    // close button. Quitting via Cmd+Q or the Dock/menu-bar Quit item on
    // macOS goes through the app-level quit flow instead, which surfaces
    // here as RunEvent::ExitRequested, NOT a WindowEvent - found the hard
    // way testing on a real Mac, where quitting that way left zola serve
    // running (and its port held) after the app itself had already exited.
    // Handling both keeps every way of closing the app covered, on every
    // platform - cleanup_preview is idempotent (ServeState.take() makes a
    // second call a no-op) so overlap between the two is harmless.
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => cleanup_preview(app_handle),
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { .. }, .. } if label == "main" => {
            cleanup_preview(app_handle);
        }
        _ => {}
    });
}
