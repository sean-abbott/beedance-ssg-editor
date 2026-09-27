// Temporary spike for pws-zg1h - verifies real ES module imports actually
// load and execute correctly when served by Tauri's frontendDist, before
// committing the whole app to that structure. Delete this file (and
// spike-module-b.js, and the <script type="module"> tag referencing it in
// index.html) once that's confirmed either way.
export const spikeMessage = "ES modules work in this app";
