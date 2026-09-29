# OpenAgent Goal

The standard Agent Plugin package for OpenAgent Goal Mode. The package carries
the public plugin identity, its Skill, and the GitHub subscription source. The
trusted OpenAgent Runtime owns goal persistence, checkpoint transitions,
`/goal` execution, and the audience of every checkpoint message it emits.

Install or update this package from its GitHub repository in OpenAgent. The
package uses the portable Agent Plugins 1.0.0 format plus the
`extensions.openagent.runtime` binding.

## Message policies

This package declares none. The Runtime owns the `goal_bootstrap` and
`goal_continuation` audiences in its own registration and applies that table to
the messages Goal Mode emits. A policy declared here would be namespaced to
`plugin:goal:<tag>`, which belongs to messages this package's own automation
would print; this package ships no automation, so it could never take effect and
would only add a second entry to the plugin card's policy count.

## Development

This repository ships no scripts: validate it with the validator from an
[OpenAgent Plugin Kit](https://github.com/BANG404/openagent-plugin-kit)
checkout, pointing at this directory.

```bash
bun <plugin-kit>/scripts/validate-plugin.mjs .
```

## License

MIT
