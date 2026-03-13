import * as THREE from 'three';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { USDAParser } from 'three/examples/jsm/loaders/usd/USDAParser.js';
import { USDCParser } from '../parser/USDCParser.js';
import { USDComposer } from '../parser/USDComposer.js';
import { OmniPBRMaterialMapper } from './OmniPBRMaterial.js';

const S3_BASE = 'https://simready.s3.us-east-1.amazonaws.com';
const MAX_FILE_SIZE = 150 * 1024 * 1024;

export class SimReadyLoader {
  constructor() {
    this.loader = new USDLoader();
    this.usdaParser = new USDAParser();
    this.usdcParser = new USDCParser();
    this.materialMapper = new OmniPBRMaterialMapper();
    this.fetchCache = new Map();
    this.indexData = null;
    this.indexByPath = null;
    // Track which file each parsed result came from (path -> parsed data)
    this.parsedByPath = new Map();
  }

  parseBuffer(buffer, filename) {
    return this.loader.parse(buffer);
  }

  async getIndex() {
    if (this.indexData) return this.indexData;
    try {
      const response = await fetch(`${S3_BASE}/index.json`);
      const text = await response.text();
      this.indexData = JSON.parse(text.replace(/^\uFEFF/, ''));
      this.indexByPath = new Map();
      for (const item of this.indexData.items) {
        this.indexByPath.set(item.path, item);
      }
      return this.indexData;
    } catch (err) {
      console.warn('Failed to load S3 index:', err);
      return null;
    }
  }

  resolvePath(baseFolder, refPath) {
    let normalized = (refPath || '').replace(/\\/g, '/');
    normalized = normalized.replace(/[?#].*$/, '');
    if (normalized.startsWith('/')) return normalized.replace(/^\/+/, '');
    const baseParts = (baseFolder || '').split('/').filter(Boolean);
    const refParts = normalized.split('/').filter(Boolean);
    const out = [...baseParts];
    for (const seg of refParts) {
      if (seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    return out.join('/');
  }

  dirPath(p) {
    return (p || '').includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  }

  async collectAllReferences(assetPath, onProgress) {
    const assetDir = this.dirPath(assetPath);
    const allUsdPaths = new Set([assetPath]);
    const allMdlPaths = new Set();
    const visitedDirs = new Set();
    const dirsToVisit = [assetDir, assetDir + '/SubUSDs'];

    // Pre-add files from index in asset dir + SubUSDs
    if (this.indexByPath) {
      for (const [path] of this.indexByPath) {
        if ((path.startsWith(assetDir + '/') || path.startsWith(assetDir + '/SubUSDs/')) &&
            /\.(usd|usda|usdc)$/i.test(path) && !path.includes('_physics')) {
          allUsdPaths.add(path);
        }
      }
    }

    while (dirsToVisit.length > 0) {
      const dir = dirsToVisit.pop();
      if (visitedDirs.has(dir)) continue;
      visitedDirs.add(dir);

      if (onProgress) onProgress(`Scanning ${dir.split('/').pop() || 'root'}...`);
      const manifest = await this._fetchManifest(dir);
      if (!manifest) continue;

      if (manifest.usd_files_scanned) {
        for (const f of manifest.usd_files_scanned) {
          if (!f.includes('_physics')) allUsdPaths.add(dir + '/' + f);
        }
      }

      if (manifest.referenced_usd_paths) {
        for (const ref of manifest.referenced_usd_paths) {
          let normalized = (ref || '').replace(/\\/g, '/').replace(/[?#].*$/, '');
          if (!/\.(usd|usda|usdc|usdz)$/i.test(normalized)) continue;
          if (/^[a-zA-Z]+:/.test(normalized)) continue;
          if (normalized.includes('_physics')) continue;

          const resolved = this.resolvePath(dir, normalized);
          allUsdPaths.add(resolved);

          const refDir = this.dirPath(resolved);
          if (refDir && !visitedDirs.has(refDir)) {
            dirsToVisit.push(refDir);
            dirsToVisit.push(refDir + '/SubUSDs');
          }
        }
      }
    }

    // Scan index for USD and MDL files in ALL visited dirs (catches files missed by manifests)
    if (this.indexByPath) {
      for (const dir of visitedDirs) {
        for (const [path] of this.indexByPath) {
          if (!path.startsWith(dir + '/')) continue;
          if (path.endsWith('.mdl')) {
            allMdlPaths.add(path);
          } else if (/\.(usd|usda|usdc)$/i.test(path) && !path.includes('_physics')) {
            allUsdPaths.add(path);
          }
        }
      }
    }

    return { usdPaths: allUsdPaths, mdlPaths: allMdlPaths };
  }

  async loadFromSimReady(assetPath, onProgress, onUpdate) {
    this.fetchCache.clear();
    this.parsedByPath.clear();

    const progress = { loaded: 0, total: 1, percent: 0, detail: '' };
    const report = (detail) => {
      progress.detail = detail;
      progress.percent = Math.min(95, (progress.loaded / Math.max(1, progress.total)) * 100);
      if (onProgress) onProgress(progress);
    };

    report('Loading asset index...');
    await this.getIndex();

    report('Resolving references...');
    const { usdPaths, mdlPaths } = await this.collectAllReferences(assetPath, report);
    const assetDir = this.dirPath(assetPath);

    // Sort: small first, large deferred
    const allPathsArr = [];
    for (const path of usdPaths) {
      const indexItem = this.indexByPath ? this.indexByPath.get(path) : null;
      const size = indexItem ? indexItem.size : 0;
      if (size > MAX_FILE_SIZE) {
        console.warn(`Skipping oversized: ${path} (${(size/1024/1024).toFixed(1)}MB)`);
        continue;
      }
      allPathsArr.push({ path, size });
    }
    allPathsArr.sort((a, b) => {
      if (a.path === assetPath) return -1;
      if (b.path === assetPath) return 1;
      return a.size - b.size;
    });

    progress.total = allPathsArr.length + mdlPaths.size;
    report(`Loading ${allPathsArr.length} USD + ${mdlPaths.size} MDL files...`);

    // Fetch and parse all USD files
    const assets = {};
    const concurrency = 8;
    await this._fetchAndParseBatch(
      allPathsArr.map(p => p.path), assets, assetDir, concurrency, progress, report
    );

    // Fetch MDL files
    const mdlFiles = await this._fetchMDLFiles(mdlPaths, assetDir, concurrency, progress, report);

    // Compose scene
    report('Composing scene...');
    const group = await this._tryCompose(assets, assetPath, assetDir, mdlFiles);

    if (!group) {
      throw new Error(`Failed to compose: ${assetPath}`);
    }

    // Apply metersPerUnit scaling (USDComposer already handles Z-up -> Y-up)
    const meta = this._getLayerMeta(assets, assetPath);
    const wrapper = new THREE.Group();
    wrapper.name = group.name;

    if (meta.metersPerUnit !== 1) {
      const s = meta.metersPerUnit;
      wrapper.scale.set(s, s, s);
    }

    wrapper.add(group);

    progress.percent = 100;
    report('Done');
    if (onProgress) onProgress(progress);
    return wrapper;
  }

  /**
   * Compose scene with multi-strategy fallback.
   * Materials are applied per-file using each file's own specsByPath and directory.
   */
  /**
   * Get USD layer metadata (upAxis, metersPerUnit) from any parsed file.
   */
  _getLayerMeta(assets, assetPath) {
    // Check root file first, then fall back to any parsed file with valid metadata
    const rootData = assets[assetPath];
    const rootFields = rootData?.specsByPath?.['/']?.fields;
    if (rootFields?.upAxis && rootFields?.metersPerUnit) {
      return {
        upAxis: rootFields.upAxis,
        metersPerUnit: rootFields.metersPerUnit,
      };
    }
    // Root has incomplete metadata — check all parsed files
    for (const [, data] of this.parsedByPath) {
      const fields = data?.specsByPath?.['/']?.fields;
      if (fields?.upAxis && fields?.metersPerUnit) {
        return {
          upAxis: fields.upAxis,
          metersPerUnit: fields.metersPerUnit,
        };
      }
    }
    // Partial match: at least get what we can
    if (rootFields?.upAxis) return { upAxis: rootFields.upAxis, metersPerUnit: rootFields.metersPerUnit || 1 };
    if (rootFields?.metersPerUnit) return { upAxis: 'Y', metersPerUnit: rootFields.metersPerUnit };
    return { upAxis: 'Y', metersPerUnit: 1 };
  }

  async _tryCompose(assets, assetPath, assetDir, mdlFiles) {
    const group = new THREE.Group();
    group.name = assetPath.split('/').pop().replace(/\.(usd|usda|usdc)$/i, '');

    // Strategy 1: USDComposer with root file
    const rootData = assets[assetPath];
    if (rootData && rootData.specsByPath) {
      try {
        const composer = new USDComposer();
        const composed = composer.compose(rootData, assets, {}, assetDir);
        if (composed) {
          let meshCount = 0;
          composed.traverse(c => { if (c.isMesh) meshCount++; });
          if (meshCount > 0) {
            console.log(`Root composition: ${meshCount} meshes`);
            group.add(composed);
            await this._applyMaterialsFromAllFiles(group, mdlFiles, assetDir);
            return group;
          }
        }
      } catch (err) {
        console.warn('Root composition failed:', err.message);
      }
    }

    // Strategy 2: Compose each file individually with root transform mapping
    // Extract transforms from ALL parsed files (especially root/base files)
    const transformMap = this._extractTransformMap(assets, assetPath);

    // Determine upAxis from root USD or any parsed file for coordinate conversion
    let upAxis = assets[assetPath]?.specsByPath?.['/']?.fields?.upAxis;
    if (!upAxis) {
      for (const [, pd] of this.parsedByPath) {
        const ax = pd?.specsByPath?.['/']?.fields?.upAxis;
        if (ax) { upAxis = ax; break; }
      }
    }
    upAxis = upAxis || 'Y';

    // Assembly instances go in a separate group that gets a single Z→Y rotation
    // (instead of each instance having its own, which breaks positioning)
    const assemblyGroup = new THREE.Group();
    assemblyGroup.name = 'assembly';
    let hasAssemblyInstances = false;

    const seen = new Set();
    let totalMeshes = 0;

    for (const [filePath, parsedData] of this.parsedByPath) {
      if (seen.has(parsedData) || !parsedData || !parsedData.specsByPath) continue;
      seen.add(parsedData);

      try {
        const composer = new USDComposer();
        const fileDir = this.dirPath(filePath);
        const composed = composer.compose(parsedData, assets, {}, fileDir);
        if (!composed) continue;

        let meshCount = 0;
        composed.traverse(c => { if (c.isMesh) meshCount++; });
        if (meshCount === 0) continue;

        console.log(`Composed ${filePath}: ${meshCount} meshes`);

        // Apply materials using THIS file's specsByPath (must await before cloning)
        try {
          await this.materialMapper.applyMaterials(
            composed, parsedData.specsByPath, mdlFiles, fileDir
          );
        } catch (err) {
          console.warn(`Material apply failed for ${filePath}:`, err);
        }

        // Check if root USD defines transforms for this file's geometry
        const fileName = filePath.split('/').pop().replace(/\.(usd|usda|usdc)$/i, '');
        const transforms = this._findTransformsForFile(transformMap, fileName);

        if (transforms.length > 0) {
          hasAssemblyInstances = true;
          // This file is referenced multiple times with different positions (assembly)
          // Transforms are in the root USD's coordinate space (Z-up for SimReady)
          for (const xform of transforms) {
            const instance = composed.clone(true);

            // Remove USDComposer's per-file Z→Y rotation since assembly group handles it
            if (upAxis === 'Z' && Math.abs(instance.rotation.x + Math.PI / 2) < 0.01) {
              instance.rotation.x = 0;
            }

            const wrapper = new THREE.Group();
            wrapper.name = xform.name;

            // Set position in the original USD coordinate space (Z-up)
            if (xform.translate) {
              wrapper.position.set(xform.translate[0], xform.translate[1], xform.translate[2]);
            }
            // Set rotation in the original USD coordinate space
            if (xform.rotateXYZ) {
              const r = xform.rotateXYZ;
              wrapper.rotation.set(
                r[0] * Math.PI / 180,
                r[1] * Math.PI / 180,
                r[2] * Math.PI / 180,
                'ZYX'
              );
            }
            if (xform.scale && !(xform.scale[0] === 1 && xform.scale[1] === 1 && xform.scale[2] === 1)) {
              wrapper.scale.set(xform.scale[0], xform.scale[1], xform.scale[2]);
            }
            wrapper.add(instance);
            assemblyGroup.add(wrapper);
            totalMeshes += meshCount;
          }
        } else {
          // Non-assembly file: USDComposer's Z→Y rotation is correct
          group.add(composed);
          totalMeshes += meshCount;
        }
      } catch {
        // Skip
      }
    }

    // Apply Z→Y rotation to entire assembly group (one rotation for all instances)
    if (hasAssemblyInstances) {
      if (upAxis === 'Z') {
        assemblyGroup.rotation.x = -Math.PI / 2;
      }
      group.add(assemblyGroup);
    }

    if (totalMeshes > 0) {
      console.log(`Total: ${totalMeshes} meshes from ${seen.size} files`);
      return group;
    }

    return null;
  }

  /**
   * Extract a map of prim transforms from all parsed files.
   * This captures the transform hierarchy that root/base USDs define for child prims,
   * which is lost when USDCParser can't parse payload/reference fields.
   */
  _extractTransformMap(assets, rootPath) {
    const transforms = new Map(); // primName -> [{name, translate, rotateXYZ, scale}]

    for (const [filePath, parsedData] of this.parsedByPath) {
      if (!parsedData || !parsedData.specsByPath) continue;

      // Strategy A: Extract transforms by scanning xformOp spec paths
      const primTranslates = new Map();
      const primRotates = new Map();
      const primScales = new Map();

      for (const [specPath, spec] of Object.entries(parsedData.specsByPath)) {
        if (!specPath.includes('.xformOp:')) continue;
        const dotIdx = specPath.indexOf('.xformOp:');
        const primPath = specPath.substring(0, dotIdx);
        const opName = specPath.substring(dotIdx + 9);
        const val = spec.fields?.default;
        if (!Array.isArray(val) || val.length < 3) continue;

        if (opName === 'translate') primTranslates.set(primPath, val);
        else if (opName === 'rotateXYZ') primRotates.set(primPath, val);
        else if (opName === 'scale') primScales.set(primPath, val);
      }

      for (const [primPath, translate] of primTranslates) {
        const parts = primPath.split('/');
        if (parts.length < 3) continue;

        const primName = parts[parts.length - 1];
        // Skip empty or garbled prim names
        if (!primName || primName.length === 0) continue;

        const rotateXYZ = primRotates.get(primPath) || [0, 0, 0];
        const scale = primScales.get(primPath) || [1, 1, 1];

        const hasTransform = (translate[0] !== 0 || translate[1] !== 0 || translate[2] !== 0) ||
                            (rotateXYZ[0] !== 0 || rotateXYZ[1] !== 0 || rotateXYZ[2] !== 0);

        if (hasTransform) {
          if (!transforms.has(primName)) transforms.set(primName, []);
          transforms.get(primName).push({
            name: primPath,
            translate,
            rotateXYZ,
            scale,
          });
        }
      }

      // Strategy A is now reliable with the fixed USDCParser
      // (correct STRINGS count prefix and PATHS numElements).
    }

    if (transforms.size > 0) {
      console.log(`Transform map: ${[...transforms.entries()].map(([k,v]) => `${k}(${v.length})`).join(', ')}`);
    }

    return transforms;
  }

  /**
   * Find transforms that should be applied to geometry from a specific file.
   * Matches by prim name to file name using multiple strategies:
   * - Exact: "Pallet_B1" matches file "Pallet_B1.usd"
   * - Numbered suffix: "Pallet_B1_01" matches file "Pallet_B1.usd"
   * - Shared base: "SM_Crate_A01_White_02" matches file "SM_Crate_A01_White_01.usd"
   *   (both strip trailing _\d+ to "SM_Crate_A01_White")
   */
  _findTransformsForFile(transformMap, fileName) {
    const results = [];
    const baseName = fileName.replace(/_inst_base$|_inst$|_base$/, '');
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Strip trailing numeric suffix for broader matching
    // e.g., "SM_Crate_A01_White_01" → "SM_Crate_A01_White"
    const baseNoSuffix = baseName.replace(/_\d+$/, '');

    for (const [primName, xforms] of transformMap) {
      // Exact match
      if (primName === baseName) {
        results.push(...xforms);
        continue;
      }
      // Numbered instance: "Pallet_B1_01" matches baseName "Pallet_B1"
      if (primName.match(new RegExp(`^${esc(baseName)}_\\d+$`))) {
        results.push(...xforms);
        continue;
      }
      // Shared base after stripping trailing number:
      // file "SM_Crate_A01_White_01" → base "SM_Crate_A01_White"
      // prim "SM_Crate_A01_White_02" → base "SM_Crate_A01_White" → match
      if (baseNoSuffix && baseNoSuffix !== baseName) {
        const primNoSuffix = primName.replace(/_\d+$/, '');
        if (primNoSuffix === baseNoSuffix) {
          results.push(...xforms);
        }
      }
    }

    return results;
  }

  /**
   * Get a transform operation value from parsed USD data.
   */
  _getXformOp(parsedData, primPath, opName) {
    const spec = parsedData.specsByPath[`${primPath}.xformOp:${opName}`];
    if (!spec || !spec.fields) return null;
    const val = spec.fields.default;
    if (Array.isArray(val) && val.length >= 3) return val;
    return null;
  }

  /**
   * Apply materials merging specs from all parsed files.
   * Used when root composition succeeds (all meshes in one tree).
   */
  async _applyMaterialsFromAllFiles(group, mdlFiles, assetDir) {
    // For root composition, we need to merge all specs but track source dirs
    // Apply from each file's perspective
    for (const [filePath, parsedData] of this.parsedByPath) {
      if (!parsedData || !parsedData.specsByPath) continue;
      const fileDir = this.dirPath(filePath);
      try {
        await this.materialMapper.applyMaterials(
          group, parsedData.specsByPath, mdlFiles, fileDir
        );
      } catch {
        // Non-fatal
      }
    }
  }

  async _fetchMDLFiles(mdlPaths, assetDir, concurrency, progress, report) {
    const mdlFiles = new Map();
    const mdlPathsArray = [...mdlPaths];
    for (let i = 0; i < mdlPathsArray.length; i += concurrency) {
      const batch = mdlPathsArray.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map(async (path) => {
          try {
            const response = await fetch(`${S3_BASE}/${path}`);
            if (response.ok) {
              const text = await response.text();
              mdlFiles.set(path, text);
              const relPath = this._getRelativePath(assetDir, path);
              if (relPath) { mdlFiles.set(relPath, text); mdlFiles.set('./' + relPath, text); }
              mdlFiles.set(path.split('/').pop(), text);
            }
          } catch { /* non-fatal */ }
          progress.loaded++;
          report(`${progress.loaded}/${progress.total}: ${path.split('/').pop()}`);
        })
      );
    }
    return mdlFiles;
  }

  async _fetchAndParseBatch(paths, assets, assetDir, concurrency, progress, report) {
    for (let i = 0; i < paths.length; i += concurrency) {
      const batch = paths.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (path) => {
          try {
            const buffer = await this.fetchFile(`${S3_BASE}/${path}`);
            progress.loaded++;
            report(`${progress.loaded}/${progress.total}: ${path.split('/').pop()}`);
            return { path, buffer };
          } catch (err) {
            progress.loaded++;
            console.warn(`Failed to fetch: ${path}`, err);
            return null;
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const { path, buffer } = result.value;
          const parsed = this.parseFileBuffer(buffer, path);
          if (parsed) {
            this._storeAsset(assets, path, parsed, assetDir);
            this.parsedByPath.set(path, parsed);
          }
        }
      }
    }
  }

  _storeAsset(assets, path, parsed, rootDir) {
    assets[path] = parsed;
    assets['./' + path] = parsed;
    const fileName = path.split('/').pop();
    assets[fileName] = parsed;

    const relPath = this._getRelativePath(rootDir, path);
    if (relPath) {
      assets[relPath] = parsed;
      assets['./' + relPath] = parsed;
    }

    const pathParts = path.split('/');
    for (let i = 1; i < pathParts.length; i++) {
      const subPath = pathParts.slice(i).join('/');
      if (!assets[subPath]) {
        assets[subPath] = parsed;
        assets['./' + subPath] = parsed;
      }
    }
  }

  async _fetchManifest(dir) {
    try {
      const url = `${S3_BASE}/${dir}/manifest.json`;
      const response = await fetch(url);
      if (!response.ok) return null;
      const text = await response.text();
      return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch { return null; }
  }

  parseFileBuffer(buffer, path) {
    const ext = path.split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'hdr'].includes(ext)) return buffer;
    if (['usd', 'usda', 'usdc'].includes(ext)) {
      try {
        let parsed;
        if (this.isCrateFile(buffer)) {
          parsed = this.usdcParser.parseData(this.toArrayBuffer(buffer));
        } else {
          const text = new TextDecoder().decode(buffer);
          parsed = this.usdaParser.parseData(text);
        }
        if (parsed) this._fixGarbledTransforms(parsed);
        return parsed;
      } catch (err) {
        console.warn(`Failed to parse USD file ${path}:`, err);
        return null;
      }
    }
    return null;
  }

  /**
   * Fix USDCParser bug: double3 transform ops are read as single scalars instead of [x,y,z].
   * E.g. scale [1,1,1] becomes 65793 (0x010101), translate [0,0,0] becomes 0.
   */
  _fixGarbledTransforms(parsed) {
    if (!parsed || !parsed.specsByPath) return;
    for (const [path, spec] of Object.entries(parsed.specsByPath)) {
      if (!spec.fields) continue;
      const typeName = spec.fields.typeName;
      const val = spec.fields.default;

      // Only fix xformOp specs with double3 type where value is scalar
      if (!path.includes('xformOp:')) continue;
      if (typeName !== 'double3' && typeName !== 'float3') continue;
      if (Array.isArray(val)) continue; // Already correct
      if (val === undefined || val === null) continue;

      // Scalar value for a vec3 type — USDCParser bug
      if (path.includes('xformOp:scale')) {
        // Scale default should be [1,1,1]
        spec.fields.default = [1, 1, 1];
      } else if (path.includes('xformOp:translate')) {
        // Translate default should be [0,0,0]
        spec.fields.default = [0, 0, 0];
      } else if (path.includes('xformOp:rotateXYZ') || path.includes('xformOp:rotateX') ||
                 path.includes('xformOp:rotateY') || path.includes('xformOp:rotateZ')) {
        // Rotation default should be [0,0,0]
        spec.fields.default = [0, 0, 0];
      }
    }
  }

  isCrateFile(buffer) {
    const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (view.byteLength < 8) return false;
    return view[0] === 0x50 && view[1] === 0x58 && view[2] === 0x52 && view[3] === 0x2D &&
           view[4] === 0x55 && view[5] === 0x53 && view[6] === 0x44 && view[7] === 0x43;
  }

  toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (data.buffer) {
      if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer;
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return data;
  }

  async fetchFile(url) {
    if (this.fetchCache.has(url)) return this.fetchCache.get(url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    const buffer = await response.arrayBuffer();
    this.fetchCache.set(url, buffer);
    return buffer;
  }

  _getRelativePath(baseDir, targetPath) {
    if (targetPath.startsWith(baseDir + '/')) {
      return targetPath.substring(baseDir.length + 1);
    }
    const baseParts = baseDir.split('/');
    const targetParts = targetPath.split('/');
    let commonLen = 0;
    while (commonLen < baseParts.length && commonLen < targetParts.length &&
           baseParts[commonLen] === targetParts[commonLen]) {
      commonLen++;
    }
    const ups = baseParts.length - commonLen;
    const remainder = targetParts.slice(commonLen);
    const parts = [];
    for (let i = 0; i < ups; i++) parts.push('..');
    parts.push(...remainder);
    return parts.join('/');
  }
}
