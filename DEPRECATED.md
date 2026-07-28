# This repository is superseded

`SetuHQ/docs` is no longer the source of Setu's developer documentation. It is kept online for
its git history and because a small part of it is still read at runtime (see
[What still lives here](#what-still-lives-here)).

**Replacement:** [`brokentusk/facade/docs-showcase`](https://gitlab.com/brokentusk/facade/docs-showcase) (GitLab)

**Cutover date:** 28 July 2026

## What this repository was

The content half of Setu's docs:

- `content/` — documentation pages as MDX, plus `endpoints.json`, `menuItems.json` and `redirects.json`
- `api-references/` — OpenAPI/Swagger specs, one per product
- `api-playground/` — mock request payloads and `products.json` for [api-playground.setu.co](https://api-playground.setu.co)
- `docs-ingestion/` and `docs-embeddings/` — TypeScript pipelines that chunked and embedded the
  above into Pinecone + S3 for the docs copilot

It had no renderer of its own. The site was built by a separate GitLab repository,
`brokentusk/facade/docs-mdx`, which read this repository's content. The two together served
docs.setu.co, and a docs change usually meant a pull request here plus a deploy there.

## What replaced it

`docs-showcase` is a single Next.js + Fumadocs application that holds content *and* rendering in
one repository. One merge request now changes both a page and the site that serves it.

The RAG pipelines were carried over too: `docs-ingestion/` and `docs-embeddings/` here correspond
to `rag/ingestion/` and `rag/embeddings/` there, wired into that repository's CI.

`brokentusk/facade/docs-mdx` is dormant alongside this repository — it was the renderer for the
same superseded setup.

### Environments

| Site | Served from |
|---|---|
| [docs.setu.co](https://docs.setu.co) | `docs-showcase` → `main` |
| [docs-staging.setu.co](https://docs-staging.setu.co) | `docs-showcase` → `development` |

## Content parity

Content was ported page by page rather than copied — it was re-authored for Fumadocs, so no file
is byte-identical to its counterpart. The baselines at cutover:

| This repository | Ported up to | Landed on |
|---|---|---|
| `main` | `e226a98` | `docs-showcase` → `main` |
| `staging` | `16dcd01` | `docs-showcase` → `development` |

Both were the branch tips on 28 July 2026. `staging` content lands on `development` rather than
`main` because `staging` carried products `main` did not (Signal IQ, UPI Issuance) that were not
yet cleared to go live.

The authoritative, maintained record of parity is `docs/UPSTREAM_SYNC.md` in `docs-showcase`.
Consult it rather than this file if you need to reason about a specific page — it also documents
the deliberate divergences, including pages that exist only in `docs-showcase`, upstream pages
that were intentionally *not* carried over, and the MDX component conversions that were applied.

Two categories of upstream page have no direct counterpart by design, and are not gaps:

- Section landing pages (`some-section.mdx` beside a `some-section/` folder) — in Fumadocs these
  are expressed as a `meta.json` in the folder, or as `some-section/index.mdx`.
- `api-reference.mdx` pages — these are now generated routes rendered from the OpenAPI spec, not
  authored pages.

## What still lives here

- **Git history.** Every revision of every page and spec. Nothing was deleted from this
  repository as part of the migration.
- **The API playground's data, still in production.** `api-playground.setu.co` fetches
  `api-playground/json/…`, `api-playground/products.json` and `api-references/…` from
  `raw.githubusercontent.com/SetuHQ/docs/main/…` at request time. This repository's `main` branch
  is therefore still a live runtime dependency of that site, and `api-playground/README.md`
  still describes the current way to change those mock payloads. This is the one reason not to
  treat `main` as inert.
- **Open branches and pull requests.** Numerous long-lived branches were never merged. Anything
  still wanted must be re-applied to `docs-showcase`; it will not arrive there on its own.

## What to do instead

| You want to… | Do this |
|---|---|
| Edit a page on docs.setu.co | Open a merge request against `docs-showcase` → `main`, editing `content/docs/…`. Changes here have no effect. |
| Edit a page that is only on staging | Same, but target `development`. |
| Add a new product | In `docs-showcase`: add the pages under `content/docs/{category}/{product}/`, a `meta.json` for navigation, and register the product in `product-registry.yaml`. `endpoints.json` and `menuItems.json` here are no longer read. |
| Change an API spec shown on docs.setu.co | Edit the spec in `docs-showcase` under `api-references/`, and update the mirrored copy in `public/api-specs/`. Both must stay in sync. Editing `api-references/` here does **not** update docs.setu.co. |
| Change an API playground mock payload | Still done here, on `main`, under `api-playground/` — see `api-playground/README.md`. Also update the spec in `docs-showcase` if the API itself changed. |
| Change how content is chunked or embedded for the docs copilot | `rag/ingestion/` or `rag/embeddings/` in `docs-showcase`. |
| Find when or why a page changed before the cutover | Read this repository's git history. Pre-cutover history did not transfer to `docs-showcase`. |

If you cannot access `docs-showcase`, the published docs are public at
[docs.setu.co](https://docs.setu.co); ask your Setu contact for repository access.
