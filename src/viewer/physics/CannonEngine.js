import * as CANNON from 'cannon-es';
import { PhysicsEngine } from './PhysicsEngine.js';

export class CannonEngine extends PhysicsEngine {
  constructor() {
    super();
    this.name = 'cannon-es';
    this.world = null;
    this.groundBody = null;
    // Reusable for grab
    this._grabJointBody = null;
  }

  async init() {
    this._reportProgress('cannon-es ready', 1);
    this.ready = true;
  }

  createWorld(gravity) {
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(gravity.x, gravity.y, gravity.z),
    });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = 10;
    this.world.defaultContactMaterial.friction = 0.5;
    this.world.defaultContactMaterial.restitution = 0.3;
  }

  createGroundPlane(friction, restitution) {
    const groundBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane(),
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(groundBody);
    this.groundBody = groundBody;
    return groundBody;
  }

  createBoxBody(halfExtents, position, quaternion, mass) {
    const shape = new CANNON.Box(new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z));
    const body = new CANNON.Body({
      mass,
      shape,
      position: new CANNON.Vec3(position.x, position.y, position.z),
      linearDamping: 0.1,
      angularDamping: 0.3,
    });
    if (quaternion) {
      body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    }
    this.world.addBody(body);
    return body;
  }

  step(dt) {
    this.world.step(1 / 60, dt, 3);
  }

  getBodyTransform(body) {
    return {
      position: { x: body.position.x, y: body.position.y, z: body.position.z },
      quaternion: { x: body.quaternion.x, y: body.quaternion.y, z: body.quaternion.z, w: body.quaternion.w },
    };
  }

  setBodyTransform(body, position, quaternion) {
    body.position.set(position.x, position.y, position.z);
    body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }

  zeroVelocity(body) {
    body.velocity.setZero();
    body.angularVelocity.setZero();
    body.force.setZero();
    body.torque.setZero();
  }

  wakeBody(body) {
    body.wakeUp();
  }

  sleepBody(body) {
    body.sleep();
  }

  createGrabConstraint(body, worldHitPoint) {
    // Create a kinematic body at the hit point
    this._grabJointBody = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      position: new CANNON.Vec3(worldHitPoint.x, worldHitPoint.y, worldHitPoint.z),
      collisionFilterGroup: 0,
      collisionFilterMask: 0,
    });
    this.world.addBody(this._grabJointBody);

    const pivotA = new CANNON.Vec3(
      worldHitPoint.x - body.position.x,
      worldHitPoint.y - body.position.y,
      worldHitPoint.z - body.position.z,
    );
    const pivotB = new CANNON.Vec3(0, 0, 0);

    const constraint = new CANNON.PointToPointConstraint(body, pivotA, this._grabJointBody, pivotB, 50);
    this.world.addConstraint(constraint);
    return constraint;
  }

  updateGrabTarget(constraint, worldPoint) {
    if (this._grabJointBody) {
      this._grabJointBody.position.set(worldPoint.x, worldPoint.y, worldPoint.z);
    }
  }

  removeGrabConstraint(constraint) {
    if (constraint) {
      this.world.removeConstraint(constraint);
    }
    if (this._grabJointBody) {
      this.world.removeBody(this._grabJointBody);
      this._grabJointBody = null;
    }
  }

  dampenBody(body, factor) {
    body.velocity.scale(factor, body.velocity);
    body.angularVelocity.scale(factor, body.angularVelocity);
  }

  removeBody(body) {
    this.world.removeBody(body);
  }

  dispose() {
    if (this.world) {
      // Remove all bodies
      while (this.world.bodies.length > 0) {
        this.world.removeBody(this.world.bodies[0]);
      }
      this.world = null;
    }
    this.ready = false;
  }
}
