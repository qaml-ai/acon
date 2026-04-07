Bundle the Apple open source `container` CLI here for packaged desktop builds.

Expected layout:

- `desktop-container/vendor/apple-container/bin/container`

The Electron shell resolves the packaged runtime from:

- `Contents/Resources/desktop/bin/container`
- `Contents/Resources/desktop/container-images/*`

Local development may still fall back to the system `container` install when
`DESKTOP_CONTAINER_REQUIRE_BUNDLED` is not set.
