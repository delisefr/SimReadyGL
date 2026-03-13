import './style.css';
import { SceneManager } from './viewer/SceneManager.js';
import { CameraController } from './viewer/CameraController.js';
import { SimReadyLoader } from './viewer/SimReadyLoader.js';
import { AssetBrowser } from './ui/AssetBrowser.js';
import { UIManager } from './ui/UIManager.js';

class App {
  constructor() {
    this.canvas = document.getElementById('viewport');
    this.scene = new SceneManager(this.canvas);
    this.camera = new CameraController(this.scene.camera, this.canvas, this.scene);
    this.loader = new SimReadyLoader();
    this.browser = new AssetBrowser(this);
    this.ui = new UIManager(this);

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
