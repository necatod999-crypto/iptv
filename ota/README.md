# NOVA IPTV OTA

This repository is used as the free APK storage backend for NOVA IPTV updates.

The Cloudflare Worker admin panel publishes signed APK files to a GitHub Release tagged `novaiptv-ota`. Android clients check the Worker update endpoint and show **Update found → Install** when the published `versionCode` is newer than the installed app.

Do not commit GitHub tokens to this repository. The Worker token is stored only as the Cloudflare secret `GITHUB_TOKEN`.
