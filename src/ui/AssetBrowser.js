const S3_BASE = 'https://simready.s3.us-east-1.amazonaws.com';
const ISAAC_S3_BASE = 'https://omniverse-content-staging.s3.amazonaws.com';
const INDEX_URL = `${S3_BASE}/index.json`;
const ISAAC_INDEX_URL = '/isaac-assets.json';

// In dev, use Vite proxy to avoid CORS. In production, use direct URL (needs CORS configured).
const ISAAC_PROXY_BASE = '/isaac-s3';

export class AssetBrowser {
  constructor(app) {
    this.app = app;
    this.items = [];
    this.categories = [];
    this.activeCategory = 'All';
    this.searchQuery = '';
    this.isOpen = false;

    // Repository state
    this.activeRepo = 'simready'; // 'simready' | 'isaac'
    this.simreadyLoaded = false;
    this.isaacLoaded = false;
    this.simreadyItems = [];
    this.simreadyCategories = [];
    this.isaacItems = [];
    this.isaacCategories = [];

    this.panel = document.getElementById('asset-browser');
    this.grid = document.getElementById('asset-grid');
    this.categoriesEl = document.getElementById('asset-categories');
    this.searchInput = document.getElementById('asset-search');

    this.searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderAssets();
    });

    this._setupRepoTabs();
    this.pendingLoad = null;
  }

  _setupRepoTabs() {
    const tabContainer = document.getElementById('repo-tabs');
    if (!tabContainer) return;

    tabContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-repo]');
      if (!btn) return;

      const repo = btn.dataset.repo;
      if (repo === this.activeRepo) return;

      this.activeRepo = repo;
      tabContainer.querySelectorAll('.repo-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');

      this.activeCategory = 'All';
      this.searchQuery = '';
      this.searchInput.value = '';
      this._activateRepo();
    });
  }

  _activateRepo() {
    if (this.activeRepo === 'simready') {
      if (!this.simreadyLoaded) {
        this.loadSimreadyIndex();
      } else {
        this.items = this.simreadyItems;
        this.categories = this.simreadyCategories;
        this.renderCategories();
        this.renderAssets();
      }
    } else if (this.activeRepo === 'isaac') {
      if (!this.isaacLoaded) {
        this.loadIsaacIndex();
      } else {
        this.items = this.isaacItems;
        this.categories = this.isaacCategories;
        this.renderCategories();
        this.renderAssets();
      }
    }
  }

  async toggle() {
    this.isOpen = !this.isOpen;
    this.panel.classList.toggle('hidden', !this.isOpen);

    if (this.isOpen) {
      this._activateRepo();
    }
  }

  close() {
    this.isOpen = false;
    this.panel.classList.add('hidden');
  }

  async loadSimreadyIndex() {
    if (this.pendingLoad) return this.pendingLoad;

    this.grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-dim)">
        <div class="spinner" style="margin:0 auto 12px"></div>
        Loading SimReady index (13MB)...
      </div>`;

    this.pendingLoad = (async () => {
      try {
        let data;
        if (this.app.loader.indexData) {
          data = this.app.loader.indexData;
        } else {
          const response = await fetch(INDEX_URL);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          data = JSON.parse(text.replace(/^\uFEFF/, ''));
          this.app.loader.indexData = data;
          this.app.loader.indexByPath = new Map();
          for (const item of data.items) {
            this.app.loader.indexByPath.set(item.path, item);
          }
        }
        console.log(`SimReady index loaded: ${data.items.length} items`);
        this._processSimreadyIndex(data.items);
        this.simreadyLoaded = true;

        if (this.activeRepo === 'simready') {
          this.items = this.simreadyItems;
          this.categories = this.simreadyCategories;
          this.renderCategories();
          this.renderAssets();
        }
      } catch (err) {
        console.error('Failed to load SimReady index:', err);
        this.grid.innerHTML = `
          <div style="grid-column:1/-1;text-align:center;padding:40px;color:#ff4757">
            Failed to load SimReady index<br>
            <span style="font-size:11px;color:var(--text-dim)">${err.message}</span>
          </div>`;
      } finally {
        this.pendingLoad = null;
      }
    })();

    return this.pendingLoad;
  }

  async loadIsaacIndex() {
    this.grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-dim)">
        <div class="spinner" style="margin:0 auto 12px"></div>
        Loading Isaac SimReady index...
      </div>`;

    try {
      const response = await fetch(ISAAC_INDEX_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      console.log(`Isaac index loaded: ${data.count} assets`);
      this._processIsaacIndex(data.assets);
      this.isaacLoaded = true;

      if (this.activeRepo === 'isaac') {
        this.items = this.isaacItems;
        this.categories = this.isaacCategories;
        this.renderCategories();
        this.renderAssets();
      }
    } catch (err) {
      console.error('Failed to load Isaac index:', err);
      this.grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:40px;color:#ff4757">
          Failed to load Isaac index<br>
          <span style="font-size:11px;color:var(--text-dim)">${err.message}</span>
        </div>`;
    }
  }

  _processSimreadyIndex(rawItems) {
    const thumbMap = new Map();
    for (const item of rawItems) {
      if (item.path.includes('.thumbs/256x256/')) {
        const thumbName = item.name.replace(/\.png$/i, '');
        const dir = item.path.split('/.thumbs/')[0];
        thumbMap.set(`${dir}/${thumbName}`, item.path);
      }
    }

    const usdFiles = rawItems.filter(item =>
      /\.(usd|usda|usdc)$/i.test(item.path) &&
      !item.path.includes('/SubUSDs/') &&
      !item.path.includes('_physics.usd') &&
      !item.path.includes('.material.') &&
      thumbMap.has(item.path)
    );

    const categorySet = new Set();

    this.simreadyItems = usdFiles.map(item => {
      const parts = item.path.split('/');
      const category = parts[0];
      categorySet.add(category);

      return {
        repo: 'simready',
        path: item.path,
        name: item.name.replace(/\.(usd|usda|usdc)$/i, ''),
        displayName: item.name
          .replace(/\.(usd|usda|usdc)$/i, '')
          .replace(/_/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
        category,
        subCategory: parts.length > 2 ? parts.slice(1, -1).join(' / ') : '',
        size: item.size,
        thumbnail: thumbMap.get(item.path),
        sizeFormatted: this._formatSize(item.size),
      };
    });

    this.simreadyItems.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.simreadyCategories = ['All', ...Array.from(categorySet).sort()];
  }

  _processIsaacIndex(assets) {
    const categorySet = new Set();

    this.isaacItems = assets.map(asset => {
      categorySet.add(asset.category);

      return {
        repo: 'isaac',
        name: asset.name,
        displayName: asset.displayName,
        category: asset.category,
        subCategory: asset.subCategory,
        format: asset.format || 'usd',
        usdPath: asset.usdPath,
        glbPath: asset.glbPath,
        thumbnailPath: asset.thumbnailPath,
        assetDir: asset.assetDir,
        files: asset.files || [],
      };
    });

    this.isaacItems.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.isaacCategories = ['All', ...Array.from(categorySet).sort()];
  }

  _formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  renderCategories() {
    this.categoriesEl.innerHTML = '';
    for (const cat of this.categories) {
      const btn = document.createElement('button');
      btn.className = `category-btn${cat === this.activeCategory ? ' active' : ''}`;

      const count = cat === 'All'
        ? this.items.length
        : this.items.filter(i => i.category === cat).length;
      btn.textContent = `${cat} (${count})`;

      btn.addEventListener('click', () => {
        this.activeCategory = cat;
        this.renderCategories();
        this.renderAssets();
      });
      this.categoriesEl.appendChild(btn);
    }
  }

  renderAssets() {
    const filtered = this.items.filter(item => {
      if (this.activeCategory !== 'All' && item.category !== this.activeCategory) return false;
      if (this.searchQuery) {
        const q = this.searchQuery;
        const searchFields = (item.path || item.name || '').toLowerCase() + ' ' + item.displayName.toLowerCase();
        return searchFields.includes(q);
      }
      return true;
    });

    this.grid.innerHTML = '';

    if (filtered.length === 0) {
      this.grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-dim)">No assets found</div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const item of filtered) {
      const card = document.createElement('div');
      card.className = 'asset-card';

      const thumbDiv = document.createElement('div');
      thumbDiv.className = 'asset-thumb';

      const thumbUrl = this._getThumbnailUrl(item);
      if (thumbUrl) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = item.name;
        img.src = thumbUrl;
        img.onload = () => { img.style.opacity = '1'; };
        img.onerror = () => {
          img.style.display = 'none';
          const span = document.createElement('span');
          span.className = 'placeholder';
          span.innerHTML = '&#x1F4E6;';
          thumbDiv.appendChild(span);
        };
        thumbDiv.appendChild(img);
      } else {
        thumbDiv.innerHTML = '<span class="placeholder">&#x1F4E6;</span>';
      }

      const infoDiv = document.createElement('div');
      infoDiv.className = 'asset-info';
      const sizeStr = item.sizeFormatted ? ` &middot; ${item.sizeFormatted}` : '';
      const formatBadge = item.repo === 'isaac'
        ? `<span class="format-badge ${item.format}">${item.format.toUpperCase()}</span> `
        : '';
      infoDiv.innerHTML = `
        <div class="name">${formatBadge}${this._escapeHtml(item.displayName)}</div>
        <div class="path">${this._escapeHtml(item.subCategory)}${sizeStr}</div>
      `;

      card.appendChild(thumbDiv);
      card.appendChild(infoDiv);

      card.addEventListener('click', () => {
        if (item.repo === 'isaac') {
          this.app.loadIsaacAsset(item);
        } else {
          this.app.loadSimReadyAsset(item.path);
        }
        this.close();
      });

      card.title = item.repo === 'isaac'
        ? `${item.assetDir}\nGLB: ${item.glbPath}`
        : `${item.path}\n${item.sizeFormatted}`;

      fragment.appendChild(card);
    }

    this.grid.appendChild(fragment);
  }

  _getThumbnailUrl(item) {
    if (item.repo === 'isaac' && item.thumbnailPath) {
      // Use proxy for Isaac thumbnails (no CORS on bucket)
      return `${ISAAC_PROXY_BASE}/${this._encodeKey(item.thumbnailPath)}`;
    }
    if (item.repo === 'simready' && item.thumbnail) {
      return `${S3_BASE}/${this._encodeKey(item.thumbnail)}`;
    }
    return null;
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  _encodeKey(key) {
    return (key || '').split('/').map(encodeURIComponent).join('/');
  }
}
