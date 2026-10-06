# Documentation

Pi's documentation ships with the package and is reachable three ways: as files under `docs/`, as a navigation catalog in `docs.json`, and as `pi://` URLs inside a pi build.

## Reading the docs from inside pi

The whole corpus is compressed into every build, so a single-file pi binary carries its own documentation:

```text
pi://docs/                     list every page as Markdown links
pi://docs/quickstart.md        one page
```

`pi://docs/quickstart.zh.md` returns the Simplified Chinese page where one exists. Listing reads page names only; a page body is inflated on first read. See [Quickstart](quickstart.md) for the product itself.

Hosts that resolve the protocol call `resolvePiDocsUrl()` and `resolvePiDocsScope()` from the coding agent's `core/pi-protocol` module.

## Bilingual pages

A translated page is a pair of three sibling files in the same directory: the English `name.md`, the Chinese `name.zh.md`, and a `name.i18n.yaml` record. Both pages carry a language switcher directly under their H1, and a pair merges whole - never one language without the other.

The record holds one entry per heading section, keyed by the English heading-slug path, with a hash of the prose on each side. Code fences are excluded from the hashes because they must be byte-identical on both sides. After editing either page, bring the other along and re-record:

```bash
node scripts/verify-doc-bilingual.mjs --write packages/coding-agent/docs/quickstart.md
```

`scripts/doc-bilingual.manifest.json` declares which pages are paired. Anything else named `*.zh.md` or `*.i18n.yaml` under `docs/` is rejected, so the translated set cannot drift from the declared one.

## Size budgets

Every page has a word and a byte ceiling in `scripts/doc-budgets.manifest.json`. The intent is that no single page grows into an unreadable wall: relocate detail to the page that owns it, or condense it, rather than raising the ceiling.

```bash
node scripts/verify-doc-budgets.mjs --list
```

A CJK character counts as one word and any other whitespace-delimited token counts as one, so Chinese and English pages are measured on the same scale.

## Regenerating the inline corpus

`src/core/docs-embed.generated.ts` is generated from `docs/`. After adding or editing a page, run:

```bash
npm --prefix packages/coding-agent run gen:docs-index
```

The test suite compares the committed payload against `docs/` page by page, so a stale payload fails the build without a separate freshness command.