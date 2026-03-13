#!/usr/bin/env node
/**
 * Automated visual comparison test for SimReady GL.
 * Loads assets in headless Chrome, captures viewport screenshots,
 * downloads S3 thumbnails, and compares them side by side.
 */
import puppeteer from 'puppeteer';
import https from 'https';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:5173';
const S3 = 'https://simready.s3.us-east-1.amazonaws.com';
const OUT_DIR = './test-results';

const TEST_ASSETS = [
  { path: 'HuggingFace/general/Pallet_C1/Pallet_C1.usd', name: 'Pallet_C1', category: 'single' },
  { path: 'HuggingFace/general/Pallet_B1/Pallet_B1.usd', name: 'Pallet_B1', category: 'single' },
  { path: 'Datacenter/Facilities/Cable_Tray/cable_tray_61x299x5cm_A.usd', name: 'Cable_Tray', category: 'single' },
  { path: 'HuggingFace/assembly/Pallets_A1/Pallets_A1.usd', name: 'Pallets_A1', category: 'assembly' },
  { path: 'Datacenter/Network_Switches/NVIDIA/SN3700/SN3700C_01.usd', name: 'SN3700C', category: 'datacenter' },
];

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const handler = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, handler).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    };
    https.get(url, handler).on('error', reject);
  });
}

async function downloadThumbnail(assetPath, outPath) {
  const dir = assetPath.includes('/') ? assetPath.slice(0, assetPath.lastIndexOf('/')) : '';
  const name = assetPath.split('/').pop().replace(/\.(usd|usda|usdc)$/i, '');
  const candidates = [
    `${S3}/${dir}/${name}.png`,
    `${S3}/${dir}/${name}_thumb.png`,
    `${S3}/${dir}/thumbnail.png`,
  ];
  for (const url of candidates) {
    try {
      const buf = await fetchBuffer(url);
      fs.writeFileSync(outPath, buf);
      return true;
    } catch {}
  }
  return false;
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });

  const results = [];

  for (const asset of TEST_ASSETS) {
    console.log(`\nTesting: ${asset.name} (${asset.path})`);
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });

    try {
      // Navigate to viewer with asset parameter
      const url = `${BASE_URL}/?asset=${encodeURIComponent(asset.path)}`;
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

      // Wait for asset to load (poll until loading overlay is hidden or timeout)
      const loadResult = await page.evaluate(async () => {
        // Wait for app to initialize
        while (!window.app) await new Promise(r => setTimeout(r, 200));

        // Wait for loading to complete (max 60s)
        const start = Date.now();
        while (Date.now() - start < 60000) {
          const overlay = document.getElementById('loading-overlay');
          if (overlay && overlay.classList.contains('hidden')) break;
          await new Promise(r => setTimeout(r, 500));
        }

        // Extra time for render
        await new Promise(r => setTimeout(r, 1000));

        // Get scene stats
        let meshCount = 0, triCount = 0;
        try {
          const sceneObj = window.app.scene.scene;
          sceneObj.traverse(c => {
            if (c.isMesh) {
              meshCount++;
              const geo = c.geometry;
              if (geo.index) triCount += geo.index.count / 3;
              else if (geo.attributes.position) triCount += geo.attributes.position.count / 3;
            }
          });
        } catch (e) {
          return { error: e.message, meshCount: 0, triCount: 0 };
        }

        // Check for error message
        const errorEl = document.querySelector('.error-message');
        const error = errorEl ? errorEl.textContent : null;

        return { meshCount, triCount: Math.round(triCount), error };
      });

      // Take screenshot
      const screenshotPath = path.join(OUT_DIR, `${asset.name}_rendered.png`);
      await page.screenshot({ path: screenshotPath });

      // Download thumbnail
      const thumbPath = path.join(OUT_DIR, `${asset.name}_thumbnail.png`);
      const hasThumb = await downloadThumbnail(asset.path, thumbPath);

      const result = {
        name: asset.name,
        path: asset.path,
        category: asset.category,
        meshes: loadResult.meshCount,
        tris: loadResult.triCount,
        error: loadResult.error,
        hasScreenshot: true,
        hasThumbnail: hasThumb,
      };
      results.push(result);

      const status = loadResult.error ? 'FAIL' : loadResult.meshCount > 0 ? 'PASS' : 'WARN';
      console.log(`  ${status}: ${loadResult.meshCount} meshes, ${loadResult.triCount} tris`);
      if (loadResult.error) console.log(`  Error: ${loadResult.error}`);

    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      results.push({
        name: asset.name, path: asset.path, category: asset.category,
        meshes: 0, tris: 0, error: err.message,
        hasScreenshot: false, hasThumbnail: false,
      });
    } finally {
      await page.close();
    }
  }

  await browser.close();

  // Generate HTML report
  const reportHtml = generateReport(results);
  fs.writeFileSync(path.join(OUT_DIR, 'report.html'), reportHtml);
  console.log(`\nReport: ${path.join(OUT_DIR, 'report.html')}`);

  // Summary
  console.log('\n=== SUMMARY ===');
  const passed = results.filter(r => r.meshes > 0 && !r.error);
  const failed = results.filter(r => r.meshes === 0 || r.error);
  console.log(`Passed: ${passed.length}/${results.length}`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name} - ${r.error || '0 meshes'}`);
  }
}

function generateReport(results) {
  const cards = results.map(r => {
    const status = r.error ? 'fail' : r.meshes > 0 ? 'pass' : 'warn';
    return `
    <div class="card ${status}">
      <h3>${r.name} <span class="status">${status.toUpperCase()}</span></h3>
      <div class="images">
        <div>
          <img src="${r.name}_rendered.png" alt="rendered" onerror="this.alt='No screenshot'"/>
          <p>Rendered</p>
        </div>
        <div>
          <img src="${r.name}_thumbnail.png" alt="thumbnail" onerror="this.alt='No thumbnail'"/>
          <p>S3 Thumbnail (Isaac Sim)</p>
        </div>
      </div>
      <div class="stats">
        Meshes: ${r.meshes} | Tris: ${r.tris}
        ${r.error ? `<br><span class="error">Error: ${r.error}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><style>
    body{background:#1a1a2e;color:#eee;font-family:monospace;padding:20px}
    .card{background:#252540;border:2px solid #333;border-radius:8px;margin:10px;padding:15px;display:inline-block;vertical-align:top;width:520px}
    .card.pass{border-color:#2ecc40} .card.fail{border-color:#ff4136} .card.warn{border-color:#ffdc00}
    .images{display:flex;gap:10px} .images img{width:240px;height:240px;object-fit:contain;background:#111;border:1px solid #444}
    .images p{text-align:center;font-size:11px;color:#888}
    .status{font-size:12px;padding:2px 8px;border-radius:4px}
    .pass .status{background:#2ecc40;color:#000} .fail .status{background:#ff4136} .warn .status{background:#ffdc00;color:#000}
    .stats{margin-top:10px;font-size:12px;color:#aaa} .error{color:#ff4136}
    h1{margin-bottom:15px}
  </style></head><body>
    <h1>SimReady GL - Visual Comparison Report</h1>
    <p>Generated: ${new Date().toISOString()}</p>
    ${cards}
  </body></html>`;
}

main().catch(console.error);
