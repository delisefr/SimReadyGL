import { PhysicsEngine } from './PhysicsEngine.js';

export class PhysXEngine extends PhysicsEngine {
  constructor() {
    super();
    this.name = 'PhysX';
    this.px = null;
    this.foundation = null;
    this.physics = null;
    this.scene = null;
    this.material = null;
    this.dispatcher = null;
    this._grabJointBody = null;
    this._grabJoint = null;
  }

  async init() {
    // Step 1: Pre-download WASM with progress (from public/ static asset)
    console.warn('[PhysX] Step 1: Downloading WASM...');
    this._reportProgress('Downloading PhysX WASM...', 0.05);
    const wasmBinary = await this._fetchWasmWithProgress('/physx-js-webidl.wasm');
    console.warn('[PhysX] WASM downloaded:', wasmBinary.byteLength, 'bytes');

    // Step 2: Import the JS module (pre-optimized by Vite, no page reload)
    console.warn('[PhysX] Step 2: Importing JS module...');
    this._reportProgress('Loading PhysX module...', 0.6);
    const { default: PhysXModule } = await import('physx-js-webidl');
    console.warn('[PhysX] JS module imported');

    // Step 3: Compile WASM + initialize Emscripten with pre-fetched binary
    console.warn('[PhysX] Step 3: Compiling WASM...');
    this._reportProgress('Compiling PhysX WASM...', 0.7);
    this.px = await PhysXModule({ wasmBinary });
    console.warn('[PhysX] WASM compiled, PHYSICS_VERSION:', this.px.PHYSICS_VERSION);

    // Step 4: Create PhysX SDK objects
    this._reportProgress('Initializing PhysX SDK...', 0.9);
    const px = this.px;

    try {
      console.error('[PhysX] Creating foundation...');
      const allocator = new px.PxDefaultAllocator();
      const errorCallback = new px.PxDefaultErrorCallback();
      this.foundation = px.CreateFoundation(px.PHYSICS_VERSION, allocator, errorCallback);
      console.error('[PhysX] Foundation:', !!this.foundation);

      const toleranceScale = new px.PxTolerancesScale();
      toleranceScale.length = 1;
      toleranceScale.speed = 10;
      this.toleranceScale = toleranceScale;

      console.error('[PhysX] Creating physics...');
      this.physics = px.CreatePhysics(px.PHYSICS_VERSION, this.foundation, toleranceScale);
      console.error('[PhysX] Creating dispatcher (0 threads)...');
      this.dispatcher = px.DefaultCpuDispatcherCreate(0);
      this.material = this.physics.createMaterial(0.5, 0.5, 0.3);
      console.error('[PhysX] SDK init COMPLETE');
    } catch (e) {
      console.error('[PhysX] SDK init CRASHED:', e);
      throw e;
    }

    this._reportProgress('PhysX ready', 1);
    this.ready = true;
  }

  async _fetchWasmWithProgress(url) {
    const response = await fetch(url);
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
      this._reportProgress(`Downloading PhysX WASM ${mb}/${totalMb} MB`, 0.05 + pct * 0.5);
    }

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

    // Set up filter shader that enables contact solving
    const filterShader = new px.PassThroughFilterShaderImpl();
    filterShader.filterShader = (attr0, fd0w0, fd0w1, fd0w2, fd0w3, attr1, fd1w0, fd1w1, fd1w2, fd1w3) => {
      // Return eDEFAULT filter flag (allow collision)
      filterShader.outputPairFlags = px.PxPairFlagEnum.eCONTACT_DEFAULT;
      return px.PxFilterFlagEnum.eDEFAULT;
    };
    px.setupPassThroughFilterShader(sceneDesc, filterShader);

    this.scene = this.physics.createScene(sceneDesc);
    this._filterShader = filterShader; // prevent GC
    console.warn('[PhysX] Scene created with contact filter, gravity:', gravity.y);
  }

  createGroundPlane(friction, restitution) {
    const px = this.px;
    const mat = this.physics.createMaterial(friction, friction, restitution);

    // Create a large static box as ground (mesh collider)
    // Box at Y=-0.5 with halfExtent Y=0.5 puts the top surface at Y=0
    const groundPose = new px.PxTransform(
      new px.PxVec3(0, -0.5, 0),
      new px.PxQuat(px.PxIDENTITYEnum.PxIdentity)
    );
    const groundGeom = new px.PxBoxGeometry(100, 0.5, 100);
    const groundActor = px.CreateStatic(
      this.physics, groundPose, groundGeom, mat,
      new px.PxTransform(new px.PxVec3(0, 0, 0), new px.PxQuat(px.PxIDENTITYEnum.PxIdentity))
    );
    this.scene.addActor(groundActor);
    console.warn('[PhysX] Ground box added to scene');
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

    const pose = new px.PxTransform(
      new px.PxVec3(worldHitPoint.x, worldHitPoint.y, worldHitPoint.z),
      new px.PxQuat(px.PxIDENTITYEnum.PxIdentity)
    );

    this._grabJointBody = this.physics.createRigidDynamic(pose);
    this._grabJointBody.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    const tinyGeom = new px.PxBoxGeometry(0.01, 0.01, 0.01);
    const shape = this.physics.createShape(tinyGeom, this.material);
    shape.setFlag(px.PxShapeFlagEnum.eSIMULATION_SHAPE, false);
    this._grabJointBody.attachShape(shape);
    this.scene.addActor(this._grabJointBody);

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

    this._grabJoint = px.D6JointCreate(this.physics, body, localFrame0, this._grabJointBody, localFrame1);

    this._grabJoint.setMotion(px.PxD6AxisEnum.eX, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eY, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eZ, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eTWIST, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eSWING1, px.PxD6MotionEnum.eFREE);
    this._grabJoint.setMotion(px.PxD6AxisEnum.eSWING2, px.PxD6MotionEnum.eFREE);

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
