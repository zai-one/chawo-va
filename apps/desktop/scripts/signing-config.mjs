#!/usr/bin/env node
// Writes the electron-builder config for the Windows release build (package.json "build" plus signing)
// to the path given, and tells which signing is on. Signing follows what the CI has, nothing is in the repo:
//   AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER
//     (+ AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET for the login) → Azure Trusted Signing
//   CSC_LINK (+ CSC_KEY_PASSWORD)  → a .pfx certificate through signtool (electron-builder reads both itself)
//   neither                        → unsigned, as before
//   node scripts/signing-config.mjs <out.json>
// With GITHUB_OUTPUT set, also writes signing=<azure|certificate|none> there.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: signing-config.mjs <out.json>');
  process.exit(2);
}
const config = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).build;
const env = (k) => (process.env[k] ?? '').trim();

let signing = 'none';
const azure = ['AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER'];
if (azure.every((k) => env(k))) {
  signing = 'azure';
  // electron-builder takes either signtool or Azure options, not both.
  delete config.win.signtoolOptions;
  config.win.azureSignOptions = {
    endpoint: env('AZURE_SIGN_ENDPOINT'),
    codeSigningAccountName: env('AZURE_SIGN_ACCOUNT'),
    certificateProfileName: env('AZURE_SIGN_PROFILE'),
    publisherName: env('AZURE_SIGN_PUBLISHER'),
  };
} else if (azure.some((k) => env(k))) {
  console.error(`signing: Azure Trusted Signing needs all of ${azure.join(', ')}`);
  process.exit(1);
} else if (env('CSC_LINK')) {
  signing = 'certificate';
}
writeFileSync(out, JSON.stringify(config, null, 2));
console.log(`signing: ${signing}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `signing=${signing}\n`);
