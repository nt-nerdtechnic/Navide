# `@navide/plugin-sdk`

The public, framework-neutral SDK for Navide Plugin Platform v2 activation and
typed capability calls.

The package also provides `navide-plugin`, the plugin author CLI from
scaffold to Marketplace listing (walkthrough:
[`docs/en-US/marketplace-publishing.md`](../../docs/en-US/marketplace-publishing.md)):

```text
navide-plugin init <directory> --id <namespace.name> [--name <display name>]
navide-plugin validate <directory> [--target <target>]
navide-plugin package <directory> [--target <target>] [--out <file>]
navide-plugin keygen [--out-dir <directory>] [--name <name>]
navide-plugin sign <package> --key <private-key> [--out <signature>]
navide-plugin verify <package> --key <public-key> --signature <signature>
navide-plugin login [--registry <url>] [--label <label>] [--no-browser] [--insecure-http]
navide-plugin whoami [--registry <url>]
navide-plugin logout [--registry <url>]
navide-plugin publish <package> [--registry <url>] [--target <target>] [--signature <file-or-value>] [--insecure-http]
```

Packaging reads `artifact-files.json` from the staging directory; it contains
the complete explicit `files` list and is not included in the archive. A
frontend-only package uses the `universal` target. A backend or combined
package must use the build host's exact platform-architecture target and carry
one self-contained executable. Signing and verification cover the SHA-256
digest of the complete archive with a detached Ed25519 signature. `login`
signs in through the Registry in the browser and stores a publish token in
`~/.config/navide-plugin/credentials.json` (0600); `publish` uploads to
`--registry`, `$NAVIDE_REGISTRY_URL`, or `https://server.navide.dev/registry`.
Runtime activation remains a Navide responsibility.
