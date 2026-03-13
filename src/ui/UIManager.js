export class UIManager {
  constructor(app) {
    this.app = app;

    // Elements
    this.loadingOverlay = document.getElementById('loading-overlay');
    this.loadingText = document.getElementById('loading-text');
    this.loadingDetail = document.getElementById('loading-detail');
    this.progressFill = document.getElementById('progress-fill');
    this.assetNameEl = document.getElementById('asset-name');
    this.sceneInfo = document.getElementById('scene-info');

    // Texture progress
    this.textureProgress = document.getElementById('texture-progress');
    this.textureProgressBar = document.getElementById('texture-progress-bar');
    this.textureProgressText = document.getElementById('texture-progress-text');
    this._texFadeTimer = null;

    // FPS tracking
    this.fpsFrames = 0;
    this.fpsTime = performance.now();
    this.fpsDisplay = document.getElementById('info-fps');

    this.bindButtons();
    this.bindKeyboard();
  }

  bindButtons() {
    const { app } = this;

    // Browse
    document.getElementById('btn-browse').addEventListener('click', () => {
      app.browser.toggle();
    });
    document.getElementById('btn-close-browser').addEventListener('click', () => {
      app.browser.close();
    });

    // Camera modes
    const btnOrbit = document.getElementById('btn-orbit');
    const btnFly = document.getElementById('btn-fly');

    btnOrbit.addEventListener('click', () => {
      app.camera.setMode('orbit');
      btnOrbit.classList.add('active');
      btnFly.classList.remove('active');
    });

    btnFly.addEventListener('click', () => {
      app.camera.setMode('fly');
      btnFly.classList.add('active');
      btnOrbit.classList.remove('active');
    });

    // Reset camera
    document.getElementById('btn-reset-camera').addEventListener('click', () => {
      app.camera.focusOnModel();
    });

    // Wireframe
    const btnWire = document.getElementById('btn-wireframe');
    btnWire.addEventListener('click', () => {
      const isWire = app.scene.toggleWireframe();
      btnWire.classList.toggle('active', isWire);
    });

    // Environment
    const btnEnv = document.getElementById('btn-env');
    btnEnv.addEventListener('click', () => {
      const isEnv = app.scene.toggleEnv();
      btnEnv.classList.toggle('active', isEnv);
    });

    // Grid
    const btnGrid = document.getElementById('btn-grid');
    btnGrid.addEventListener('click', () => {
      const isGrid = app.scene.toggleGrid();
      btnGrid.classList.toggle('active', isGrid);
    });

    // Stats
    const btnStats = document.getElementById('btn-stats');
    btnStats.addEventListener('click', () => {
      const showing = this.sceneInfo.classList.toggle('hidden');
      btnStats.classList.toggle('active', !showing);
    });

    // Download
    document.getElementById('btn-download').addEventListener('click', () => {
      app.downloadCurrentAsset();
    });

    // Fullscreen
    document.getElementById('btn-fullscreen').addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen();
      }
    });

    // Physics
    const btnPhysicsPlay = document.getElementById('btn-physics-play');
    const btnPhysicsStop = document.getElementById('btn-physics-stop');
    const physicsHelp = document.getElementById('physics-help');
    const engineSelect = document.getElementById('physics-engine-select');
    const engineStatus = document.getElementById('physics-engine-status');

    // Wire up engine progress reporting
    app.physics.onEngineProgress = (status, progress) => {
      if (progress < 1) {
        engineStatus.textContent = status;
        engineStatus.classList.remove('hidden');
      } else {
        engineStatus.textContent = status;
        // Fade out after a moment
        setTimeout(() => engineStatus.classList.add('hidden'), 1200);
      }
    };

    btnPhysicsPlay.addEventListener('click', () => {
      app.physics.play();
      btnPhysicsPlay.classList.add('hidden');
      btnPhysicsStop.classList.remove('hidden');
      btnPhysicsStop.classList.add('active');
      engineSelect.disabled = true;
      if (physicsHelp) physicsHelp.classList.remove('hidden');
    });

    btnPhysicsStop.addEventListener('click', () => {
      app.physics.stop();
      btnPhysicsStop.classList.add('hidden');
      btnPhysicsStop.classList.remove('active');
      btnPhysicsPlay.classList.remove('hidden');
      engineSelect.disabled = false;
      if (physicsHelp) physicsHelp.classList.add('hidden');
    });

    engineSelect.addEventListener('change', async () => {
      const name = engineSelect.value;
      engineSelect.disabled = true;
      btnPhysicsPlay.disabled = true;
      engineStatus.classList.remove('hidden');
      engineStatus.textContent = `Loading ${name}...`;
      try {
        await app.physics.setEngine(name);
        btnPhysicsPlay.disabled = false;
      } catch (err) {
        console.error('Failed to load physics engine:', err);
        this.showError(err.message);
        engineStatus.classList.add('hidden');
        // Revert to previous engine
        engineSelect.value = app.physics.engineName;
        btnPhysicsPlay.disabled = false;
      } finally {
        if (!app.physics.running) {
          engineSelect.disabled = false;
        }
      }
    });
  }

  bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;

      switch (e.code) {
        case 'KeyZ':
          document.getElementById('btn-wireframe').click();
          break;
        case 'KeyG':
          document.getElementById('btn-grid').click();
          break;
        case 'KeyI':
          document.getElementById('btn-stats').click();
          break;
        case 'KeyB':
          document.getElementById('btn-browse').click();
          break;
        case 'Escape':
          if (this.app.browser.isOpen) this.app.browser.close();
          if (document.pointerLockElement) document.exitPointerLock();
          break;
      }
    });
  }

  showLoading(text) {
    this.loadingOverlay.classList.remove('hidden');
    this.loadingText.textContent = text;
    this.loadingDetail.textContent = '';
    this.progressFill.style.width = '0%';
  }

  hideLoading() {
    this.loadingOverlay.classList.add('hidden');
  }

  updateProgress(percent, detail) {
    this.progressFill.style.width = `${percent}%`;
    if (detail) this.loadingDetail.textContent = detail;
  }

  showError(message) {
    this.loadingText.textContent = message;
    this.loadingDetail.textContent = '';
    this.progressFill.style.width = '0%';
    setTimeout(() => this.hideLoading(), 3000);
  }

  setAssetName(name) {
    this.assetNameEl.textContent = name.replace(/\.(usd|usda|usdc|usdz)$/i, '').replace(/_/g, ' ');
  }

  updateSceneInfo(scene) {
    document.getElementById('info-meshes').textContent = scene.stats.meshes.toLocaleString();
    document.getElementById('info-tris').textContent = scene.stats.triangles.toLocaleString();
    document.getElementById('info-mats').textContent = scene.stats.materials.toLocaleString();
    document.getElementById('info-texs').textContent = scene.stats.textures.toLocaleString();
  }

  showTextureProgress(loaded, total, failed) {
    if (total === 0) return;
    const pct = loaded / total;

    if (this._texFadeTimer) {
      clearTimeout(this._texFadeTimer);
      this._texFadeTimer = null;
    }

    this.textureProgress.classList.remove('hidden', 'fade-out');
    this.textureProgressBar.style.setProperty('--progress', pct);

    const failStr = failed > 0 ? ` (${failed} failed)` : '';
    if (loaded < total) {
      this.textureProgressText.textContent = `Textures ${loaded}/${total}${failStr}`;
    } else {
      this.textureProgressText.textContent = `Textures loaded${failStr}`;
      this._texFadeTimer = setTimeout(() => {
        this.textureProgress.classList.add('fade-out');
        this._texFadeTimer = setTimeout(() => {
          this.textureProgress.classList.add('hidden');
        }, 500);
      }, 1500);
    }
  }

  hideTextureProgress() {
    this.textureProgress.classList.add('hidden');
    this.textureProgress.classList.remove('fade-out');
  }

  updateFPS() {
    this.fpsFrames++;
    const now = performance.now();
    if (now - this.fpsTime >= 1000) {
      const fps = Math.round(this.fpsFrames * 1000 / (now - this.fpsTime));
      this.fpsDisplay.textContent = fps;
      this.fpsFrames = 0;
      this.fpsTime = now;
    }
  }
}
