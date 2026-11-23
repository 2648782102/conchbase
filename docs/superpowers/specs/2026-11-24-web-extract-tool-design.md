# Web extraction tool design

## Intent

Give the Agent one useful web-reading capability: fetch a public HTTP(S) page
and return bounded, readable content. The existing `http_fetch` proves the
network boundary but returns raw bytes; HTML pages are noisy and easy to blow
the prompt budget. Web extraction is the first Phase 7 integration that needs
no new credential and can reuse the existing Runtime policy, approval, and
side-effect ledger paths.

## Goals

- Add `web_extract` beside `http_fetch`, opt-in under the same operator flag.
- Keep it out of capability presets: an Agent revision must grant the tool
  explicitly, exactly as `http_fetch` and MCP tools do. Approval wording uses
  the generic `external` path with the tool id and target URL.
- Fetch only `text/html`, `text/plain`, `application/xhtml+xml`, and JSON/XML
  responses; refuse binaries and downloads.
- Strip scripts, styles, SVG, forms, navigation, footers, and comments; return
  a bounded title, readable text, and a small list of absolute links.
- Treat every extracted string as untrusted data. Web text never grants a
  capability, changes policy, or executes a tool.
- Reuse `http_fetch`'s DNS/redirect/content-type checks without weakening them.

## Non-goals

- No browser, JavaScript execution, login, cookie jar, screenshots, or PDFs.
- No search engine, ranking service, hosted API, or new dependency.
- No private-network access by default; `CONCHBASE_ALLOW_PRIVATE_NETWORKS=1`
  remains the operator-only escape hatch.
- No changes to the task, Agent, conversation, or configuration schema.

## Constraints

- Node 24 standard library only; no HTML parsing dependency.
- Existing `sideEffect: 'external'` policy: approval at `standard`, allowed only
  when enabled and granted.
- Output must stay within the existing bounded tool-result envelope with
  evidence, digest, and truncation.
- Any secret-like extracted content must not be replayed into model context.

## Approaches considered

1. **Extend `http_fetch` with a `format` argument.** Reuses one tool id but
   makes its schema and result shape conditional, weakening the hard contract
   that currently makes raw byte fetches auditable.
2. **Add a separate `web_extract` provider built on the same fetch pipeline.**
   Keeps raw fetch and extraction auditable as distinct capabilities, allows
   different output envelopes, and does not change existing behavior.
3. **Add a search/extraction service provider.** Larger scope, needs an owner
   and external credential, and violates the current Phase 7 gate.

Chosen: approach 2. It is the smallest complete slice and preserves the
existing tool contract.

## Design

Extract the fetch pipeline in `src/runtime/http-tools.ts` into a shared internal
function used by both `http_fetch` and `web_extract`. It performs URL vetting,
redirect re-vetting, GET/HEAD validation, byte streaming, and content-type
checks. `web_extract` accepts a URL, an optional maximum result length, and an
optional link limit; it never accepts a method, headers, cookies, or a body.

The argument names are `maxChars` and `linkLimit`. `maxChars` defaults to
8,000, accepts 500–20,000, and counts characters in the final extracted text;
`linkLimit` defaults to 10, accepts 0–25, and caps the link list. Titles cap at
300 characters and each link URL at 500. The raw body cap stays 64 KiB. Values
outside these ranges are refused rather than silently clamped.

HTML extraction is a deliberately small state machine over the bounded body:

- remove `<script>`, `<style>`, `<svg>`, `<noscript>`, `<template>`, `<form>`,
  `<nav>`, `<header>`, `<footer>`, and HTML comments;
- capture `<title>` and safe `<a href>` values;
- decode a bounded set of entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`,
  numeric entities), collapse whitespace, and emit plain text lines;
- resolve relative links against the final URL, keep only `http(s)`, cap the
  number and length, and never include credentials;
- surface extraction status (`ok`, `empty`, `too_large`, `secret_withheld`) and
  evidence facts (final URL, status, content type, bytes, truncation).

There is no content sniffing. `text/html` and `application/xhtml+xml` are
parsed; `text/plain`, JSON, and XML are returned as cleaned text without tag
stripping. HTML mislabelled as plain text stays raw text, which is inert and
bounded. Fetch and argument failures remain `ToolRejectedError`s. The
extraction statuses above are successful, bounded tool results: `empty`
explains that nothing readable was found, `too_large` reports the existing
truncation behavior, and `secret_withheld` returns a short explanation with no
extracted content.

Plain text and JSON/XML responses are returned as cleaned text without HTML
tag stripping. Binary responses keep the current refusal. Secret-like output is
withheld using the existing `containsSecretLike` filter rather than partially
redacted, because partial redaction can leak enough to be useful.

The filter applies to every string that leaves the tool: summary, title, link
URLs, evidence facts, and error detail. It does not inspect internal-only loop
state. If any extracted string is secret-like, the whole result becomes
`secret_withheld`; the digest is computed over the sanitized result. The
summary wraps extracted web content in explicit untrusted-data markers similar
to text attachments, so the model sees data rather than instructions.

## Tests and documentation

Write focused tests first in `tests/http-tools.test.ts` (or a sibling suite):

- a realistic HTML page yields title, visible text, and safe absolute links;
- scripts, styles, hidden navigation, comments, and data URLs are excluded;
- redirects are re-vetted and the final URL resolves relative links;
- non-HTML text remains supported; binary remains refused;
- oversized pages are bounded and report truncation;
- secret-like text is withheld;
- `web_extract` is `external` and absent unless HTTP tools are enabled;
- `web_extract` is not granted by any capability preset;
- result bounds and invalid `maxChars`/`linkLimit` arguments are refused;
- untrusted-data wrapper and secret-withholding cover title, links, evidence,
  and error detail;
- existing `http_fetch` behavior stays unchanged.

Update `docs/ARCHITECTURE.md#tools`, `docs/CURRENT_STATE.md`, and
`docs/PROJECT_PLAN.md` progress notes. No HTTP API contract changes.

## Risks

Regex-based HTML extraction is not a full DOM parser. That is intentional: it
avoids a dependency and treats all markup as untrusted strings. Output may be
imperfect on malformed pages; the tool must fail closed on suspicious content
and remain bounded rather than trying to reconstruct a browser DOM.

DNS rebinding between DNS validation and the request is out of scope for this
slice. Reusing the existing SSRF boundary without weakening it is the goal;
strengthening that boundary is a separate hardening task.
