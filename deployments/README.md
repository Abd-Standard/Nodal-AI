# Escrow Deployments

One file per network (`testnet.json`, `futurenet.json`, `mainnet.json`), written by
[`scripts/deploy_escrow.ts`](../scripts/deploy_escrow.ts). Each release appends one entry;
**commit the updated file together with the release** so the deployed contract ID and the
exact code it runs are always traceable.

```json
{
  "network": "testnet",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "deployments": [
    {
      "release": "v1.2.0",
      "contractId": "C...",
      "wasmHash": "<sha256 of the release WASM>",
      "wasmSizeBytes": 12345,
      "deployer": "G...",
      "uploadTxHash": "...",
      "deployTxHash": "...",
      "deployedAt": "2026-10-17T12:00:00.000Z",
      "gitCommit": "<commit the WASM was built from>",
      "rustToolchain": "rustc 1.78.0 (...)"
    }
  ]
}
```

## Release process

1. Tag the release (`vX.Y.Z`). The release workflow builds the WASM with
   `scripts/build_escrow_wasm.sh` and attaches `stellar_payfi_escrow.wasm` and
   `stellar_payfi_escrow.wasm.sha256` to the GitHub Release.
2. Download the `.sha256` artifact and deploy from the tagged commit:

   ```bash
   git checkout vX.Y.Z
   DEPLOYER_SECRET_KEY=S... npm run deploy:escrow -- \
     --network testnet --release vX.Y.Z --artifact ./stellar_payfi_escrow.wasm.sha256
   ```

   Mainnet additionally requires `--confirm-mainnet` and an HTTPS `SOROBAN_RPC_URL`.
3. Commit `deployments/<network>.json`.

The script aborts — without writing the deployments file — if the hash of the local
reproducible build, the code the network stored on upload, or the code read back from the
deployed contract differs from the pinned release hash. Use `--dry-run` to check that a
local build reproduces a release without touching the network.
