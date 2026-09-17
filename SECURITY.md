# Security policy

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/neowara/cityroam/security/advisories/new)
rather than a public issue. If you can't use GitHub, email
[cityroamapp@casa-verde.casa](mailto:cityroamapp@casa-verde.casa).

Describe what you did, what happened, and what someone else could do with it. A proof of
concept helps but isn't required.

## What to expect

Cityroam is maintained by one person, so replies take days rather than hours. You'll get
an acknowledgement, an assessment, and either a fix or the reasoning for why there won't
be one. Please leave time for a fix to ship before publishing a write-up.

## Scope

In scope: the app in this repository, including its native modules.

Out of scope:

- The server the app talks to. It is separate and private; the default one is run by the
  maintainer.
- Anything that needs a rooted phone, a modified build, or physical access to an unlocked
  device.
- The board vendors' own apps and firmware.

## Versions

Only the latest release is supported. The app checks for a newer one on launch, and
older builds are expected to be updated rather than patched.
