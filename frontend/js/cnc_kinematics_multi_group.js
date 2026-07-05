import * as THREE from "three";

// cnc_kinematics_multi_group.js
// Runtime kinematics for VIRTUAL_MILLING_CNC.glb.
// Supports virtual kinematic links, nested dependencies and multiple GLB objects per link.
//
// Pose input expects controller MPos in millimeters.
// The exported GLB is meter-scale, so default mpos_to_model_scale is 0.001.

export class CNCKinematicsMultiGroup {
  constructor(scene) {
    this.scene = scene;
    this.root = null;
    this.map = null;
    this.objectByName = new Map();
    this.objectByNormalizedName = new Map();
    this.linkGroups = new Map();
    this.assignedObjects = new Set();
    this.currentMPos = { x: 0, y: 0, z: 0 };
    this.targetMPos = { x: 0, y: 0, z: 0 };
    this.initialized = false;
  }

  bindModel(root) {
    this.root = root;
    this.objectByName.clear();
    this.objectByNormalizedName.clear();

    root.traverse((obj) => {
      if (!obj.name) return;
      this.objectByName.set(obj.name, obj);
      this.objectByNormalizedName.set(this._normalizeName(obj.name), obj);
    });

    this.initialized = true;
  }

  loadMap(map) {
    this.map = map;
    this._buildVirtualLinks();
  }

  _normalizeName(name) {
    return String(name || "")
      .normalize("NFC")
      .trim()
      .toLowerCase();
  }

  _findObject(objectName) {
    if (this.objectByName.has(objectName)) return this.objectByName.get(objectName);
    const normalized = this._normalizeName(objectName);
    return this.objectByNormalizedName.get(normalized) || null;
  }

  _buildVirtualLinks() {
    if (!this.root || !this.map?.links) return;

    this.linkGroups.clear();
    this.assignedObjects.clear();

    // Create empty groups for each virtual kinematic link.
    for (const linkName of Object.keys(this.map.links)) {
      const group = new THREE.Group();
      group.name = `KIN_${linkName}`;
      this.linkGroups.set(linkName, group);
    }

    // Attach virtual groups according to the parent relation.
    // This creates the required cumulative motion, e.g. Z link inherits X motion.
    for (const [linkName, linkCfg] of Object.entries(this.map.links)) {
      const group = this.linkGroups.get(linkName);
      const parentName = linkCfg.parent;
      if (parentName && this.linkGroups.has(parentName)) {
        this.linkGroups.get(parentName).add(group);
      } else {
        this.root.add(group);
      }
    }

    // Reparent exported GLB nodes into virtual kinematic groups.
    // group.attach(obj) preserves current world transform, so the model does not jump at load time.
    for (const [linkName, linkCfg] of Object.entries(this.map.links)) {
      const group = this.linkGroups.get(linkName);
      for (const objectName of linkCfg.objects || []) {
        const obj = this._findObject(objectName);
        if (!obj) {
          console.warn(`[CNCKinematics] Missing GLB object: ${objectName}`);
          continue;
        }
        if (this.assignedObjects.has(obj.uuid)) {
          console.warn(`[CNCKinematics] Object assigned more than once; skipping duplicate: ${objectName}`);
          continue;
        }
        group.attach(obj);
        this.assignedObjects.add(obj.uuid);
      }
    }

    console.info("[CNCKinematics] Virtual links loaded:", this.debugLinkAssignments());
  }

  setTargetMPos(mpos) {
    this.targetMPos = {
      x: Number(mpos.x ?? mpos.X ?? mpos[0] ?? 0),
      y: Number(mpos.y ?? mpos.Y ?? mpos[1] ?? 0),
      z: Number(mpos.z ?? mpos.Z ?? mpos[2] ?? 0),
    };
  }

  update(dtSeconds) {
    if (!this.map) return;

    const alpha = 1 - Math.exp(-dtSeconds * 25.0);
    this.currentMPos.x += (this.targetMPos.x - this.currentMPos.x) * alpha;
    this.currentMPos.y += (this.targetMPos.y - this.currentMPos.y) * alpha;
    this.currentMPos.z += (this.targetMPos.z - this.currentMPos.z) * alpha;

    this._applyLinks();
  }

  _applyLinks() {
    const unitScale = Number(this.map.mpos_to_model_scale ?? 0.001);

    for (const [linkName, linkCfg] of Object.entries(this.map.links || {})) {
      if (!linkCfg.axis) continue;

      const group = this.linkGroups.get(linkName);
      if (!group) continue;

      const axisKey = String(linkCfg.axis).toLowerCase();
      const modelAxis = linkCfg.model_axis || axisKey;
      const sign = Number(linkCfg.sign ?? 1);
      const offset = Number(linkCfg.offset ?? 0);
      const mpos = Number(this.currentMPos[axisKey] ?? 0);

      group.position.set(0, 0, 0);
      group.position[modelAxis] = offset + sign * mpos * unitScale;
    }
  }

  debugListFoundObjects() {
    return Array.from(this.objectByName.keys()).sort();
  }

  debugLinkAssignments() {
    const result = {};
    for (const [linkName, linkCfg] of Object.entries(this.map?.links || {})) {
      result[linkName] = {
        parent: linkCfg.parent || null,
        axis: linkCfg.axis || null,
        objects: (linkCfg.objects || []).map((name) => ({
          name,
          found: Boolean(this._findObject(name)),
        })),
      };
    }
    return result;
  }
}
