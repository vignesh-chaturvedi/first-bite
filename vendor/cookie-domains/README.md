# Cookie registry interface provenance

The IDL is copied without modification from Cookie Chain's MIT-licensed
`cookie-mcp` repository:

- Commit: `c4cabe0cf51e99e131b7b0df6eea57c241073b72`
- [IDL source](https://github.com/cookiechain/cookie-mcp/blob/c4cabe0cf51e99e131b7b0df6eea57c241073b72/src/idl/cookie_domains.json)
- [Encoding reference](https://github.com/cookiechain/cookie-mcp/blob/c4cabe0cf51e99e131b7b0df6eea57c241073b72/src/core/domains/program.ts)
- [Naming/price reference](https://github.com/cookiechain/cookie-mcp/blob/c4cabe0cf51e99e131b7b0df6eea57c241073b72/src/core/domains/names.ts)
- IDL SHA-256: `c4287e8660cbacecdc88a77afed5926cb23038048fef6dd30f22bc02e9c79664`

The original license is retained in `LICENSE`. First Bite's small integration
implements only registration, ordinary transfer and primary assignment, with
additional strict account/amount validation. No MCP server runtime is installed.

The IDL is an interface reference, not proof of the executable's behavior or
source verification. Separate read-only RPC inspection downloads the deployed ELF
for local execution and records its hash in `docs/evidence/chain-snapshot.json`.
