# docs/

The repository's documentation, as an [mdBook](https://rust-lang.github.io/mdBook/).
It covers both halves of the project: the contracts in `src/`, and the interface in
`dapp/`.

```bash
mdbook serve docs      # live preview at http://localhost:3000
mdbook build docs      # static site into docs/book/ (gitignored)
```

## Layout

| Path | Owner | Notes |
|---|---|---|
| `src/README.md` | hand-written | Book home page |
| `src/SUMMARY.md` | hand-written | Table of contents — mdBook builds nothing that is not listed here |
| `src/protocol/*.md` | hand-written | The contracts |
| `src/dapp/*.md` | hand-written | The interface |
| `src/brand.md` | hand-written | The press kit — boilerplate, explainers, fact sheet |
| `src/brand/*.svg` | **generated** by `brand/build.py` | Logo copies, so the press chapter renders |
| `src/reference.md` | hand-written | Index for the generated section |
| `src/src/**` | **generated** by `forge doc` | Per-contract API pages |
| `src/*.svg` | copies | Kept in step with the repository root, so the home page renders |
| `book.toml`, `book.css`, `solidity.min.js` | hand-written | Book config and assets |

## Regenerating the contract reference

```bash
docs/regen.sh
```

**Do not run `forge doc` against this directory directly.** It rewrites
`book.toml`, `src/SUMMARY.md` and `src/README.md` from scratch — which drops every
hand-written chapter out of the table of contents and replaces the home page with a
copy of the repository README. `regen.sh` copies in only the part `forge doc` owns.

After regenerating, check that new contracts are added to `src/SUMMARY.md` **and**
`src/reference.md`, and that pages for deleted contracts are removed from both. A
page left behind for a contract that no longer exists is invisible — it is not in
`SUMMARY.md`, so mdBook will not build it and nothing will complain.

## Keeping the prose true

The generated pages track the code automatically; the hand-written chapters do not.
When `src/` changes, the chapters most likely to go stale are:

| Change | Chapters to check |
|---|---|
| Storage layout, new function, new event/error | `protocol/overview.md`, `src/reference.md` |
| Factory, salt rule, clone bytecode, `init` | `protocol/deployment.md` |
| Digest, typehash, bundle format, ERC-1271 | `protocol/signatures.md` |
| Queue, ETA, cancellation, acceleration | `protocol/timelock.md` |
| Executor bypass, guard markers, hook ordering | `protocol/executor.md` |
| Anything in `src/mods/` | `protocol/modules.md`, `src/reference.md` |
| Gas figures — from `forge test --mc GasTest -vv` | `protocol/comparison.md` |
| A new review, or a finding's disposition changing | `protocol/security.md`, `SECURITY.md` |
| Chains, tokens, guardrails, or screens in `dapp/` | `dapp/*.md`, and `dapp/docs.html` |
| A gas figure, a chain, a review, or the logo | `brand.md` **and** `dapp/brand.html` — the press kit quotes all four, in both places |

`dapp/docs.html` is the *user-facing* documentation shipped with the app and is
maintained separately. It answers questions someone has while operating a wallet;
this book is the repository reference. Where they overlap — the deployed addresses,
the clone bytecode, the audit ledger, the guardrails — both need updating.

`dapp/brand.html` is the *published* press kit, and it is the link handed to a
journalist — this book is not deployed anywhere, so `src/brand.md` is only ever
read on GitHub. The two carry the same boilerplate, numbers and fact sheet
deliberately, for two different readers. **Change one and you must change the
other**; the boilerplate especially, since its whole value is that it can be
quoted verbatim and a drifted second copy would put two different sentences in
circulation under the same name.
