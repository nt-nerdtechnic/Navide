# `@navide/plugin-sdk`

The public, framework-neutral SDK for Navide Plugin Platform v2 activation and
typed capability calls.

The package also provides the small external workflow CLI:

```text
navide-plugin validate <directory>
navide-plugin package <directory> [--target <target>] [--out <file>]
navide-plugin sign <package> --key <private-key> [--out <signature>]
navide-plugin verify <package> --key <public-key> --signature <signature>
```

Packaging reads `artifact-files.json` from the staging directory; it contains
the complete explicit `files` list and is not included in the archive. A
frontend-only package uses the `universal` target. A backend or combined
package must use the build host's exact platform-architecture target and carry
one self-contained executable. Signing and verification cover the SHA-256
digest of the complete archive with a detached Ed25519 signature. Publishing
and runtime activation remain Navide responsibilities.
