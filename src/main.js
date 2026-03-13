import './style.css';
import JSZip from 'jszip';
import { SceneManager } from './viewer/SceneManager.js';
import { CameraController } from './viewer/CameraController.js';
import { SimReadyLoader } from './viewer/SimReadyLoader.js';
import { AssetBrowser } from './ui/AssetBrowser.js';
import { UIManager } from './ui/UIManager.js';

const S3_BASE = 'https://simready.s3.us-east-1.amazonaws.com';

class App {
  constructor() {
    this.canvas = document.getElementById('viewport');
    this.scene = new SceneManager(this.canvas);
    this.camera = new CameraController(this.scene.camera, this.canvas, this.scene);
    this.loader = new SimReadyLoader();
    this.browser = new AssetBrowser(this);
    this.ui = new UIManager(this);
    this.currentAssetPath = null;

    this.setupDragDrop();
    this.setupURLLoading();
    this.animate();
  }

  setupDragDrop() {
    const dropZone = document.getElementById('drop-zone');
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      dropZone.classList.remove('hidden');
    });

    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0) dropZone.classList.add('hidden');
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      dropZone.classList.add('hidden');

      const files = Array.from(e.dataTransfer.files);
      const usdFile = files.find(f =>
        /\.(usd|usda|usdc|usdz)$/i.test(f.name)
      );
      if (usdFile) {
        await this.loadLocalFile(usdFile);
      }
    });
  }

  setupURLLoading() {
    const params = new URLSearchParams(window.location.search);
    const assetPath = params.get('asset');
    if (assetPath) {
      this.loadSimReadyAsset(assetPath);
    }
  }

  async loadLocalFile(file) {
    this.ui.showLoading(`Loading ${file.name}...`);
    try {
      const buffer = await file.arrayBuffer();
      const group = this.loader.parseBuffer(buffer, file.name);
      this.scene.setModel(group, file.name);
      this.camera.focusOnModel();
      this.ui.setAssetName(file.name);
      this.ui.updateSceneInfo(this.scene);
    } catch (err) {
      console.error('Failed to load file:', err);
      this.ui.showError(`Failed to load: ${err.message}`);
    } finally {
      this.ui.hideLoading();
    }
  }

  async loadSimReadyAsset(assetPath) {
    this.currentAssetPath = assetPath;
    this.ui.showLoading(`Loading ${assetPath.split('/').pop()}...`);
    this.ui.hideTextureProgress();

    // Wire up texture progress tracking
    this.loader.materialMapper.resetTextureProgress();
    this.loader.materialMapper.onTextureProgress = (loaded, total, failed) => {
      this.ui.showTextureProgress(loaded, total, failed);
      // Update scene stats as textures arrive
      if (loaded === total) {
        this.scene.computeStats();
        this.ui.updateSceneInfo(this.scene);
      }
    };

    try {
      const group = await this.loader.loadFromSimReady(assetPath, (progress) => {
        this.ui.updateProgress(progress.percent, progress.detail);
      });
      this.scene.setModel(group, assetPath);
      this.camera.focusOnModel();
      this.ui.setAssetName(assetPath.split('/').pop());
      this.ui.updateSceneInfo(this.scene);
    } catch (err) {
      console.error('Failed to load asset:', err);
      this.ui.showError(`Failed to load: ${err.message}`);
    } finally {
      this.ui.hideLoading();
    }
  }

  async downloadCurrentAsset() {
    if (!this.currentAssetPath) return;

    const assetDir = this.loader.dirPath(this.currentAssetPath);
    const assetName = assetDir.split('/').pop();

    this.ui.showLoading('Preparing download...');

    try {
      await this.loader.getIndex();

      // Collect all directories needed (asset dir + referenced component dirs)
      const dirs = new Set([assetDir]);
      const { usdPaths } = await this.loader.collectAllReferences(this.currentAssetPath);
      for (const p of usdPaths) {
        const d = this.loader.dirPath(p);
        if (d) dirs.add(d);
      }

      // Find common path prefix for proper zip structure
      const allDirs = [...dirs];
      let base = allDirs[0];
      for (const d of allDirs) {
        while (base && !d.startsWith(base)) {
          base = base.substring(0, base.lastIndexOf('/'));
        }
      }

      // Gather all files from index that belong to these directories
      const files = [];
      if (this.loader.indexData) {
        for (const item of this.loader.indexData.items) {
          let included = false;
          for (const d of dirs) {
            if (item.path.startsWith(d + '/')) { included = true; break; }
          }
          if (!included) continue;
          if (item.path.includes('.thumbs/')) continue;
          if (item.path.includes('_physics.usd')) continue;
          files.push(item);
        }
      }

      if (files.length === 0) {
        this.ui.showError('No files found to download');
        return;
      }

      const zip = new JSZip();
      const folder = zip.folder(assetName);
      const total = files.length;
      const concurrency = 8;
      let downloaded = 0;

      for (let i = 0; i < files.length; i += concurrency) {
        const batch = files.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(async (item) => {
            const url = `${S3_BASE}/${item.path}`;
            let data;
            if (this.loader.fetchCache.has(url)) {
              data = this.loader.fetchCache.get(url);
            } else {
              const resp = await fetch(url);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              data = await resp.arrayBuffer();
            }
            // Relative path preserving directory structure for valid USD references
            const relPath = base ? item.path.substring(base.length + 1) : item.path;
            return { relPath, data };
          })
        );

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            folder.file(r.value.relPath, r.value.data);
          }
        }

        downloaded += batch.length;
        this.ui.updateProgress(
          Math.round(Math.min(downloaded / total, 1) * 90),
          `Downloading ${Math.min(downloaded, total)}/${total} files...`
        );
      }

      this.ui.updateProgress(95, 'Creating ZIP...');
      const blob = await zip.generateAsync({ type: 'blob' });

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${assetName}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

    } catch (err) {
      console.error('Download failed:', err);
      this.ui.showError(`Download failed: ${err.message}`);
    } finally {
      this.ui.hideLoading();
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.camera.update();
    this.scene.render();
    this.ui.updateFPS();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
