// Sidebar layout chrome: the File/Insert/<branch> dropdown "app menus"
// (open/close on click, one at a time, closed by an outside click) and the
// sidebar nav's Pages/Tags/Settings/Debug tools links, which just trigger
// the same existing buttons/panels rather than being real navigation - this
// app still has one main view, not separate routed pages. Kept as its own
// module (rather than in app.js, which is deliberately just import-for-
// side-effects) since this is generic app-chrome behavior, not owned by any
// one feature module.

document.querySelectorAll(".menu > button").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = btn.parentElement;
    const wasOpen = menu.classList.contains("open");
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
    if (!wasOpen) menu.classList.add("open");
  });
});
// Also closes an open dropdown when one of its own items is clicked (e.g.
// "New page..."), same as a real app menu - that click's own handler
// (elsewhere) runs first during the bubble phase, then this one closes the
// dropdown behind it, since only the toggle button itself (above) stops
// the click from reaching here.
document.addEventListener("click", () => {
  document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
});

// Pages/Media/Tags nav items reuse the existing Site menu/Manage tags
// panels rather than being real separate views - Media has no panel at all
// yet, so it's left inert (see its own title="Not built yet" in the
// markup). Editor is always the active view (single-pane app).
document.getElementById("sidebar-nav-pages").addEventListener("click", () => {
  document.getElementById("site-menu-button").click();
});
document.getElementById("sidebar-nav-tags").addEventListener("click", () => {
  document.getElementById("manage-tags-button").click();
});

// Debug tools moved out of an always-visible <details> block on the main
// screen (found the hard way that non-technical users would see it and
// wonder what it was) - now a de-emphasized sidebar link that reveals the
// same <details>, opened, rather than a whole separate panel.
const debugDetails = document.getElementById("debug-tools-details");
document.getElementById("sidebar-nav-debug").addEventListener("click", () => {
  const showing = debugDetails.style.display !== "none";
  debugDetails.style.display = showing ? "none" : "block";
  debugDetails.open = !showing;
});
