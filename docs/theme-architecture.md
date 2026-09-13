# Theme architecture: compatibility evaluation and cross-backend themes

Two related but separable questions:

1. Can the app evaluate, before or after downloading a theme, whether it will
   actually work with the current site's content?
2. Longer term: a "Beedance theme" concept that either a Zola or a Hugo
   backend can fulfill, so themes aren't tied to whichever SSG the site
   happens to use.

## Grounding: what we already know empirically

The Abridge theme test (vendored via `just add-theme`, built directly with
Zola 0.23.6) showed that swapping themes is not a clean, content-agnostic
operation even within a single engine. Abridge's `templates/index.html`
iterates `section.pages` - a paginated list of child posts - and never
renders the root page's own body text. Our existing `content/_index.md` (a
title plus a paragraph) built without error and rendered an empty-looking
homepage. The theme encodes a structural assumption about what the homepage
*is* (a post listing), not just how it looks. "Did the build succeed" is
necessary but not sufficient evidence that a theme fits a given site's
content.

This matters for both questions above: it's the actual failure mode
compatibility evaluation needs to catch, and it's evidence that a
cross-backend theme abstraction has to reconcile content *shape*, not only
template syntax.

## Question 1: theme compatibility evaluation

Layered checks, in increasing cost and increasing usefulness. Each layer is
independently useful; none requires the others to ship value.

**Layer 1 - engine/version compatibility.** Zola themes declare
`min_version` in `theme.toml`; check it against the app's bundled Zola
version before even downloading the theme's assets. Cheap, catches the exact
failure that blocked the Abridge test initially (bundled sidecar was 0.19.2,
theme needed 0.23.3+).

**Layer 2 - trial build.** Vendor the theme into a scratch copy of the site
(or a temp directory with the real content symlinked/copied in), point
config at it, run a real build. Catches hard failures: missing partials,
template syntax errors, required config keys that are absent entirely.
This is what caught nothing in the Abridge case - the build succeeded - which
is exactly why Layer 2 alone is not enough.

**Layer 3 - static requirements scan.** Parse the theme's own template
source (Tera AST for Zola; Go template AST for Hugo, later) and enumerate
every field access it makes: `page.extra.X`, `config.extra.Y`, taxonomy
names, shortcodes invoked. This produces an inferred requirements manifest
for the theme, generated from its actual behavior rather than relying on the
theme's authors to have documented one (most haven't).

**Layer 4 - content coverage diff.** Cross-reference the Layer 3 manifest
against the current site's actual content and config. Flag fields the
theme's templates reference that are undefined anywhere in the site -
surfaced as specific, actionable warnings ("this theme reads
`config.extra.hero_image`, which isn't set") instead of a silent blank
render.

**Layer 5 - rendered-output sanity check.** Since Tera (and Go templates)
render missing/undefined fields as empty rather than erroring, "the build
succeeded" doesn't mean "the page has content." Compare rendered output
against a baseline - word count, presence of the content body text
somewhere in the output, structural richness - to catch cases like Abridge
where the build is clean but the actual page is boilerplate-only. Could also
build with the theme's own bundled demo content as a reference point for
what "populated" output looks like from this theme.

A real manifest standard - a `beedance-theme.toml` a theme could optionally
ship, declaring its required fields explicitly - would be the highest-value,
lowest-engineering option if theme authors ever adopted it, but can't be
relied on for arbitrary existing themes. Layers 3-5 exist specifically to
infer the same information for themes that don't have one.

## Question 2: a theme concept spanning Zola and Hugo

Three real options, not a single answer - recording the tradeoffs rather
than committing now.

**Option A: Beedance Theme as its own format.** Define a new,
engine-agnostic template/theme authoring format, with Zola and Hugo as
rendering backends that translate it down to their native templating.
Maximum flexibility and portability once built, but it means designing and
maintaining a third templating system expressive enough to replicate what
real Zola and Hugo themes already do, then writing two full compiler
backends for it. Every existing theme in either ecosystem - there are
thousands - would need to be manually ported to use it. This walks back the
founding principle of this whole project (wrap existing SSGs instead of
reimplementing a render pipeline) at the theme layer specifically.

**Option B: Beedance Content Contract plus per-theme adapters.** Define
Beedance's own canonical content model (frontmatter shape, taxonomy
conventions, section/page structure) as the thing a user actually authors
against. Themes stay unmodified, native Zola or Hugo themes, each rendered
by its own engine. A thin per-theme adapter mapping - not a new template
language, just a small config translating Beedance's canonical field names
to whatever a specific theme happens to expect - bridges the two. This
preserves "use the ecosystem's themes as-is" while giving content authors a
stable, engine-agnostic authoring surface. Cost: adapter mappings are
per-theme curation work, ongoing, not a one-time build.

**Option C: don't abstract content models across engines at all.**
Standardize only on *operations* across backends (build, serve, list
templates, detect external changes - the adapter interface already sketched
for pluggable SSGs), and treat "does this specific theme fit my content" as
the Question 1 compatibility-check problem, per theme, not something
architecturally unified across engines. A Zola theme and a Hugo theme stay
genuinely different things; picking one is closer to picking an SSG than
picking a skin. Cheapest option. Gives up the "swap seamlessly between a
Zola theme and a Hugo theme" goal, but the Abridge finding suggests that
goal may cost more than it's worth: content adaptation is already required
on a same-engine theme swap, so cross-engine portability isn't obviously
giving up much *more* than same-engine theme swaps already require.

**Where this leaves things:** build the Question 1 tooling first regardless
of which long-term option gets picked - it's needed either way, and its
output (a theme's inferred requirements manifest, a content coverage report)
is exactly the artifact Option B's adapter-mapping approach would need to
exist anyway. Using that tooling against a handful of real Zola themes *and*
a handful of real Hugo themes will produce the evidence needed to judge
whether Option B's curation burden is actually sustainable, or whether
Option C's lower ceiling is the pragmatic one.

## Open questions, deliberately unresolved

- Should Hugo support exist at all before the compatibility-check tooling
  has proven itself on Zola alone? Go template analysis (Layer 3) is a
  different, likely harder, parsing problem than Tera.
- Is per-theme adapter curation (Option B) viable solo, or does it only make
  sense against a small, explicitly supported theme allowlist rather than
  "any theme on the internet"?
- If Option B is chosen, where does Beedance's canonical content model
  actually diverge from plain Zola/Hugo frontmatter conventions, and would
  that divergence be tolerable for someone migrating an existing real site
  in, rather than starting fresh?
