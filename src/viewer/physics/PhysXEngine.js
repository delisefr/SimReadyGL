import { PhysicsEngine } from './PhysicsEngine.js';

export class PhysXEngine extends PhysicsEngine {
  constructor() {
    super();
    this.name = 'PhysX';
    this.px = null;         // PhysX module
    this.foundation = null;
    this.physics = null;
    this.scene = null;
    this.material = null;
    this.dispatcher = null;
    this._grabJointBody = null;
    this._grabJoint = null;
  }

  async init() {
    this._reportProgress('Importing PhysX JS...', 0);

    // Dynamic import the module factory + resolve WASM URL via Vite
    const [{ default: PhysXModule }, wasmAsset] = await Promise.all([
      import('physx-js-webidl'),
      import('physx-js-webidl/physx-js-webidl.wasm?url'),
    ]);
    const wasmUrl = wasmAsset.default;

    // Fetch WASM with byte-level progress tracking
    this._reportProgress('Downloading PhysX WASM...', 0.05);
    const wasmBinary = await this._fetchWasmWithProgress(wasmUrl);

    // Compile + instantiate via Emscripten with pre-fetched binary
    this._reportProgress('Compiling PhysX WASM...', 0.7);
    this.px = await PhysXModule({ wasmBinary });

    this._reportProgress('Initializing PhysX SDK...', 0.9);

    const px = this.px;

    // Foundation
    const allocator = new px.PxDefaultAllocator();
    const errorCallback = new px.PxDefaultErrorCallback();
    this.foundation = px.CreateFoundation(px.PHYSICS_VERSION, allocator, errorCallback);

    // Tolerance scale (1 unit = 1 meter)
    const toleranceScale = new px.PxTolerancesScale();
    toleranceScale.length = 1;
    toleranceScale.speed = 10;
    this.toleranceScale = toleranceScale;

    // Physics SDK
    this.physics = px.CreatePhysics(px.PHYSICS_VERSION, this.foundation, toleranceScale);

    // CPU dispatcher
    this.dispatcher = px.DefaultCpuDispatcherCreate(2);

    // Default material
    this.material = this.physics.createMaterial(0.5, 0.5, 0.3);

    this._reportProgress('PhysX ready', 1);
    this.ready = true;
  }

  async _fetchWasmWithProgress(wasmUrl) {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`PhysX WASM fetch failed: ${response.status}`);

    const contentLength = response.headers.get('Content-Length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 5_344_000;

    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedBytes += value.length;

      const pct = Math.min(receivedBytes / totalBytes, 1);
      const mb = (receivedBytes / 1_048_576).toFixed(1);
      const totalMb = (totalBytes / 1_048_576).toFixed(1);
      this._reportProgress(`Downloading PhysX WASM... ${mb}/${totalMb} MB`, 0.05 + pct * 0.6);
    }

    // Combine chunks into a single ArrayBuffer
    const wasmBytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      wasmBytes.set(chunk, offset);
      offset += chunk.length;
    }

    return wasmBytes.buffer;
  }

  createWorld(gravity) {
    const px = this.px;

    const sceneDesc = new px.PxSceneDesc(this.toleranceScale);
    sceneDesc.gravity = new px.PxVec3(gravity.x, gravity.y, gravity.z);
    sceneDesc.cpuDispatcher = this.dispatcher;
    sceneDesc.filterShader = px.DefaultFilterShader();

    this.scene = this.physics.createScene(sceneDesc);
  }

  createGroundPlane(friction, restitution) {
    const px = this.px;
    const mat = this.physics.createMaterial(friction, friction, restitution);
    const plane = new px.PxPlane(new px.PxVec3(0, 1, 0), 0);
    const groundActor = px.CreatePlane(this.physics, plane, mat);
    this.scene.addActor(groundActor);
    return groundActor;
  }

  createBoxBody(halfExtents, position, quaternion, mass) {
    const px = this.px;

    const q = quaternion
      ? new px.PxQuat(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
      : new px.PxQuat(px.PxIDENTITYEnum.PxIdentity);

    const pose = new px.PxTransform(
      new px.PxVec3(position.x, position.y, position.z),
      q
    );

    const geom = new px.PxBoxGeometry(halfExtents.x, halfExtents.y, halfExtents.z);

    // Density from mass and volume
    const volume = halfExtents.x * halfExtents.y * halfExtents.z * 8;
    const density = volume > 0 ? mass / volume : 1;

    const body = px.CreateDynamic(this.physics, pose, geom, this.material, density);
    body.setLinearDamping(0.1);
    body.setAngularDamping(0.3);

    this.scene.addActor(body);
    return body;
  }

  step(dt) {
    this.scene.simulate(dt);
    this.scene.fetchResults(true);
  }

  getBodyTransform(body) {
    const pose = body.getGlobalPose();
    return {
      position: { x: pose.p.x, y: pose.p.y, z: pose.p.z },
      quaternion: { x: pose.q.x, y: pose.q.y, z: pose.q.z, w: pose.q.w },
    };
  }

  setBodyTransform(body, position, quaternion) {
    const px = this.px;
    const pose = new px.PxTransform(
      new px.PxVec3(position.x, position.y, position.z),
      new px.PxQuat(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
    );
    body.setGlobalPose(pose);
  }

  zeroVelocity(body) {
    const px = this.px;
    body.setLinearVelocity(new px.PxVec3(0, 0, 0));
    body.setAngularVelocity(new px.PxVec3(0, 0, 0));
    body.clearForce(px.PxForceModeEnum.eFORCE);
    body.clearTorque(px.PxForceModeEnum.eFORCE);
  }

  wakeBody(body) {
    body.wakeUp();
  }

  sleepBody(body) {
    body.putToSleep();
  }

  createGrabConstraint(body, worldHitPoint) {
    const px = this.px;

    // Create a kinematic actor at the hit point
    const pose = new px.PxTransform(
      new px.PxVec3(worldHitPoint.x, worldHitPoint.y, worldHitPoint.z),
      new px.PxQuat(px.PxIDENTITYEnum.PxIdentity)
    );

    this._grabJointBody = this.physics.createRigidDynamic(pose);
    this._grabJointBody.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    // Tiny box shape so PhysX doesn't complain, but disable collision
    const tinyGeom = new px.PxBoxGeometry(0.01, 0.01, 0.01);
    const shape = this.physics.createShape(tinyGeom, this.material);
    shape.setFlag(px.PxShapeFlagEnum.eSIMULATION_SHAPE, false);
    this._grabJointBody.attachShape(shape);
    this.scene.addActor(this._grabJointBody);

    // Compute local pivot on the dynamic body
    const bodyPose = body.getGlobalPose();
    const localFrame0 = new px.PxTransform(
      new px.PxVec3(
        worldHitPoint.x - bodyPose.p.x,
        worldHitPoint.y - bodyPose.p.y,
        worldHitPoint.z - bodyPose.p.z
      ),
      new px.PxQuat(px.PxIDENTITYEnum.PxIdentity)
    );
    const localFrame1 = new px.PxTransform(
      new px.PxVec3(0, 0, 0),
      new px.PxQuat(px.PxIDENTITYEnum.PxIdentity)
    );

    // D6 joint with spring drive
    this._grabJoint = px.D6JointCreate(this.physics, body, localFrame0, this._grabJointBody, localFrame1);

    // Free all axes so the spring pulls the body
    this._grabJoint.setMotion(px.PxD6AxisEnum.eX, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eY, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eZ, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eTWIST, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eSWING1, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eSWING2, px.PxD6MotionEnum.eFREE);

    // Strong linear spring drive
    const drive = new px.PxD6JointDrive(5000, 500, Infinity, true);
    this._grabJoint.setDrive(px.PxD6DriveEnum.eX, drive);
    this._grabJoint.setDrive(px.PxD6DriveEnum.eY, drive);
    this._grabJoint.setDrive(px.PxD6DriveEnum.eZ, drive);

    return this._grabJoint;
  }

  updateGrabTarget(constraint, worldPoint) {
    if (this._grabJointBody) {
      const px = this.px;
      const pose = new px.PxTransform(
        new px.PxVec3(worldPoint.x, worldPoint.y, worldPoint.z),
        new px.PxQuat(px.PxIDENTITYEnum.PxIdentity)
      );
      this._grabJointBody.setKinematicTarget(pose);
    }
  }

  removeGrabConstraint(constraint) {
    if (this._grabJoint) {
      this._grabJoint.release();
      this._grabJoint = null;
    }
    if (this._grabJointBody) {
      this.scene.removeActor(this._grabJointBody);
      this._grabJointBody = null;
    }
  }

  dampenBody(body, factor) {
    const px = this.px;
    const lv = body.getLinearVelocity();
    body.setLinearVelocity(new px.PxVec3(lv.x * factor, lv.y * factor, lv.z * factor));
    const av = body.getAngularVelocity();
    body.setAngularVelocity(new px.PxVec3(av.x * factor, av.y * factor, av.z * factor));
  }

  removeBody(body) {
    this.scene.removeActor(body);
  }

  dispose() {
    if (this._grabJoint) {
      this._grabJoint.release();
      this._grabJoint = null;
    }
    if (this._grabJointBody) {
      this.scene.removeActor(this._grabJointBody);
      this._grabJointBody = null;
    }
    if (this.scene) {
      this.scene.release();
      this.scene = null;
    }
    if (this.physics) {
      this.physics.release();
      this.physics = null;
    }
    if (this.foundation) {
      this.foundation.release();
      this.foundation = null;
    }
    this.ready = false;
  }
}
