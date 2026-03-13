import { PhysicsEngine } from './PhysicsEngine.js';

/**
 * Newton Dynamics 4 physics engine.
 *
 * Newton Dynamics does not have an official npm/WASM package yet.
 * This engine implements the full interface and will work once a WASM
 * build of Newton Dynamics 4 is provided at the configured URL.
 *
 * To use: place newton.wasm + newton.js in public/ and set NEWTON_WASM_URL.
 * The expected module interface mirrors the Newton Dynamics 4 C API via Emscripten.
 */

const NEWTON_WASM_URL = '/newton/newton.js';

export class NewtonEngine extends PhysicsEngine {
  constructor() {
    super();
    this.name = 'Newton';
    this.nd = null;        // Newton module
    this.world = null;
    this.bodies = [];
    this._grabBody = null;
    this._grabJoint = null;
    this._available = false;
  }

  async init() {
    try {
      this._reportProgress('Loading Newton WASM...', 0);
      // Attempt to load the Newton WASM module
      const module = await import(/* @vite-ignore */ NEWTON_WASM_URL);
      if (module.default) {
        this.nd = typeof module.default === 'function' ? await module.default() : module.default;
      } else {
        this.nd = module;
      }
      this._available = true;
      this.ready = true;
    } catch {
      this._available = false;
      this.ready = false;
      throw new Error(
        'Newton Dynamics WASM not found. Place newton.js + newton.wasm in public/newton/. ' +
        'Build from https://github.com/MADEAPPS/newton-dynamics with Emscripten.'
      );
    }
  }

  createWorld(gravity) {
    this._checkAvailable();
    const nd = this.nd;
    this.world = nd.NewtonCreate();
    nd.NewtonSetSolverModel(this.world, 4);
    // Newton uses a callback-based material system; set default gravity
    this._gravity = gravity;
  }

  createGroundPlane(friction, restitution) {
    this._checkAvailable();
    const nd = this.nd;
    // Newton uses collision shapes + bodies
    // Create an infinite plane collision (tree collision with a single large quad)
    const collision = nd.NewtonCreatePlane(this.world, 0, 1, 0, 0);
    const identity = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const body = nd.NewtonCreateDynamicBody(this.world, collision, identity);
    nd.NewtonBodySetMassProperties(body, 0, collision); // mass=0 => static
    nd.NewtonDestroyCollision(collision);
    return body;
  }

  createBoxBody(halfExtents, position, quaternion, mass) {
    this._checkAvailable();
    const nd = this.nd;
    const sx = halfExtents.x * 2;
    const sy = halfExtents.y * 2;
    const sz = halfExtents.z * 2;
    const collision = nd.NewtonCreateBox(this.world, sx, sy, sz, 0, null);
    const matrix = this._transformToMatrix(position, quaternion);
    const body = nd.NewtonCreateDynamicBody(this.world, collision, matrix);
    nd.NewtonBodySetMassProperties(body, mass, collision);

    // Set gravity callback
    const grav = this._gravity;
    nd.NewtonBodySetForceAndTorqueCallback(body, (b, timestep) => {
      const m = nd.NewtonBodyGetMass(b);
      nd.NewtonBodySetForce(b, [m * grav.x, m * grav.y, m * grav.z]);
    });

    nd.NewtonBodySetLinearDamping(body, 0.1);
    nd.NewtonDestroyCollision(collision);
    this.bodies.push(body);
    return body;
  }

  step(dt) {
    this._checkAvailable();
    this.nd.NewtonUpdate(this.world, dt);
  }

  getBodyTransform(body) {
    this._checkAvailable();
    const matrix = new Float32Array(16);
    this.nd.NewtonBodyGetMatrix(body, matrix);
    return this._matrixToTransform(matrix);
  }

  setBodyTransform(body, position, quaternion) {
    this._checkAvailable();
    const matrix = this._transformToMatrix(position, quaternion);
    this.nd.NewtonBodySetMatrix(body, matrix);
  }

  zeroVelocity(body) {
    this._checkAvailable();
    this.nd.NewtonBodySetVelocity(body, [0, 0, 0]);
    this.nd.NewtonBodySetOmega(body, [0, 0, 0]);
  }

  wakeBody(body) {
    this._checkAvailable();
    this.nd.NewtonBodySetSleepState(body, 0); // 0 = awake
  }

  sleepBody(body) {
    this._checkAvailable();
    this.nd.NewtonBodySetSleepState(body, 1); // 1 = sleeping
  }

  createGrabConstraint(body, worldHitPoint) {
    this._checkAvailable();
    const nd = this.nd;
    // Newton uses "pick" joint (kinematic constraint)
    const pivot = [worldHitPoint.x, worldHitPoint.y, worldHitPoint.z];
    this._grabJoint = nd.NewtonCreateBallAndSocket(this.world, pivot, body, null);
    this._grabBody = body;
    return this._grabJoint;
  }

  updateGrabTarget(constraint, worldPoint) {
    this._checkAvailable();
    // Move the constraint pivot
    if (this._grabJoint) {
      this.nd.NewtonBallAndSocketSetConeLimits(
        this._grabJoint,
        [worldPoint.x, worldPoint.y, worldPoint.z],
        Math.PI, Math.PI
      );
    }
  }

  removeGrabConstraint(constraint) {
    if (this._grabJoint && this.nd) {
      this.nd.NewtonDestroyJoint(this.world, this._grabJoint);
      this._grabJoint = null;
    }
    this._grabBody = null;
  }

  dampenBody(body, factor) {
    this._checkAvailable();
    const nd = this.nd;
    const vel = new Float32Array(3);
    const omega = new Float32Array(3);
    nd.NewtonBodyGetVelocity(body, vel);
    nd.NewtonBodyGetOmega(body, omega);
    nd.NewtonBodySetVelocity(body, [vel[0] * factor, vel[1] * factor, vel[2] * factor]);
    nd.NewtonBodySetOmega(body, [omega[0] * factor, omega[1] * factor, omega[2] * factor]);
  }

  removeBody(body) {
    this._checkAvailable();
    this.nd.NewtonDestroyBody(body);
    const idx = this.bodies.indexOf(body);
    if (idx >= 0) this.bodies.splice(idx, 1);
  }

  dispose() {
    if (this.world && this.nd) {
      this.nd.NewtonDestroy(this.world);
      this.world = null;
    }
    this.bodies = [];
    this.ready = false;
  }

  // --- Helpers ---

  _checkAvailable() {
    if (!this._available) {
      throw new Error('Newton Dynamics WASM module not loaded');
    }
  }

  _transformToMatrix(position, quaternion) {
    // Convert position + quaternion to 4x4 column-major matrix
    const x = quaternion ? quaternion.x : 0;
    const y = quaternion ? quaternion.y : 0;
    const z = quaternion ? quaternion.z : 0;
    const w = quaternion ? quaternion.w : 1;

    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    return new Float32Array([
      1 - (yy + zz), xy + wz, xz - wy, 0,
      xy - wz, 1 - (xx + zz), yz + wx, 0,
      xz + wy, yz - wx, 1 - (xx + yy), 0,
      position.x, position.y, position.z, 1,
    ]);
  }

  _matrixToTransform(m) {
    // Extract position from column 3
    const position = { x: m[12], y: m[13], z: m[14] };

    // Extract quaternion from rotation part of 4x4 matrix
    const trace = m[0] + m[5] + m[10];
    let qx, qy, qz, qw;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      qw = 0.25 / s;
      qx = (m[6] - m[9]) * s;
      qy = (m[8] - m[2]) * s;
      qz = (m[1] - m[4]) * s;
    } else if (m[0] > m[5] && m[0] > m[10]) {
      const s = 2.0 * Math.sqrt(1.0 + m[0] - m[5] - m[10]);
      qw = (m[6] - m[9]) / s;
      qx = 0.25 * s;
      qy = (m[4] + m[1]) / s;
      qz = (m[8] + m[2]) / s;
    } else if (m[5] > m[10]) {
      const s = 2.0 * Math.sqrt(1.0 + m[5] - m[0] - m[10]);
      qw = (m[8] - m[2]) / s;
      qx = (m[4] + m[1]) / s;
      qy = 0.25 * s;
      qz = (m[9] + m[6]) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m[10] - m[0] - m[5]);
      qw = (m[1] - m[4]) / s;
      qx = (m[8] + m[2]) / s;
      qy = (m[9] + m[6]) / s;
      qz = 0.25 * s;
    }

    return { position, quaternion: { x: qx, y: qy, z: qz, w: qw } };
  }
}
