import * as THREE from 'three';
import { CannonEngine } from './physics/CannonEngine.js';
import { PhysXEngine } from './physics/PhysXEngine.js';
import { NewtonEngine } from './physics/NewtonEngine.js';

const ENGINES = {
  'cannon-es': () => new CannonEngine(),
  'PhysX':     () => new PhysXEngine(),
  'Newton':    () => new NewtonEngine(),
};

export const ENGINE_NAMES = Object.keys(ENGINES);

export class PhysicsManager {
  constructor(sceneManager, camera, canvas) {
    this.sceneManager = sceneManager;
    this.camera = camera;
    this.canvas = canvas;

    // Engine
    this.engine = null;
    this.engineName = 'cannon-es';
    this._engineReady = false;
    this._initPromise = null;

    /** @type {function(string, number)|null} Called with (status, progress 0-1) */
    this.onEngineProgress = null;

    // Physics body tracking
    // Each entry: { body, root, meshes, offset, center }
    this.bodies = [];
    this.savedState = [];

    // Simulation state
    this.running = false;

    // Grab state
    this.grabbing = false;
    this.grabbedEntry = null;
    this.grabConstraint = null;
    this.grabPlaneDistance = 0;

    // Raycaster for picking
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Input
    this.shiftDown = false;
    this._bindInput();

    // Initialize default engine
    this._initEngine('cannon-es');
  }

  /**
   * Switch to a different physics engine. Stops current simulation.
   * @param {string} name - One of ENGINE_NAMES
   * @returns {Promise<void>}
   */
  async setEngine(name) {
    if (!ENGINES[name]) throw new Error(`Unknown physics engine: ${name}`);
    if (name === this.engineName && this._engineReady) return;

    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.clearBodies();

    if (this.engine) {
      this.engine.dispose();
      this.engine = null;
    }

    this.engineName = name;
    this._engineReady = false;

    await this._initEngine(name);

    return this._initPromise;
  }

  async _initEngine(name) {
    this.engine = ENGINES[name]();
    this.engine.onProgress = (status, progress) => {
      if (this.onEngineProgress) this.onEngineProgress(status, progress);
    };
    this._initPromise = this.engine.init().then(() => {
      this.engine.createWorld({ x: 0, y: -9.81, z: 0 });
      this.engine.createGroundPlane(0.5, 0.3);
      this._engineReady = true;
    });
    return this._initPromise;
  }

  // --- Body management ---

  buildBodies() {
    this.clearBodies();
    if (!this._engineReady) return;

    const modelGroup = this.sceneManager.modelGroup;
    if (!modelGroup || modelGroup.children.length === 0) return;

    const meshes = [];
    modelGroup.traverse((child) => {
      if (child.isMesh && child.geometry) meshes.push(child);
    });
    if (meshes.length === 0) return;

    const rootGroup = modelGroup.children[0];
    const bodyGroups = this._groupMeshesByParent(meshes, rootGroup);

    for (const group of bodyGroups) {
      this._createBodyForGroup(group);
    }

    this._saveState();
  }

  _groupMeshesByParent(meshes, rootGroup) {
    const groups = new Map();
    for (const mesh of meshes) {
      let ancestor = mesh;
      while (ancestor.parent && ancestor.parent !== rootGroup && ancestor.parent !== this.sceneManager.modelGroup) {
        ancestor = ancestor.parent;
      }
      const key = ancestor.uuid;
      if (!groups.has(key)) {
        groups.set(key, { root: ancestor, meshes: [] });
      }
      groups.get(key).meshes.push(mesh);
    }
    return [...groups.values()];
  }

  _createBodyForGroup(group) {
    const { root, meshes } = group;

    const bbox = new THREE.Box3();
    for (const mesh of meshes) {
      bbox.union(new THREE.Box3().setFromObject(mesh));
    }

    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());

    if (size.length() < 0.001) return;

    const halfExtents = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };

    // Reasonable mass: ~10 kg/m^3 (light props), clamped to sensible range
    const volume = size.x * size.y * size.z;
    const mass = Math.max(0.5, Math.min(50, volume * 10));

    // Get the world-space offset from root's world position to bbox center
    const rootWorldPos = new THREE.Vector3();
    root.getWorldPosition(rootWorldPos);
    const offset = center.clone().sub(rootWorldPos);

    const body = this.engine.createBoxBody(
      halfExtents,
      { x: center.x, y: center.y, z: center.z },
      null,
      mass
    );

    this.bodies.push({ body, root, meshes, offset, center: center.clone() });
  }

  _saveState() {
    this.savedState = this.bodies.map(entry => ({
      bodyTransform: this.engine.getBodyTransform(entry.body),
      rootPosition: entry.root.position.clone(),
      rootQuaternion: entry.root.quaternion.clone(),
      rootScale: entry.root.scale.clone(),
    }));
  }

  clearBodies() {
    if (this.engine && this._engineReady) {
      for (const entry of this.bodies) {
        this.engine.removeBody(entry.body);
      }
    }
    this.bodies = [];
    this.savedState = [];
  }

  // --- Simulation control ---

  play() {
    if (!this._engineReady) return;

    if (this.bodies.length === 0) {
      this.buildBodies();
    }
    if (this.bodies.length === 0) return;

    for (const entry of this.bodies) {
      this.engine.wakeBody(entry.body);
    }

    this.running = true;
  }

  stop() {
    this.running = false;
    if (this.grabbing) this._releaseGrab();
    if (!this._engineReady) return;

    for (let i = 0; i < this.bodies.length; i++) {
      const entry = this.bodies[i];
      const saved = this.savedState[i];
      if (!saved) continue;

      this.engine.setBodyTransform(entry.body, saved.bodyTransform.position, saved.bodyTransform.quaternion);
      this.engine.zeroVelocity(entry.body);
      this.engine.sleepBody(entry.body);

      entry.root.position.copy(saved.rootPosition);
      entry.root.quaternion.copy(saved.rootQuaternion);
      entry.root.scale.copy(saved.rootScale);
    }
  }

  update(dt) {
    if (!this.running || !this._engineReady) return;

    this.engine.step(dt);

    for (const entry of this.bodies) {
      const t = this.engine.getBodyTransform(entry.body);

      const bodyPos = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
      const bodyQuat = new THREE.Quaternion(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);

      // Compute desired world position for the root object:
      // bodyPos is the bbox center in world space, offset is (bboxCenter - rootWorldPos)
      const rotatedOffset = entry.offset.clone().applyQuaternion(bodyQuat);
      const desiredWorldPos = bodyPos.clone().sub(rotatedOffset);

      // Convert world position to local space via parent
      if (entry.root.parent) {
        entry.root.parent.updateWorldMatrix(true, false);
        entry.root.position.copy(
          desiredWorldPos.applyMatrix4(
            new THREE.Matrix4().copy(entry.root.parent.matrixWorld).invert()
          )
        );
        // Convert world quaternion to local
        const parentQuat = new THREE.Quaternion();
        entry.root.parent.getWorldQuaternion(parentQuat);
        entry.root.quaternion.copy(parentQuat.invert().multiply(bodyQuat));
      } else {
        entry.root.position.copy(desiredWorldPos);
        entry.root.quaternion.copy(bodyQuat);
      }
    }
  }

  // --- Grab mechanics ---

  _bindInput() {
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));

    document.addEventListener('keydown', (e) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.shiftDown = true;
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.shiftDown = false;
        if (this.grabbing) this._releaseGrab();
      }
    });
  }

  _onPointerDown(e) {
    if (!this.running || !this.shiftDown || e.button !== 0) return;

    this._updateMouse(e);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const meshList = [];
    for (const entry of this.bodies) {
      meshList.push(...entry.meshes);
    }

    const intersects = this.raycaster.intersectObjects(meshList, false);
    if (intersects.length === 0) return;

    const hit = intersects[0];
    const hitMesh = hit.object;
    const entry = this.bodies.find(e => e.meshes.includes(hitMesh));
    if (!entry) return;

    e.stopPropagation();

    const hitPoint = hit.point;
    this.grabPlaneDistance = this.camera.position.distanceTo(hitPoint);

    this.grabConstraint = this.engine.createGrabConstraint(
      entry.body,
      { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z }
    );

    this.engine.wakeBody(entry.body);
    this.grabbedEntry = entry;
    this.grabbing = true;
    this.canvas.style.cursor = 'grabbing';
  }

  _onPointerMove(e) {
    if (!this.grabbing || !this.grabConstraint) return;

    this._updateMouse(e);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const dir = this.raycaster.ray.direction;
    const targetPos = this.camera.position.clone().addScaledVector(dir, this.grabPlaneDistance);

    this.engine.updateGrabTarget(this.grabConstraint, {
      x: targetPos.x, y: targetPos.y, z: targetPos.z,
    });

    this.engine.dampenBody(this.grabbedEntry.body, 0.9);
  }

  _onPointerUp(e) {
    if (this.grabbing && e.button === 0) {
      this._releaseGrab();
    }
  }

  _releaseGrab() {
    if (this.grabConstraint && this.engine) {
      this.engine.removeGrabConstraint(this.grabConstraint);
      this.grabConstraint = null;
    }
    this.grabbedEntry = null;
    this.grabbing = false;
    this.canvas.style.cursor = '';
  }

  _updateMouse(e) {
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  isGrabActive() {
    return this.grabbing;
  }

  dispose() {
    this.stop();
    this.clearBodies();
    if (this.engine) {
      this.engine.dispose();
      this.engine = null;
    }
  }
}
