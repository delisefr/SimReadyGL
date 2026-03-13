const S3_BASE = 'https://simready.s3.us-east-1.amazonaws.com';
const INDEX_URL = `${S3_BASE}/index.json`;

export class AssetBrowser {
  constructor(app) {
    this.app = app;
    this.items = [];
    this.categories = [];
    this.activeCategory = 'All';
    this.searchQuery = '';
    this.isOpen = false;
    this.indexLoaded = false;

    this.panel = document.getElementById('asset-browser');
    this.grid = document.getElementById('asset-grid');
    this.categoriesEl = document.getElementById('asset-categories');
    this.searchInput = document.getElementById('asset-search');

    this.searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderAssets();
    });

    this.pendingLoad = null;
  }

  async toggle() {
    this.isOpen = !this.isOpen;
    this.panel.classList.toggle('hidden', !this.isOpen);

    if (this.isOpen && !this.indexLoaded) {
      await this.loadIndex();
    }
  }

  close() {
    this.isOpen = false;
    this.panel.classList.add('hidden');
  }

  async loadIndex() {
    if (this.pendingLoad) return this.pendingLoad;

    this.grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-dim)">
        <div class="spinner" style="margin:0 auto 12px"></div>
        Loading asset index (13MB)...
      </div>`;

    this.pendingLoad = (async () => {
      try {
        // Share the index with the loader if already cached
        let data;
        if (this.app.loader.indexData) {
          data = this.app.loader.indexData;
        } else {
          const response = await fetch(INDEX_URL);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          data = JSON.parse(text.replace(/^\uFEFF/, ''));
          this.app.loader.indexData = data;
          // Also build index lookup
          this.app.loader.indexByPath = new Map();
          for (const item of data.items) {
            this.app.loader.indexByPath.set(item.path, item);
          }
        }
        console.log(`Index loaded: ${data.items.length} items`);
        this.processIndex(data.items);
        this.indexLoaded = true;
        this.renderCategories();
        this.renderAssets();
      } catch (err) {
        console.error('Failed to load index:', err);
        this.grid.innerHTML = `
          <div style="grid-column:1/-1;text-align:center;padding:40px;color:#ff4757">
            Failed to load asset index<br>
            <span style="font-size:11px;color:var(--text-dim)">${err.message}</span>
          </div>`;
      }
    })();

    return this.pendingLoad;
  }

  processIndex(rawItems) {
    // Build thumbnail map: usdPath -> thumbnailPath
    const thumbMap = new Map();
    for (const item of rawItems) {
      if (item.path.includes('.thumbs/256x256/')) {
        // Thumbnail name is "filename.usd.png" -> USD file is "filename.usd"
        const thumbName = item.name.replace(/\.png$/i, '');
        const dir = item.path.split('/.thumbs/')[0];
        thumbMap.set(`${dir}/${thumbName}`, item.path);
      }
    }

    console.log(`Thumbnails indexed: ${thumbMap.size}`);

    // Build USD asset list — only include root assets that have thumbnails
    const usdFiles = rawItems.filter(item =>
      /\.(usd|usda|usdc)$/i.test(item.path) &&
      !item.path.includes('/SubUSDs/') &&
      !item.path.includes('_physics.usd') &&
      !item.path.includes('.material.') &&
      thumbMap.has(item.path)
    );

    const categorySet = new Set();

    this.items = usdFiles.map(item => {
      const parts = item.path.split('/');
      const category = parts[0];
      categorySet.add(category);

      return {
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

    this.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.categories = ['All', ...Array.from(categorySet).sort()];

    console.log(`Root assets: ${this.items.length}, categories: ${this.categories.length}`);
  }

  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  renderCategories() {
    this.categoriesEl.innerHTML = '';
    for (const cat of this.categories) {
      const btn = document.createElement('button');
      btn.className = `category-btn${cat === this.activeCategory ? ' active' : ''}`;

      // Count items in category
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
        return item.path.toLowerCase().includes(q) ||
               item.displayName.toLowerCase().includes(q);
      }
      return true;
    });

    const maxShow = 200;
    const showing = filtered.slice(0, maxShow);

    this.grid.innerHTML = '';

    if (filtered.length === 0) {
      this.grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-dim)">No assets found</div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const item of showing) {
      const card = document.createElement('div');
      card.className = 'asset-card';
      card.title = `${item.path}\n${item.sizeFormatted}`;

      const thumbDiv = document.createElement('div');
      thumbDiv.className = 'asset-thumb';

      if (item.thumbnail) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = item.name;
        const thumbUrl = `${S3_BASE}/${this._encodeKey(item.thumbnail)}`;
        img.src = thumbUrl;
        img.onload = () => {
          img.style.opacity = '1';
        };
        img.onerror = (e) => {
          console.warn('Thumbnail failed:', thumbUrl, e);
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
      infoDiv.innerHTML = `
        <div class="name">${this._escapeHtml(item.displayName)}</div>
        <div class="path">${this._escapeHtml(item.subCategory)} &middot; ${item.sizeFormatted}</div>
      `;

      card.appendChild(thumbDiv);
      card.appendChild(infoDiv);

      card.addEventListener('click', () => {
        this.app.loadSimReadyAsset(item.path);
        this.close();
      });

      fragment.appendChild(card);
    }

    this.grid.appendChild(fragment);

    if (filtered.length > maxShow) {
      const more = document.createElement('div');
      more.style.cssText = 'grid-column:1/-1;text-align:center;padding:12px;color:var(--text-dim);font-size:12px';
      more.textContent = `Showing ${maxShow} of ${filtered.length} assets. Refine your search.`;
      this.grid.appendChild(more);
    }
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
