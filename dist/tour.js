// First-use feature tour (pws-1nj3) - a short, skippable spotlight
// walkthrough, re-triggerable any time from the header's "Take the tour"
// button. Distinct from onboarding.js's one-time setup wizard (name/GitHub
// credentials, choosing a site) - that's initial configuration; this is a
// UI walkthrough. Steps target real elements already in the persistent
// header/sidebar chrome, so this never needs to navigate between pages - a
// step with no target (welcome/closing) just centers the card with no
// spotlight.
//
// Grounded in this session's actual recurring friction points, not guessed
// cold: Preview was Sean's explicit "not obvious for new users" example, and
// the draft/branch indicator was the single most-revisited point of
// confusion across the whole Drafts/Reviews design pass.
//
// Deliberately NOT built yet, per Sean's own "iterate once the machinery is
// built anyway": auto-fire on first use, and a Settings toggle to suppress
// it. This is the manual "Take the tour" button + overlay mechanism only.

const TOUR_STEPS = [
  {
    title: "Quick tour",
    body: "4 stops, skip anytime — and you can always come back to this tour later from the compass button up top.",
    selector: null,
  },
  {
    title: "Everything lives in the sidebar",
    body: "Write in Editor, browse Pages, manage Media/Tags/Menu, and more — one destination per job.",
    selector: ".sidebar-nav",
  },
  {
    title: "See your actual site",
    body: "This is the one people miss: click Start preview anytime to see your real site. It opens its own window and updates live as you type.",
    selector: "#preview-start",
  },
  {
    title: "What you're working on",
    body: 'This shows your current draft. A name here (not "main") means your changes stay separate from the live site until you publish.',
    selector: ".header-draft-indicator",
  },
  { title: "That's it", body: "Take this tour again anytime from the compass button up top.", selector: null },
];

let tourOverlay;
let tourSpotlight;
let tourCard;
let tourStepIndex = 0;

const buildTourDom = () => {
  tourOverlay = document.createElement("div");
  tourOverlay.className = "tour-overlay";
  tourSpotlight = document.createElement("div");
  tourSpotlight.className = "tour-spotlight";
  tourCard = document.createElement("div");
  tourCard.className = "tour-card";
  tourOverlay.append(tourSpotlight, tourCard);
  document.body.appendChild(tourOverlay);
};

const endTour = () => {
  if (tourOverlay) tourOverlay.classList.remove("open");
};

// .header-draft-indicator is shared by TWO elements in the real header (the
// plain link shown on main/a draft, and the .on-review menu button shown
// while reviewing) - toggled via display, not removed from the DOM. A plain
// querySelector would always land on whichever comes first in markup order
// regardless of which is actually visible, so this picks the one that is.
const findTourTarget = (selector) => {
  if (!selector) return null;
  const matches = [...document.querySelectorAll(selector)];
  return matches.find((el) => el.offsetParent !== null) || matches[0] || null;
};

const renderTourStep = () => {
  const step = TOUR_STEPS[tourStepIndex];
  const target = findTourTarget(step.selector);

  if (target) {
    const rect = target.getBoundingClientRect();
    tourSpotlight.style.display = "block";
    tourSpotlight.style.top = rect.top - 6 + "px";
    tourSpotlight.style.left = rect.left - 6 + "px";
    tourSpotlight.style.width = rect.width + 12 + "px";
    tourSpotlight.style.height = rect.height + 12 + "px";

    let top = rect.bottom + 16;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - 280 - 8);
    if (top + 160 > window.innerHeight) top = Math.max(8, rect.top - 170);
    tourCard.style.top = top + "px";
    tourCard.style.left = left + "px";
    tourCard.style.transform = "none";
  } else {
    tourSpotlight.style.display = "none";
    tourCard.style.top = "50%";
    tourCard.style.left = "50%";
    tourCard.style.transform = "translate(-50%, -50%)";
  }

  tourCard.innerHTML = "";

  const stepCounter = document.createElement("div");
  stepCounter.className = "tour-card-step";
  stepCounter.textContent = `${tourStepIndex + 1} of ${TOUR_STEPS.length}`;

  const title = document.createElement("h4");
  title.textContent = step.title;

  const body = document.createElement("p");
  body.textContent = step.body;

  const actions = document.createElement("div");
  actions.className = "tour-card-actions";

  if (tourStepIndex > 0) {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "secondary";
    backBtn.textContent = "Back";
    backBtn.addEventListener("click", () => {
      tourStepIndex--;
      renderTourStep();
    });
    actions.appendChild(backBtn);
  }

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "secondary";
  skipBtn.style.marginLeft = "auto";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", endTour);
  actions.appendChild(skipBtn);

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.textContent = tourStepIndex === TOUR_STEPS.length - 1 ? "Done" : "Next";
  nextBtn.addEventListener("click", () => {
    if (tourStepIndex === TOUR_STEPS.length - 1) {
      endTour();
      return;
    }
    tourStepIndex++;
    renderTourStep();
  });
  actions.appendChild(nextBtn);

  tourCard.append(stepCounter, title, body, actions);
};

export const startTour = () => {
  tourStepIndex = 0;
  if (!tourOverlay) buildTourDom();
  tourOverlay.classList.add("open");
  renderTourStep();
};

document.getElementById("take-tour-button").addEventListener("click", startTour);

const { invoke } = window.__TAURI__.core;

// Auto-fires once per install, after onboarding's own setup wizard finishes
// (not instead of/during it) - gated on the Settings → This installation →
// Feature tour checkbox (settings.js), and marked shown immediately so a
// second launch never re-fires it even if something below throws.
const maybeAutoShowTour = async () => {
  try {
    const [shown, settings] = await Promise.all([invoke("has_shown_tour"), invoke("get_ui_settings")]);
    if (shown || !settings.tourAutoShow) return;
    await invoke("mark_tour_shown");
    startTour();
  } catch (err) {
    console.error("couldn't check whether to auto-show the tour:", err);
  }
};

invoke("has_completed_onboarding").then((done) => {
  if (done) {
    maybeAutoShowTour();
  } else {
    // Brand new install - onboarding's welcome panel is about to show;
    // wait for it to actually finish rather than firing underneath it.
    document.addEventListener("beedance:onboarding-complete", maybeAutoShowTour, { once: true });
  }
});

// Settings → This installation → Feature tour - the only control over
// whether maybeAutoShowTour is allowed to fire at all. Doesn't affect the
// manual "Take the tour" header button either way.
const tourAutoShowToggle = document.getElementById("tour-auto-show-toggle");

invoke("get_ui_settings").then((settings) => {
  tourAutoShowToggle.checked = settings.tourAutoShow !== false;
});

tourAutoShowToggle.addEventListener("change", async () => {
  try {
    await invoke("set_ui_settings", { settings: { tourAutoShow: tourAutoShowToggle.checked } });
  } catch (err) {
    console.error("couldn't save the tour auto-show preference:", err);
  }
});
