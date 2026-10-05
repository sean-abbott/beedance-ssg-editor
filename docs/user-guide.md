# User guide

This is the complete guide to using the app day to day - writing and
publishing pages, working safely alongside other editors, and what every
Settings option actually does. If you just need to install it, see the
top-level README instead; this guide assumes it's already running.

The app is **alpha software** (see the README) - most things here work as
described, but rough edges exist. If something doesn't match this guide,
that's worth reporting.

## First launch

The first time you open the app, a short setup walkthrough appears:

1. **Your name** (optional) - added to a page's contributor list whenever
   you save it. Skip it if you'd rather not be attributed.
2. **Choose a site** - either keep using the small sample site bundled with
   the app (good for trying things out, or for this guide's own examples),
   or clone a real site from its GitHub repository link.

You can change either of these later from **Settings**, and switch which
site you're editing anytime from the folder name at the top of the sidebar.

Right after setup finishes, a short **guided tour** walks through the
sidebar, the Preview button, and the draft indicator in the header - the
three things people most often miss on first use. You can take it again
anytime from the compass icon in the header, and turn off the automatic
first-launch popup in **Settings → This installation → Feature tour** if you
don't want it.

## The Editor

The Editor is where you write. Open a page with the **Open file** search box
in the toolbar (type a page's title or its path - both work), or create a
new one from the **File** menu.

### Frontmatter

Every page starts with a block of metadata - title, date, tags, and so on -
before the actual text. This app shows that block in its own small, muted
area above the body text, with known fields (Title, Date, Tags, Authors, and
a couple of others this app specifically understands) laid out as plain
labeled values rather than raw code. You don't normally need to touch it
directly.

If you do need to - a field this app doesn't have a label for, or something
unusual - click the pencil icon next to "Frontmatter" to edit the raw block
as text, and the checkmark to switch back to the normal view when you're
done. Anything in the block that isn't one of the known fields still shows,
listed below a divider, exactly as it's written in the file - nothing is
ever hidden from you, it just doesn't get the nicer treatment.

### Writing

The toolbar above the text area has the usual formatting shortcuts - bold,
italic, headings, lists, quotes - plus:

- **Link** - select some text first if you want it as the link's label, then
  click Link. Choose **Page on this site** to search for and link to another
  page by its title or path (no need to remember the exact file path), or
  **Web address** for a link to somewhere else. Clicking Link again while
  your cursor is already inside a link re-opens that same link for editing,
  instead of inserting a new one next to it.
- **Insert → Image** - add an image from your computer, or from a web
  address. See **Media**, below, for how images are actually stored.
- **Insert → Date/time** and **Insert → Tags** - edit a page's date or tags
  through a small dialog instead of hand-typing the frontmatter.

Changes save automatically about a second after you stop typing - you'll
rarely need the explicit **Save** button. If a file you have open changes on
disk from outside the app (someone editing the same file another way), a
banner appears offering to reload it.

## Previewing your site

Click **Start preview** in the header to open a separate window showing
your actual site, rendered for real (not a guess at what it'll look like) -
it updates within a moment or two of any edit you make. **Phone preview**
resizes that window to a phone-sized viewport so you can check how things
look on a small screen; it's a standing preference, so it stays set the next
time you open the preview window too. **Preview log** shows the raw output
from the preview server, useful if a page isn't showing up the way you
expect.

## Pages, Media, Tags, and Menu

- **Pages** lists every page and post on the site, filterable by kind,
  title, or tag - click a title to open it directly in the Editor.
- **Media** lists every image used anywhere on the site, with a menu on each
  to rename it, edit its alt text, or move it between local storage and
  cloud storage (if your site uses that - see Settings). It also flags
  images that aren't used anywhere, and external images (hotlinked to
  another site) that you can bring in and host yourself with one click.
- **Tags** lists every tag in use, lets you rename or delete one everywhere
  at once, and marks any tag a page's template depends on by name as
  required (so renaming or deleting it won't quietly break the site).
- **Menu** edits the site's main navigation - add, remove, and reorder the
  links that show up in the site's own nav bar (if the site's theme
  supports that; not all do).

## Working with drafts

A **draft** is a separate, private line of work - your own copy of the site
where you can make changes without anyone seeing them until you're ready.
Nothing you do in a draft touches the live site until you explicitly publish
it.

The pill in the header always shows which draft you're on (or **Live
(main)** when you're editing the live site directly). Click it to open
**Review & checkpoint**, **Publish to live site**, or jump to the **Drafts**
page - except on the Editor page itself, where those same actions already
sit in a banner right above the text area.

**Starting a draft**: go to **Drafts** and give it a name. Everything you do
from that point happens inside the draft, separate from the live site.

**Switching drafts**: also from the Drafts page - pick a different one from
the list, or switch back to the live site. If you have unsaved changes when
you switch, you'll be asked to checkpoint them first; nothing is silently
lost or overwritten.

### Checkpointing and syncing

Think of a **checkpoint** as a save point you can always come back to (this
app's word for what git calls a "commit" - you don't need to know git to use
it). The Drafts page's **Review changes** card shows everything you've
changed since your last checkpoint; describe what changed and click
**Checkpoint** to save that point.

**Send changes** uploads your checkpoints to the shared copy on GitHub, so
others can see your draft and, eventually, you can publish it. **Get
latest** pulls down anything new since you last synced. Both only matter
once GitHub sync is set up (see Settings, below) - without it, checkpointing
still works, it just stays on your own computer.

### Feedback and publishing

Once you've sent a draft's changes, the **Feedback** card on the Drafts page
shows any comments left on it (by anyone reviewing it on GitHub, or from
inside this app - see below). When you're ready, **Publish to live site**
merges your draft into the live site - only you can do this for your own
drafts; someone reviewing it can leave feedback and approve it, but never
publish it for you. If publishing can't be done automatically (a conflict,
or a check that hasn't passed), you'll be pointed to GitHub's own PR page to
finish it there.

If more than one person edits the site, checkpointing or sending changes
while you're directly on the live branch (not a draft) shows a warning
first - not a hard block, just a chance to reconsider and start a draft
instead. See **Settings → This site → Protecting the live site** for how to
turn real GitHub-side protection on too, so a direct push can't bypass
review at all, for anyone, not just inside this app.

### Reviewing someone else's draft

The **Reviews** page lists open drafts from other people (anyone with a
GitHub personal access token configured - see Settings). Opening one checks
it out read-only: you can look at exactly what changed, read and leave
feedback, and approve it - but you can't edit it, and you can't publish it;
only its own author can do that. A banner stays visible the whole time to
remind you you're in read-only review mode, and leaving it (**Exit review**)
returns you to whatever you were working on before.

## Working safely with others

Two separate things help when more than one person edits the same site:

- **A soft reminder in the app** - checkpointing or sending changes directly
  to the live branch (not a draft) shows a confirmation first, once the app
  either detects more than one author has saved a page here, or you've
  turned the "more than one person edits this site" setting on manually
  (Settings → This site). It's a nudge, not a block - "Send anyway" always
  works if you really mean it.
- **Real protection on GitHub** - the only thing that can't be bypassed by
  anyone pushing directly with git, outside this app entirely. The same
  Settings card links to GitHub's own branch-protection settings, or (if
  your personal access token has admin rights on the repository) can set up
  a "require a pull request before merging" rule for you with one click.

## Settings

Settings is split into two sections:

- **This installation** - personal to this computer, never shared or
  committed to the site's repo: your display name, image-preview settings,
  the feature tour toggle, and your own GitHub personal access token.
- **This site** - shared with everyone who edits the site (committed to its
  own repo): image size presets, cloud storage bucket configuration, and the
  multi-editor/branch-protection settings described above. Nothing here
  should ever be secret, since it's visible to anyone with access to the
  site's repository.

### GitHub sync

To sync a site with GitHub (required for drafts to be visible to anyone
else, for feedback, and for publishing), set the repository's remote URL and
a personal access token in **Settings → This installation → GitHub sync**.
The token needs **Contents** (read/write) and **Pull requests** (read/write)
access to that one repository - create a fine-grained token scoped to just
that repo from GitHub's own token settings page (linked right there in
Settings). Saving a token checks that it's valid and has what this app
needs, so you find out right away rather than later when something fails.

## Troubleshooting

- **A security warning on first launch (macOS or Windows)** - see the
  README's "About the security warning on first launch" section for why,
  and exactly how to get past it.
- **An error message mentions git terms you don't recognize** - most common
  git/GitHub failures (an expired token, no network, a rejected push) are
  translated into plain language when this app recognizes them, with the
  original technical error kept underneath for anyone who does want it.
- **Something looks wrong and you're not sure why** - the **Preview log**
  button in the header shows the actual output from the site-building
  process, which is often the fastest way to see what's actually happening.
