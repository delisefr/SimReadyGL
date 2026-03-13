import * as THREE from 'three';

const ORBIT = 'orbit';
const FLY = 'fly';

export class CameraController {
  constructor(camera, canvas, sceneManager) {
    this.camera = camera;
    this.canvas = canvas;
    this.sceneManager = sceneManager;
    this.physicsManager = null; // Set externally to check grab state

    // Mode
    this.mode = ORBIT;

    // Orbit state
    this.target = new THREE.Vector3(0, 0, 0);
    this.spherical = new THREE.Spherical();
    this.sphericalDelta = new THREE.Spherical();
    this.panOffset = new THREE.Vector3();
    this.orbitScale = 1;
    this.rotateSpeed = 0.005;
    this.panSpeed = 0.01;
    this.zoomSpeed = 0.1;
    this.dampingFactor = 0.08;
    this.minDistance = 0.01;
    this.maxDistance = 5000;

    // Fly state
    this.flySpeed = 5.0;
    this.flySpeedBoost = 3.0;
    this.mouseSensitivity = 0.002;
    this.flyEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.velocity = new THREE.Vector3();
    this.moveState = { forward: 0, right: 0, up: 0 };
    this.flyDamping = 0.85;

    // Input state
    this.isPointerDown = false;
    this.pointerButton = -1;
    this.lastPointer = new THREE.Vector2();
    this.keys = {};
    this.isPointerLocked = false;

    // Clock
    this.clock = new THREE.Clock();

    this._initOrbitFromCamera();
    this._bindEvents();
  }

  _initOrbitFromCamera() {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.target);
    this.spherical.setFromVector3(offset);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;

    if (mode === FLY) {
      this.flyEuler.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.velocity.set(0, 0, 0);
    } else {
      // Recalculate orbit target from current camera position
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const bounds = this.sceneManager.getModelBounds();
      let dist = 5;
      if (bounds) {
        const size = bounds.getSize(new THREE.Vector3());
        dist = Math.max(size.x, size.y, size.z) * 0.5;
      }
      this.target.copy(this.camera.position).addScaledVector(dir, dist);
      this._initOrbitFromCamera();
    }
  }

  focusOnModel() {
    const bounds = this.sceneManager.getModelBounds();
    if (!bounds || bounds.isEmpty()) {
      this.target.set(0, 0, 0);
      this.camera.position.set(3, 2, 5);
      this._initOrbitFromCamera();
      return;
    }

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    let distance = (maxDim / 2) / Math.tan(fov / 2) * 1.5;
    distance = Math.max(distance, 0.5);

    this.target.copy(center);
    const direction = new THREE.Vector3(0.5, 0.35, 0.7).normalize();
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.lookAt(center);

    // Update near/far for the model scale - use logarithmic depth for large scenes
    this.camera.near = Math.max(0.001, maxDim * 0.00001);
    this.camera.far = Math.max(10000, maxDim * 200);
    this.camera.updateProjectionMatrix();

    this.flySpeed = maxDim * 0.5;

    this._initOrbitFromCamera();

    if (this.mode === FLY) {
      this.flyEuler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    }
  }

  update(dt) {
    if (dt === undefined) dt = this.clock.getDelta();

    if (this.mode === ORBIT) {
      this._updateOrbit(dt);
    } else {
      this._updateFly(dt);
    }
  }

  _updateOrbit() {
    const offset = new THREE.Vector3();

    // Apply damped rotation
    this.spherical.theta += this.sphericalDelta.theta * this.dampingFactor;
    this.spherical.phi += this.sphericalDelta.phi * this.dampingFactor;

    // Apply damped zoom
    this.spherical.radius *= this.orbitScale;
    this.spherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this.spherical.radius));
    this.orbitScale = 1 + (this.orbitScale - 1) * (1 - this.dampingFactor);

    // Clamp phi
    this.spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, this.spherical.phi));

    // Apply damped pan
    this.target.addScaledVector(this.panOffset, this.dampingFactor);

    offset.setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    // Decay deltas
    this.sphericalDelta.theta *= (1 - this.dampingFactor);
    this.sphericalDelta.phi *= (1 - this.dampingFactor);
    this.panOffset.multiplyScalar(1 - this.dampingFactor);
  }

  _updateFly(dt) {
    const speed = this.flySpeed * (this.keys['ShiftLeft'] || this.keys['ShiftRight'] ? this.flySpeedBoost : 1);

    // Calculate move direction
    const moveDir = new THREE.Vector3();

    if (this.keys['KeyW'] || this.keys['ArrowUp']) moveDir.z -= 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) moveDir.z += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) moveDir.x -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) moveDir.x += 1;
    if (this.keys['Space']) moveDir.y += 1;
    if (this.keys['ControlLeft'] || this.keys['ControlRight']) moveDir.y -= 1;

    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();
    }

    // Apply velocity
    const targetVelocity = moveDir.multiplyScalar(speed);
    this.velocity.lerp(targetVelocity, 1 - Math.pow(this.flyDamping, dt * 60));

    // Move camera
    const movement = new THREE.Vector3();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0);

    movement.addScaledVector(forward, -this.velocity.z * dt);
    movement.addScaledVector(right, this.velocity.x * dt);
    movement.addScaledVector(up, this.velocity.y * dt);

    this.camera.position.add(movement);

    // Apply rotation from euler
    this.camera.quaternion.setFromEuler(this.flyEuler);
  }

  _bindEvents() {
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('keyup', (e) => this._onKeyUp(e));

    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.canvas;
    });
  }

  _onPointerDown(e) {
    // Don't start camera control if physics grab is active
    if (this.physicsManager && this.physicsManager.running && e.shiftKey && e.button === 0) {
      return;
    }
    this.isPointerDown = true;
    this.pointerButton = e.button;
    this.lastPointer.set(e.clientX, e.clientY);

    if (this.mode === FLY && e.button === 0) {
      this.canvas.requestPointerLock();
    }
  }

  _onPointerMove(e) {
    // Don't move camera if physics grab is active
    if (this.physicsManager && this.physicsManager.isGrabActive()) return;

    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;

    if (this.mode === FLY && this.isPointerLocked) {
      this.flyEuler.y -= e.movementX * this.mouseSensitivity;
      this.flyEuler.x -= e.movementY * this.mouseSensitivity;
      this.flyEuler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.flyEuler.x));
      return;
    }

    if (!this.isPointerDown) return;

    if (this.mode === ORBIT) {
      if (this.pointerButton === 0) {
        // Orbit
        this.sphericalDelta.theta -= dx * this.rotateSpeed;
        this.sphericalDelta.phi -= dy * this.rotateSpeed;
      } else if (this.pointerButton === 2 || this.pointerButton === 1) {
        // Pan
        const panDist = this.spherical.radius * this.panSpeed;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        this.panOffset.addScaledVector(right, -dx * panDist * 0.01);
        this.panOffset.addScaledVector(up, dy * panDist * 0.01);
      }
    } else if (this.mode === FLY) {
      if (this.pointerButton === 0) {
        this.flyEuler.y -= dx * this.mouseSensitivity;
        this.flyEuler.x -= dy * this.mouseSensitivity;
        this.flyEuler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.flyEuler.x));
      }
    }

    this.lastPointer.set(e.clientX, e.clientY);
  }

  _onPointerUp() {
    this.isPointerDown = false;
    this.pointerButton = -1;
  }

  _onWheel(e) {
    e.preventDefault();
    if (this.mode === ORBIT) {
      if (e.deltaY > 0) {
        this.orbitScale *= (1 + this.zoomSpeed);
      } else {
        this.orbitScale /= (1 + this.zoomSpeed);
      }
    } else {
      // Adjust fly speed with scroll
      this.flySpeed *= (e.deltaY > 0 ? 0.9 : 1.1);
      this.flySpeed = Math.max(0.01, Math.min(500, this.flySpeed));
    }
  }

  _onKeyDown(e) {
    // Don't capture input when typing in search
    if (e.target.tagName === 'INPUT') return;

    this.keys[e.code] = true;

    // Mode shortcuts
    if (e.code === 'KeyO') this.setMode(ORBIT);
    if (e.code === 'KeyP') this.setMode(FLY);
    if (e.code === 'KeyF') this.focusOnModel();

    // Start moving in WASD? Switch to fly mode automatically
    if (this.mode === ORBIT && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
      this.setMode(FLY);
      document.getElementById('btn-fly').classList.add('active');
      document.getElementById('btn-orbit').classList.remove('active');
    }
  }

  _onKeyUp(e) {
    this.keys[e.code] = false;
  }
}
