# OpenAgent Goal

The standard Agent Plugin package for OpenAgent Goal Mode. The package
declares the public plugin identity, checkpoint message policies, and GitHub
subscription source. The trusted OpenAgent Runtime owns goal persistence,
checkpoint transitions, and `/goal` execution.

Install or update this package from its GitHub repository in OpenAgent. The
package uses the portable Agent Plugins 1.0.0 format plus the
`extensions.openagent.runtime` binding.

## Development

```bash
bun scripts/validate-plugin.mjs .
```

## License

MIT
