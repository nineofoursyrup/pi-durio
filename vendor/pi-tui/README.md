# Pi TUI measured-width derivative

This is the explicitly authorized #16 dependency exception, recorded in
`docs/implementation/pi-durio-v1/issue-16/width-exception-authorization.json`.
The installed version is **1.1.0-durio-width.1**, not an unmodified official release.

`upstream/earendil-works-pi-tui-1.1.0.tgz` is the immutable official npm 1.1.0 archive.
`manifest.json` binds its npm integrity, the two-source-file patch, the build script,
TypeScript 5.9.3, and the resulting derivative archive. Original TypeScript sources
are retained in the upstream source maps. Only the width setter, its shared lookup,
and its export change; Editor, selection, wrapping and input code remain upstream.
Generated JavaScript/source maps, declaration exports and derivative metadata are
regenerated. Existing native helpers are copied unchanged.

To rebuild from the checked-in original and patch, with development dependencies
installed, run `node scripts/build-pi-tui-width.mjs` from the repository root.
It works in a temporary package tree, validates the original SHA-512 integrity,
and writes the archive and manifest here. It never patches installed modules.
`npm ci` installs the exact local archive identified by the lock; `npm pack` bundles
that installed dependency and this recipe. Two builds produced identical archive
SHA-256 `90a1f855d1e5f30d9b97c8733ca0a1c3a05ce07d5e95af4e2fed6f553e34f62a`.

The added API is process-wide. The host permits one active renderer and resets the
profile on exit. Every upstream upgrade must recheck the patch and the geometry,
input, selection/copy, native IME, and cleanup checks. Remove this derivative when
an official interface supports the same behavior. Switching to the unmodified
release also requires reverting the host API use; it is not a silent fallback.

Official package source: https://github.com/earendil-works/pi/tree/main/packages/tui
