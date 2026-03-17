/**
 * Base physics engine interface.
 * All engines must implement these methods.
 */
export class PhysicsEngine {
  constructor() {
    this.name = 'base';
    this.ready = false;
    /** @type {function(string, number)|null} Called with (status, progress 0-1) */
    this.onProgress = null;
  }

  _reportProgress(status, progress) {
    if (this.onProgress) this.onProgress(status, progress);
  }

  /** Async initialization (WASM loading, etc). Resolves when ready. */
  async init() { throw new Error('Not implemented'); }

  /** Create physics world with gravity vector {x, y, z}. */
  createWorld(gravity) { throw new Error('Not implemented'); }

  /** Create a static ground plane at Y=0. Returns engine-specific body. */
  createGroundPlane(friction, restitution) { throw new Error('Not implemented'); }

  /**
   * Create a dynamic box body.
   * @param {Object} halfExtents - {x, y, z}
   * @param {Object} position - {x, y, z}
   * @param {Object} quaternion - {x, y, z, w}
   * @param {number} mass
   * @returns engine-specific body handle
   */
  createBoxBody(halfExtents, position, quaternion, mass) { throw new Error('Not implemented'); }

  /**
   * Create a dynamic body with convex hull collider. Falls back to box if not supported.
   * @param {Float32Array} vertices - Flat array of vertex positions [x,y,z,...]
   * @param {Object} position - {x, y, z}
   * @param {Object} quaternion - {x, y, z, w}
   * @param {number} density - kg/m^3
   * @returns engine-specific body handle
   */
  createConvexBody(vertices, position, quaternion, density) {
    // Default: fall back to box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertices.length; i += 3) {
      minX = Math.min(minX, vertices[i]); maxX = Math.max(maxX, vertices[i]);
      minY = Math.min(minY, vertices[i+1]); maxY = Math.max(maxY, vertices[i+1]);
      minZ = Math.min(minZ, vertices[i+2]); maxZ = Math.max(maxZ, vertices[i+2]);
    }
    const hx = (maxX - minX) / 2, hy = (maxY - minY) / 2, hz = (maxZ - minZ) / 2;
    const vol = hx * hy * hz * 8;
    const mass = density * Math.max(vol, 0.001);
    return this.createBoxBody(
      { x: Math.max(hx, 0.01), y: Math.max(hy, 0.01), z: Math.max(hz, 0.01) },
      position, quaternion, mass
    );
  }

  /** Step the simulation by dt seconds. */
  step(dt) { throw new Error('Not implemented'); }

  /**
   * Get body transform.
   * @returns {{ position: {x,y,z}, quaternion: {x,y,z,w} }}
   */
  getBodyTransform(body) { throw new Error('Not implemented'); }

  /** Set body position and rotation directly. */
  setBodyTransform(body, position, quaternion) { throw new Error('Not implemented'); }

  /** Set body linear and angular velocity to zero. */
  zeroVelocity(body) { throw new Error('Not implemented'); }

  /** Wake a sleeping body. */
  wakeBody(body) { throw new Error('Not implemented'); }

  /** Put body to sleep. */
  sleepBody(body) { throw new Error('Not implemented'); }

  /**
   * Create a grab constraint between a body and a world-space point.
   * @returns constraint handle
   */
  createGrabConstraint(body, worldHitPoint) { throw new Error('Not implemented'); }

  /** Move the grab target to a new world-space point. */
  updateGrabTarget(constraint, worldPoint) { throw new Error('Not implemented'); }

  /** Remove a grab constraint. */
  removeGrabConstraint(constraint) { throw new Error('Not implemented'); }

  /** Dampen a body's velocity (for grab stability). */
  dampenBody(body, factor) { throw new Error('Not implemented'); }

  /** Remove a dynamic body from the world. */
  removeBody(body) { throw new Error('Not implemented'); }

  /** Clean up all resources. */
  dispose() { throw new Error('Not implemented'); }
}
