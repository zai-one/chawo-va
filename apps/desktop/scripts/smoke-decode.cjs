// Dev-only: decodes files through the hidden Chromium decoder and prints length / peak.
// Usage: electron --no-sandbox scripts/smoke-decode.cjs <file> [file ...]
const { app } = require('electron');
const files = process.argv.slice(process.argv.findIndex((a) => a.endsWith('smoke-decode.cjs')) + 1);
app.whenReady().then(async () => {
  const { chromiumDecode, disposeChromiumDecoder } = require('../out/main/apps/desktop/src/main/chromiumDecoder.js');
  for (const f of files) {
    const t0 = Date.now();
    try {
      const s = await chromiumDecode(f);
      let peak = 0;
      for (let i = 0; i < s.length; i += 7) peak = Math.max(peak, Math.abs(s[i]));
      console.log(`[decode] ${f} ok samples=${s.length} sec=${(s.length / 16000).toFixed(2)} peak=${peak.toFixed(3)} wall=${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`[decode] ${f} FAIL ${e.message}`);
    }
  }
  disposeChromiumDecoder();
  app.exit(0);
});
