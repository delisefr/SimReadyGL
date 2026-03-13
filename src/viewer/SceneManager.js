import * as THREE from 'three';

export class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.01,
      10000
    );
    this.camera.position.set(3, 2, 5);
    this.camera.lookAt(0, 0, 0);

    // Environment
    this.setupEnvironment();
    this.setupLights();
    this.setupGrid();

    // Model container
    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    // State
    this.wireframe = false;
    this.showGrid = true;
    this.showEnv = true;

    // Stats tracking
    this.stats = { meshes: 0, triangles: 0, materials: 0, textures: 0 };

    window.addEventListener('resize', () => this.onResize());
  }

  setupEnvironment() {
    // Create a rich studio HDRI-like environment for both background and reflections
    this.envMap = this._createEnvMap();
    this.scene.environment = this.envMap;
    this.scene.background = this.envMap;
    this.scene.backgroundBlurriness = 0.8;
    this.scene.backgroundIntensity = 0.4;
    this.scene.environmentIntensity = 1.0;
  }

  _createEnvMap() {
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    pmremGenerator.compileEquirectangularShader();

    // Build a studio-like light scene for the env map
    const envScene = new THREE.Scene();

    // Warm sky dome using hemisphere
    const hemiLight = new THREE.HemisphereLight(0xc8d8e8, 0x3a3520, 1.0);
    envScene.add(hemiLight);

    // Key light — warm, strong, upper right
    const keyLight = new THREE.DirectionalLight(0xffeedd, 3.0);
    keyLight.position.set(5, 10, 5);
    envScene.add(keyLight);

    // Fill light — cool, softer, left side
    const fillLight = new THREE.DirectionalLight(0x8eaacc, 1.5);
    fillLight.position.set(-6, 4, -2);
    envScene.add(fillLight);

    // Rim/back light — subtle blue highlight
    const rimLight = new THREE.DirectionalLight(0x6688bb, 1.0);
    rimLight.position.set(0, 3, -8);
    envScene.add(rimLight);

    // Ground bounce — warm
    const bounceLight = new THREE.DirectionalLight(0xaa8866, 0.4);
    bounceLight.position.set(0, -3, 0);
    envScene.add(bounceLight);

    // Bright area panels (large meshes that show up in reflections)
    const panelGeo = new THREE.PlaneGeometry(8, 6);

    // Right softbox
    const rightPanel = new THREE.Mesh(panelGeo, new THREE.MeshBasicMaterial({ color: 0xfff5e6, side: THREE.DoubleSide }));
    rightPanel.position.set(8, 5, 0);
    rightPanel.rotation.y = -Math.PI / 3;
    envScene.add(rightPanel);

    // Left softbox (cooler)
    const leftPanel = new THREE.Mesh(panelGeo, new THREE.MeshBasicMaterial({ color: 0xd8e4f0, side: THREE.DoubleSide }));
    leftPanel.position.set(-8, 4, 2);
    leftPanel.rotation.y = Math.PI / 3;
    envScene.add(leftPanel);

    // Top panel (overhead soft light)
    const topPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshBasicMaterial({ color: 0xeeeef4, side: THREE.DoubleSide })
    );
    topPanel.position.set(0, 12, 0);
    topPanel.rotation.x = Math.PI / 2;
    envScene.add(topPanel);

    // Ground plane (dark, matte)
    const groundPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshBasicMaterial({ color: 0x1a1a1a, side: THREE.DoubleSide })
    );
    groundPanel.position.set(0, -2, 0);
    groundPanel.rotation.x = -Math.PI / 2;
    envScene.add(groundPanel);

    const envMap = pmremGenerator.fromScene(envScene, 0.04).texture;
    pmremGenerator.dispose();
    return envMap;
  }

  setupLights() {
    // Key directional light with shadows
    this.keyLight = new THREE.DirectionalLight(0xffeedd, 2.5);
    this.keyLight.position.set(5, 10, 7);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 0.1;
    this.keyLight.shadow.camera.far = 100;
    this.keyLight.shadow.camera.left = -20;
    this.keyLight.shadow.camera.right = 20;
    this.keyLight.shadow.camera.top = 20;
    this.keyLight.shadow.camera.bottom = -20;
    this.keyLight.shadow.bias = -0.001;
    this.scene.add(this.keyLight);

    // Fill light
    this.fillLight = new THREE.DirectionalLight(0x8899cc, 0.8);
    this.fillLight.position.set(-5, 5, -3);
    this.scene.add(this.fillLight);

    // Rim light
    this.rimLight = new THREE.DirectionalLight(0x4466aa, 0.5);
    this.rimLight.position.set(0, 3, -8);
    this.scene.add(this.rimLight);

    // Ambient
    this.ambientLight = new THREE.AmbientLight(0x404060, 0.4);
    this.scene.add(this.ambientLight);

    // Hemisphere for natural sky/ground fill
    this.hemiLight = new THREE.HemisphereLight(0x8899bb, 0x445566, 0.4);
    this.scene.add(this.hemiLight);
  }

  setupGrid() {
    this.gridHelper = new THREE.GridHelper(100, 100, 0x333333, 0x252525);
    this.gridHelper.material.opacity = 0.4;
    this.gridHelper.material.transparent = true;
    this.scene.add(this.gridHelper);

    // Ground plane for shadow catching
    const groundGeo = new THREE.PlaneGeometry(200, 200);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.15 });
    this.groundPlane = new THREE.Mesh(groundGeo, groundMat);
    this.groundPlane.rotation.x = -Math.PI / 2;
    this.groundPlane.receiveShadow = true;
    this.scene.add(this.groundPlane);
  }

  setModel(group, name) {
    // Clear existing model
    while (this.modelGroup.children.length > 0) {
      const child = this.modelGroup.children[0];
      this.modelGroup.remove(child);
      this.disposeObject(child);
    }

    if (!group) return;

    // Enable shadows on all meshes
    group.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        // Ensure materials use environment
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {
            if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
              mat.envMapIntensity = 1.0;
              mat.needsUpdate = true;
            }
          });
        }
      }
    });

    this.modelGroup.add(group);

    // Auto-ground: shift model so its bottom sits on Y=0
    const groundBox = new THREE.Box3().setFromObject(group);
    if (groundBox.min.y < -0.001) {
      group.position.y -= groundBox.min.y;
    }

    this.computeStats();

    // Adjust shadow camera to fit model
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const shadowSize = maxDim * 1.5;
    this.keyLight.shadow.camera.left = -shadowSize;
    this.keyLight.shadow.camera.right = shadowSize;
    this.keyLight.shadow.camera.top = shadowSize;
    this.keyLight.shadow.camera.bottom = -shadowSize;
    this.keyLight.shadow.camera.far = maxDim * 5;
    this.keyLight.shadow.camera.updateProjectionMatrix();
  }

  computeStats() {
    let meshes = 0, triangles = 0;
    const materials = new Set();
    const textures = new Set();

    this.modelGroup.traverse((child) => {
      if (child.isMesh) {
        meshes++;
        if (child.geometry) {
          const geo = child.geometry;
          if (geo.index) {
            triangles += geo.index.count / 3;
          } else if (geo.attributes.position) {
            triangles += geo.attributes.position.count / 3;
          }
        }
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {
            materials.add(mat.uuid);
            for (const key of Object.keys(mat)) {
              if (mat[key] && mat[key].isTexture) {
                textures.add(mat[key].uuid);
              }
            }
          });
        }
      }
    });

    this.stats = {
      meshes,
      triangles: Math.round(triangles),
      materials: materials.size,
      textures: textures.size,
    };
  }

  toggleWireframe() {
    this.wireframe = !this.wireframe;
    this.modelGroup.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => { mat.wireframe = this.wireframe; });
      }
    });
    return this.wireframe;
  }

  toggleGrid() {
    this.showGrid = !this.showGrid;
    this.gridHelper.visible = this.showGrid;
    this.groundPlane.visible = this.showGrid;
    return this.showGrid;
  }

  toggleEnv() {
    this.showEnv = !this.showEnv;
    this.scene.environment = this.showEnv ? this.envMap : null;
    this.scene.background = this.showEnv ? this.envMap : new THREE.Color(0x111111);
    return this.showEnv;
  }

  getModelBounds() {
    if (this.modelGroup.children.length === 0) return null;
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    return box;
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  disposeObject(obj) {
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
          for (const key of Object.keys(mat)) {
            if (mat[key] && mat[key].isTexture) {
              mat[key].dispose();
            }
          }
          mat.dispose();
        });
      }
    });
  }
}
