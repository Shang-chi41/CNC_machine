import * as THREE from "three";

// cnc_kinematics_multi_group.js
// Runtime kinematics for VIRTUAL_MILLING_CNC.glb.
// Supports virtual links and multiple objects per link.
//
// Pose input expects controller MPos in millimeters.
// The GLB appears to be meter-scale, so default mpos_to_model_scale is 0.001.

export class CNCKinematicsMultiGroup {
  constructor(scene) {
    this.scene = scene;
    this.root = null;
    this.map = null;
    this.objectByName = new Map();
    this.linkGroups = new Map();
    this.currentMPos = { x: 0, y: 0, z: 0 };
    this.targetMPos = { x: 0, y: 0, z: 0 };
    this.initialized = false;
  }

  bindModel(root) {
    this.root = root;
    this.objectByName.clear();

    root.traverse((obj) => {
      if (obj.name) this.objectByName.set(obj.name, obj);
    });

    this.initialized = true;
  }

  loadMap(map) {
    this.map = map;
    this._buildVirtualLinks();
  }

  _buildVirtualLinks() {
    if (!this.root || !this.map?.links) return;

    // Create empty groups for each kinematic link.
    for (const linkName of Object.keys(this.map.links)) {
      if (!this.linkGroups.has(linkName)) {
        const group = new THREE.Group();
        group.name = `KIN_${linkName}`;
        this.linkGroups.set(linkName, group);
      }
    }

    // Attach groups according to parent relation.
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
    for (const [linkName, linkCfg] of Object.entries(this.map.links)) {
      const group = this.linkGroups.get(linkName);
      for (const objectName of linkCfg.objects || []) {
        const obj = this.objectByName.get(objectName);
        if (!obj) {
          console.warn(`[CNCKinematics] Missing GLB object: ${objectName}`);
          continue;
        }
        group.attach(obj); // keep world transform while reparenting
      }
    }
  }

  setTargetMPos(mpos) {
    this.targetMPos = {
      x: Number(mpos.x ?? mpos[0] ?? 0),
      y: Number(mpos.y ?? mpos[1] ?? 0),
      z: Number(mpos.z ?? mpos[2] ?? 0),
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

      const axisKey = linkCfg.axis.toLowerCase();
      const modelAxis = linkCfg.model_axis || axisKey;
      const sign = Number(linkCfg.sign ?? 1);
      const offset = Number(linkCfg.offset ?? 0);
      const mpos = Number(this.currentMPos[axisKey] ?? 0);

      group.position.x = 0;
      group.position.y = 0;
      group.position.z = 0;
      group.position[modelAxis] = offset + sign * mpos * unitScale;
    }
  }

  debugListFoundObjects() {
    return Array.from(this.objectByName.keys()).sort();
  }
}
