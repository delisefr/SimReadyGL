import * as THREE from 'three';

const S3_BASE = 'https://simready.s3.us-east-1.amazonaws.com';

/**
 * Maps NVIDIA OmniPBR / MDL materials to Three.js MeshPhysicalMaterial.
 */
export class OmniPBRMaterialMapper {
  constructor() {
    this.textureLoader = new THREE.TextureLoader();
    this.textureLoader.setCrossOrigin('anonymous');
    this.textureCache = new Map();
    this.pendingLoads = new Map();
    this.textureBaseUrl = null; // Override S3_BASE when set (e.g. proxy URL)
    // Texture progress tracking
    this.textureTotal = 0;
    this.textureLoaded = 0;
    this.textureFailed = 0;
    this.onTextureProgress = null; // callback(loaded, total, failed)
    this._udimProbeCache = new Map();
  }

  resetTextureProgress() {
    this.textureTotal = 0;
    this.textureLoaded = 0;
    this.textureFailed = 0;
    this.textureCache.clear();
    this.pendingLoads.clear();
  }

  _reportProgress() {
    if (this.onTextureProgress) {
      this.onTextureProgress(this.textureLoaded, this.textureTotal, this.textureFailed);
    }
  }

  waitForTextures() {
    return Promise.all([...this.pendingLoads.values()]);
  }

  parseMDL(mdlSource) {
    const props = {};

    const texRegex = /(\w+):\s*texture_2d\(\s*"([^"]+)"/g;
    let match;
    while ((match = texRegex.exec(mdlSource)) !== null) {
      props[match[1]] = match[2];
    }

    const colorRegex = /(\w+):\s*color\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g;
    while ((match = colorRegex.exec(mdlSource)) !== null) {
      props[match[1]] = [parseFloat(match[2]), parseFloat(match[3]), parseFloat(match[4])];
    }

    const floatRegex = /(\w+):\s*([-\d.]+(?:e[-+]?\d+)?)\s*[,(]/g;
    while ((match = floatRegex.exec(mdlSource)) !== null) {
      if (!(match[1] in props)) {
        props[match[1]] = parseFloat(match[2]);
      }
    }

    const boolRegex = /(\w+):\s*(true|false)/g;
    while ((match = boolRegex.exec(mdlSource)) !== null) {
      if (!(match[1] in props)) {
        props[match[1]] = match[2] === 'true';
      }
    }

    const f2Regex = /(\w+):\s*float2\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g;
    while ((match = f2Regex.exec(mdlSource)) !== null) {
      props[match[1]] = [parseFloat(match[2]), parseFloat(match[3])];
    }

    return props;
  }

  /**
   * Create a Three.js material from texture paths and optional MDL props.
   * texDir is the S3 directory to resolve relative texture paths against.
   */
  createMaterial(texturePaths, mdlProps, texDir, udimInfo = null) {
    const mat = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });

    if (mdlProps) {
      const dc = mdlProps.diffuse_color_constant;
      if (Array.isArray(dc)) mat.color.setRGB(dc[0], dc[1], dc[2]);
      if (mdlProps.metallic_constant !== undefined) mat.metalness = mdlProps.metallic_constant;
      if (mdlProps.reflection_roughness_constant !== undefined) mat.roughness = mdlProps.reflection_roughness_constant;
      if (mdlProps.specular_level !== undefined) {
        mat.specularIntensity = mdlProps.specular_level;
      }
      if (mdlProps.enable_emission) {
        const ec = mdlProps.emissive_color;
        if (Array.isArray(ec)) mat.emissive.setRGB(ec[0], ec[1], ec[2]);
        mat.emissiveIntensity = mdlProps.emissive_intensity ?? 1;
      }
      if (mdlProps.enable_opacity && (mdlProps.opacity_constant ?? 1) < 1) {
        mat.transparent = true;
        mat.opacity = mdlProps.opacity_constant;
      }
      const bumpFactor = mdlProps.bump_factor ?? 1;
      const flipV = mdlProps.flip_tangent_v === true ? -1 : 1;
      mat.normalScale = new THREE.Vector2(bumpFactor, bumpFactor * flipV);
    }

    const uvScale = mdlProps && Array.isArray(mdlProps.texture_scale) ? mdlProps.texture_scale : [1, 1];
    const uvOffset = mdlProps && Array.isArray(mdlProps.texture_translate) ? mdlProps.texture_translate : [0, 0];

    // Helper: routes to UDIM atlas loader when needed
    const loadTex = (texPath, colorSpace) => {
      if (udimInfo && texPath && texPath.includes('<UDIM>')) {
        return this._loadUDIMAtlas(texPath, texDir, colorSpace, uvScale, uvOffset, udimInfo.tiles);
      }
      return this._loadTex(texPath, texDir, colorSpace, uvScale, uvOffset);
    };

    // Load diffuse/albedo texture
    const diffuseTex = texturePaths.diffuse_texture || texturePaths.diffuse_color_texture;
    if (diffuseTex) {
      loadTex(diffuseTex, THREE.SRGBColorSpace)
        .then(t => { if (t) { mat.map = t; mat.needsUpdate = true; } });
    }

    // Normal map
    const normalTex = texturePaths.normalmap_texture;
    if (normalTex) {
      loadTex(normalTex, THREE.NoColorSpace)
        .then(t => { if (t) { mat.normalMap = t; mat.needsUpdate = true; } });
    }

    // Roughness map (standalone)
    const roughTex = texturePaths.reflectionroughness_texture || texturePaths.roughness_texture;
    if (roughTex) {
      loadTex(roughTex, THREE.NoColorSpace)
        .then(t => {
          if (t) {
            mat.roughnessMap = t;
            mat.roughness = 1.0;
            mat.needsUpdate = true;
          }
        });
    }

    // Metallic map (standalone)
    const metalTex = texturePaths.metallic_texture;
    if (metalTex) {
      loadTex(metalTex, THREE.NoColorSpace)
        .then(t => {
          if (t) {
            mat.metalnessMap = t;
            mat.metalness = 1.0;
            mat.needsUpdate = true;
          }
        });
    }

    // ORM packed texture
    const ormTex = texturePaths.ORM_texture;
    const ormEnabled = mdlProps ? mdlProps.enable_ORM_texture : !!ormTex;
    if (ormEnabled && ormTex) {
      loadTex(ormTex, THREE.NoColorSpace)
        .then(t => {
          if (t) {
            mat.aoMap = t;
            mat.aoMapIntensity = 1.0;
            mat.roughnessMap = t;
            mat.roughness = 1.0;
            mat.metalnessMap = t;
            mat.metalness = 1.0;
            mat.needsUpdate = true;
          }
        });
    }

    // Emissive
    const emissiveTex = texturePaths.emissive_color_texture;
    if (emissiveTex) {
      loadTex(emissiveTex, THREE.SRGBColorSpace)
        .then(t => { if (t) { mat.emissiveMap = t; mat.needsUpdate = true; } });
    }

    return mat;
  }

  /**
   * Post-process a composed Three.js scene to apply materials from specsByPath and MDL files.
   *
   * Two-pass approach:
   * 1. Extract texture paths directly from USDC specsByPath shader inputs (most reliable)
   * 2. Fall back to MDL file parsing if available
   */
  async applyMaterials(group, allSpecsByPath, mdlFiles, assetDir) {
    if (!allSpecsByPath || Object.keys(allSpecsByPath).length === 0) {
      console.log('No specsByPath data available');
      return;
    }

    // Step 1: Find all material prim paths and their shader data
    const materials = new Map(); // materialPrimPath -> { mdlSource, textures, shaderPath, props }

    for (const [path, spec] of Object.entries(allSpecsByPath)) {
      const fields = spec.fields || {};

      // Find Shader prims with MDL source
      if (path.endsWith('.info:mdl:sourceAsset') && fields.default) {
        const shaderPath = path.replace('.info:mdl:sourceAsset', '');
        const parts = shaderPath.split('/');
        parts.pop(); // Remove "Shader"
        const matPath = parts.join('/');
        if (!materials.has(matPath)) materials.set(matPath, { textures: {}, props: {} });
        materials.get(matPath).mdlSource = fields.default;
        materials.get(matPath).shaderPath = shaderPath;
      }

      // Find all shader inputs
      const inputMatch = path.match(/^(.+)\/([^/]+)\.inputs:(\w+)$/);
      if (inputMatch && fields.default != null) {
        const matPath = inputMatch[1]; // parent of shader
        const inputName = inputMatch[3];
        if (!materials.has(matPath)) materials.set(matPath, { textures: {}, props: {} });
        if (typeof fields.default === 'string') {
          materials.get(matPath).textures[inputName] = fields.default;
        } else {
          materials.get(matPath).props[inputName] = fields.default;
        }
      }
    }

    // Step 2: Find material bindings (mesh -> material)
    const meshBindings = new Map();
    for (const [path, spec] of Object.entries(allSpecsByPath)) {
      const fields = spec.fields || {};
      if (path.endsWith('.material:binding') && fields.targetPaths) {
        const meshPath = path.replace('.material:binding', '');
        const matPath = fields.targetPaths[0];
        if (matPath) meshBindings.set(meshPath, matPath);
      }
    }

    console.log(`Material pipeline: ${materials.size} materials, ${meshBindings.size} bindings`);

    // Step 3: Create Three.js materials
    const createdMaterials = new Map(); // materialPrimPath -> Three.js material

    for (const [matPath, matData] of materials) {
      // Only apply OmniPBR materials — skip UsdPreviewSurface (handled by USDComposer)
      if (!matData.mdlSource) continue;

      let mdlProps = null;
      let texDir = assetDir;

      if (mdlFiles && mdlFiles.size > 0) {
        const mdlContent = this._findMDLContent(matData.mdlSource, mdlFiles, assetDir);
        if (mdlContent) {
          mdlProps = this.parseMDL(mdlContent.text);
          texDir = mdlContent.dir;
        }
      }

      // Build mdlProps from inline USDC inputs when no MDL file is available
      if (!mdlProps && matData.props && Object.keys(matData.props).length > 0) {
        mdlProps = {};
        for (const [k, v] of Object.entries(matData.props)) {
          mdlProps[k] = v;
        }
      }

      // Merge texture paths: USDC inputs override/supplement MDL
      const texturePaths = {};
      if (mdlProps) {
        // Copy texture paths from MDL
        for (const key of ['diffuse_texture', 'normalmap_texture', 'ORM_texture',
                           'reflectionroughness_texture', 'metallic_texture',
                           'emissive_color_texture']) {
          if (typeof mdlProps[key] === 'string') texturePaths[key] = mdlProps[key];
        }
      }
      // Override with USDC inputs (more authoritative)
      for (const [inputName, inputPath] of Object.entries(matData.textures)) {
        texturePaths[inputName] = inputPath;
      }

      if (Object.keys(texturePaths).length === 0 && !mdlProps) {
        continue; // No texture data at all
      }

      // Probe UDIM tiles if any texture uses UDIM tokens
      let udimInfo = null;
      const firstUDIMTex = Object.values(texturePaths).find(
        p => typeof p === 'string' && p.includes('<UDIM>')
      );
      if (firstUDIMTex) {
        const tiles = await this._probeUDIMTiles(firstUDIMTex, texDir);
        if (tiles.length > 1) {
          const cols = Math.max(...tiles.map(t => t.col)) + 1;
          udimInfo = { cols, tiles };
          console.log(`UDIM detected for ${matPath}: ${tiles.length} tiles, ${cols} columns`);
        }
      }

      console.log(`Creating material for ${matPath}:`, Object.keys(texturePaths));
      const material = this.createMaterial(texturePaths, mdlProps, texDir, udimInfo);
      material.name = matPath.split('/').pop();
      if (udimInfo) material.userData.udimCols = udimInfo.cols;
      createdMaterials.set(matPath, material);
    }

    if (createdMaterials.size === 0) {
      console.log('No materials created from specs or MDL');
      return;
    }

    console.log(`Created ${createdMaterials.size} materials`);

    // Step 4: Apply materials to meshes
    // Build lookup maps for flexible matching
    const matByMeshName = new Map();
    for (const [meshPrimPath, matPrimPath] of meshBindings) {
      const meshName = meshPrimPath.split('/').pop();
      const material = createdMaterials.get(matPrimPath);
      if (material) {
        matByMeshName.set(meshName, material);
      }
    }

    const matByName = new Map();
    for (const [matPath, material] of createdMaterials) {
      matByName.set(matPath.split('/').pop(), material);
    }

    // Only use default material when no explicit bindings exist (simple single-material assets)
    const defaultMaterial = (createdMaterials.size === 1 && meshBindings.size === 0)
      ? createdMaterials.values().next().value
      : null;

    let applied = 0;
    const unmatched = [];

    group.traverse((child) => {
      if (!child.isMesh) return;

      // Try exact match by mesh name
      let material = matByMeshName.get(child.name);

      // Try by current material name
      if (!material && child.material && child.material.name) {
        material = matByName.get(child.material.name);
      }

      // Try by parent name
      if (!material && child.parent) {
        material = matByMeshName.get(child.parent.name);
      }

      // Try grandparent name
      if (!material && child.parent && child.parent.parent) {
        material = matByMeshName.get(child.parent.parent.name);
      }

      // Use default material if only one exists
      if (!material && defaultMaterial) {
        material = defaultMaterial;
      }

      if (material) {
        child.material = material;
        // Remap UVs for UDIM atlas textures
        if (material.userData && material.userData.udimCols > 1) {
          this._remapUDIMUVs(child, material.userData.udimCols);
        }
        applied++;
      } else {
        unmatched.push(child.name);
      }
    });

    console.log(`Applied materials to ${applied} meshes`);
    if (unmatched.length > 0) {
      console.log('Unmatched meshes:', unmatched.slice(0, 10));
    }
  }

  _findMDLContent(mdlSourcePath, mdlFiles, assetDir) {
    let cleanPath = mdlSourcePath.replace(/\\/g, '/');
    if (cleanPath.startsWith('./')) cleanPath = cleanPath.substring(2);

    // Try direct match
    for (const [key, text] of mdlFiles) {
      if (key === cleanPath || key.endsWith('/' + cleanPath) || key.endsWith(cleanPath)) {
        const dir = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : assetDir;
        return { text, dir };
      }
    }

    // Try with asset dir prefix
    const fullPath = assetDir + '/' + cleanPath;
    if (mdlFiles.has(fullPath)) {
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      return { text: mdlFiles.get(fullPath), dir };
    }

    // Try filename only
    const fileName = cleanPath.split('/').pop();
    for (const [key, text] of mdlFiles) {
      if (key.endsWith('/' + fileName) || key === fileName) {
        const dir = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : assetDir;
        return { text, dir };
      }
    }

    return null;
  }

  /**
   * Probe which UDIM tiles exist for a texture template path.
   * Sends parallel HEAD requests for tiles 1001-1009, caches results.
   */
  async _probeUDIMTiles(templatePath, baseDir) {
    let resolved = templatePath.replace(/\\/g, '/');
    if (resolved.startsWith('./')) {
      resolved = baseDir + '/' + resolved.substring(2);
    } else if (!resolved.startsWith('http') && !resolved.startsWith('/')) {
      resolved = baseDir + '/' + resolved;
    }

    const cacheKey = resolved;
    if (this._udimProbeCache.has(cacheKey)) {
      return this._udimProbeCache.get(cacheKey);
    }

    const probes = [];
    const base = this.textureBaseUrl || S3_BASE;
    for (let t = 1001; t <= 1009; t++) {
      const url = `${base}/${resolved.replace(/<UDIM>/g, String(t))}`;
      probes.push(
        fetch(url, { method: 'HEAD' })
          .then(r => r.ok ? { tile: t, col: t - 1001 } : null)
          .catch(() => null)
      );
    }

    const results = await Promise.all(probes);
    const tiles = results.filter(r => r !== null);
    this._udimProbeCache.set(cacheKey, tiles);
    return tiles;
  }

  /**
   * Load all UDIM tiles and combine into a single atlas texture.
   * The atlas is arranged horizontally: tile 1001 at left, 1002 next, etc.
   * Mesh UVs must be remapped: U_new = U / cols.
   */
  async _loadUDIMAtlas(templatePath, baseDir, colorSpace, uvScale, uvOffset, tiles) {
    let resolved = templatePath.replace(/\\/g, '/');
    if (resolved.startsWith('./')) {
      resolved = baseDir + '/' + resolved.substring(2);
    } else if (resolved.startsWith('../')) {
      const baseParts = baseDir.split('/');
      const refParts = resolved.split('/');
      while (refParts[0] === '..') { refParts.shift(); baseParts.pop(); }
      resolved = baseParts.join('/') + '/' + refParts.join('/');
    } else if (!resolved.startsWith('http') && !resolved.startsWith('/')) {
      resolved = baseDir + '/' + resolved;
    }

    const cols = Math.max(...tiles.map(t => t.col)) + 1;
    const cacheKey = `udim:${resolved}:${colorSpace}`;

    if (this.textureCache.has(cacheKey)) {
      return this.textureCache.get(cacheKey).clone();
    }

    this.textureTotal++;
    this._reportProgress();

    // Load all tile images in parallel
    const imagePromises = tiles.map(t => {
      const url = `${this.textureBaseUrl || S3_BASE}/${resolved.replace(/<UDIM>/g, String(t.tile))}`;
      return fetch(url)
        .then(r => r.ok ? r.blob() : null)
        .then(b => b ? createImageBitmap(b) : null)
        .then(img => ({ col: t.col, img }))
        .catch(() => ({ col: t.col, img: null }));
    });

    const images = await Promise.all(imagePromises);
    const validImages = images.filter(i => i.img);

    if (validImages.length === 0) {
      this.textureFailed++;
      this.textureLoaded++;
      this._reportProgress();
      return null;
    }

    // Create atlas canvas (tiles arranged horizontally)
    const tileW = validImages[0].img.width;
    const tileH = validImages[0].img.height;
    const canvas = document.createElement('canvas');
    canvas.width = tileW * cols;
    canvas.height = tileH;
    const ctx = canvas.getContext('2d');

    for (const { col, img } of validImages) {
      ctx.drawImage(img, col * tileW, 0);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(uvScale[0] || 1, uvScale[1] || 1);
    texture.offset.set(uvOffset[0] || 0, uvOffset[1] || 0);
    texture.flipY = true;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    this.textureCache.set(cacheKey, texture);
    this.textureLoaded++;
    this._reportProgress();

    return texture;
  }

  /**
   * Remap mesh UVs for UDIM atlas: divide U by the number of atlas columns.
   */
  _remapUDIMUVs(mesh, cols) {
    const geometry = mesh.geometry;
    if (!geometry) return;
    const uvAttr = geometry.getAttribute('uv');
    if (!uvAttr) return;
    // Skip if already remapped
    if (geometry.userData && geometry.userData.udimRemapped) return;

    const arr = uvAttr.array;
    for (let i = 0; i < arr.length; i += 2) {
      arr[i] = arr[i] / cols;
    }
    uvAttr.needsUpdate = true;

    if (!geometry.userData) geometry.userData = {};
    geometry.userData.udimRemapped = true;
  }

  async _loadTex(texPath, baseDir, colorSpace, uvScale, uvOffset) {
    if (!texPath) return null;

    let resolved = texPath.replace(/\\/g, '/');
    // Replace UDIM token with tile 1001 (standard single-tile UV)
    resolved = resolved.replace(/<UDIM>/g, '1001');
    // Strip Windows absolute path prefix (e.g., "C:/Assets/dt_w/Hospital/..." -> "Hospital/...")
    // Find the S3 key by matching the baseDir's top-level folder in the absolute path
    if (/^[A-Za-z]:\//.test(resolved)) {
      const topFolder = baseDir.split('/')[0];
      const idx = resolved.indexOf('/' + topFolder + '/');
      if (idx !== -1) {
        resolved = resolved.substring(idx + 1);
      } else {
        // Fallback: use just the filename relative to baseDir
        const fileName = resolved.split('/').pop();
        resolved = baseDir + '/Textures/' + fileName;
      }
    } else if (resolved.startsWith('./')) {
      resolved = baseDir + '/' + resolved.substring(2);
    } else if (resolved.startsWith('../')) {
      const baseParts = baseDir.split('/');
      const refParts = resolved.split('/');
      while (refParts[0] === '..') { refParts.shift(); baseParts.pop(); }
      resolved = baseParts.join('/') + '/' + refParts.join('/');
    } else if (!resolved.startsWith('http') && !resolved.startsWith('/')) {
      resolved = baseDir + '/' + resolved;
    }

    const url = resolved.startsWith('http') ? resolved : `${this.textureBaseUrl || S3_BASE}/${resolved}`;
    const cacheKey = url;

    if (this.textureCache.has(cacheKey)) {
      return this.textureCache.get(cacheKey).clone();
    }

    if (this.pendingLoads.has(cacheKey)) {
      const tex = await this.pendingLoads.get(cacheKey);
      return tex ? tex.clone() : null;
    }

    this.textureTotal++;
    this._reportProgress();

    const promise = new Promise((resolve) => {
      this.textureLoader.load(
        url,
        (texture) => {
          texture.colorSpace = colorSpace;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(uvScale[0] || 1, uvScale[1] || 1);
          texture.offset.set(uvOffset[0] || 0, uvOffset[1] || 0);
          texture.flipY = true;
          texture.needsUpdate = true;
          this.textureCache.set(cacheKey, texture);
          this.pendingLoads.delete(cacheKey);
          this.textureLoaded++;
          this._reportProgress();
          resolve(texture);
        },
        undefined,
        (err) => {
          console.warn(`Texture load failed: ${url}`, err);
          this.pendingLoads.delete(cacheKey);
          this.textureFailed++;
          this.textureLoaded++;
          this._reportProgress();
          resolve(null);
        }
      );
    });

    this.pendingLoads.set(cacheKey, promise);
    return promise;
  }
}
