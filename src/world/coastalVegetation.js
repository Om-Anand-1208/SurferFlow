/**
 * Deterministic, player-centred coastal plants.
 *
 * Four shared meshes (sea oats, scrub, pines and spreading coastal oaks) are drawn
 * with thin instances. Placement is hashed from absolute world-grid cells, so
 * crossing the bounded render window never changes a plant's identity. The
 * window is deliberately much smaller than the terrain clipmap, leaves the
 * shoreline and surf lane bare, and fades its outer ring into the sky haze.
 */

import vegetationAssets from "../assets/vegetation.json";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Matrix, Quaternion, Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";

import { S } from "../core/settings.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { OUTER_EXTENT } from "../terrain/clipmapMesh.js";
import { bindMatrixArray, whenReady } from "../core/gpuUtil.js";

const TILE_SIZE = 48;
const RADIUS = Math.min(560, OUTER_EXTENT * 0.66);
const REBUILD_MARGIN = TILE_SIZE * 1.5;
const SETTINGS_SETTLE_SECONDS = 0.18;
const _focus = new Vector2();
const _wind = new Vector2();
const _splits = new Vector4();
const _scale = new Vector3(1, 1, 1);
const _rotation = new Quaternion();
const _translation = new Vector3();
const _matrix = new Matrix();

const PI2 = Math.PI * 2;

export class CoastalVegetation {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../render/depthPass.js").DepthPass} depthPass
     */
    constructor(scene, terrain, sky, shadows, depthPass) {
        this.scene = scene;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.time = 0;
        this.radius = RADIUS;
        this._lastCellX = NaN;
        this._lastCellZ = NaN;
        this._lastDensity = NaN;
        this._lastCoastline = NaN;
        this._requestedDensity = NaN;
        this._requestedCoastline = NaN;
        this._settingsSettle = 0;

        this.items = [
            this._createItem("duneGrass", assetGeometry("grass"), 1, Math.min(220, RADIUS)),
            this._createItem("coastalScrub", assetGeometry("scrub"), 2, Math.min(370, RADIUS)),
            this._createItem("coastalPines", assetGeometry("pine"), 2, RADIUS),
            this._createItem("coastalOaks", assetGeometry("oak"), 2, RADIUS),
        ];

        for (const item of this.items) {
            shadows.registerCaster(
                item.mesh,
                (cascade) => this._makeDepthMaterial(item, cascade),
                item.cascades
            );
            item.prepassMaterial = this._makePrepassMaterial(item);
            depthPass.registerCaster(item.mesh, item.prepassMaterial);
        }
    }

    _createItem(name, data, cascades, radius) {
        const mesh = new Mesh(name, this.scene);
        data.applyToMesh(mesh, false);
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.doNotSyncBoundingInfo = true;
        mesh.renderingGroupId = 1;
        mesh.metadata = { triangles: mesh.getTotalIndices() / 3 };
        mesh.freezeWorldMatrix();

        const material = this._makeBeautyMaterial(name);
        material.backFaceCulling = false;
        material.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            material.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        mesh.material = material;

        // Keep a small, growable dynamic buffer. It is resized only if density
        // exceeds the previous maximum, and otherwise receives one update when
        // the player crosses a placement tile.
        const initial = new Float32Array(16 * 16);
        mesh.thinInstanceSetBuffer("matrix", initial, 16, false);
        mesh.thinInstanceCount = 0;

        return {
            name,
            mesh,
            material,
            cascades,
            radius,
            depthMaterials: [],
            transforms: initial,
            count: 0,
            prepassMaterial: null,
        };
    }

    _makeBeautyMaterial(name) {
        return new ShaderMaterial(
            name + "Material",
            this.scene,
            { vertex: "coastVegetation", fragment: "coastVegetation" },
            {
                attributes: ["position", "normal", "color"],
                uniforms: [
                    "viewProjection", "world", "cameraPos", "vegetationFocus", "vegetationRadius",
                    "shorelineZ", "coastlineVariation",
                    "vegetationTime", "vegetationWindDir", "vegetationWindStrength",
                    "sunDir", "sunRadiance", "shR", "cascadeMatrices", "cascadeSplits",
                    "cascadeParams", "shadowTexel", "shadowSoftness", "shadowBias",
                    "ambientIntensity", "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                ],
                samplers: ["skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.GLSL,
            }
        );
    }

    _makePrepassMaterial(item) {
        const material = new ShaderMaterial(
            item.name + "Prepass",
            this.scene,
            { vertex: "coastVegetationPrepass", fragment: "coastVegetationPrepass" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "world", "vegetationTime", "vegetationWindDir", "vegetationWindStrength",
                    "vegetationFocus", "vegetationRadius", "shorelineZ", "coastlineVariation",
                ],
                shaderLanguage: ShaderLanguage.GLSL,
            }
        );
        material.backFaceCulling = false;
        return material;
    }

    _makeDepthMaterial(item, cascade) {
        const material = new ShaderMaterial(
            item.name + "Depth" + cascade,
            this.scene,
            { vertex: "coastVegetationDepth", fragment: "coastVegetationDepth" },
            {
                attributes: ["position"],
                uniforms: [
                    "lightViewProjection", "world", "vegetationTime", "vegetationWindDir", "vegetationWindStrength",
                    "vegetationFocus", "vegetationRadius", "shorelineZ", "coastlineVariation",
                ],
                shaderLanguage: ShaderLanguage.GLSL,
                defines: ["SURFERFLOW_CASCADE " + cascade],
            }
        );
        material.backFaceCulling = false;
        item.depthMaterials.push(material);
        return material;
    }

    /** Compile each vegetation pipeline while the loading screen is up. */
    async warmUp() {
        for (const item of this.items) {
            const mesh = item.mesh;
            await whenReady(item.material, item.name + " beauty", [mesh, true]);
            await whenReady(item.prepassMaterial, item.name + " prepass", [mesh, true]);
            for (let i = 0; i < item.depthMaterials.length; i++) {
                await whenReady(item.depthMaterials[i], item.name + " shadow " + i, [mesh, true]);
            }
        }
    }

    /**
     * Update shared shader uniforms every frame; rebuild transforms only when
     * the focus crosses a tile or the user changes vegetation density.
     * @param {number} dt
     * @param {{x:number,z:number}} focus
     * @param {Vector3} cameraPos
     */
    update(dt, focus, cameraPos) {
        const x = Number.isFinite(focus?.x) ? focus.x : 0;
        const z = Number.isFinite(focus?.z) ? focus.z : 0;
        const cellX = Math.floor(x / TILE_SIZE);
        const cellZ = Math.floor(z / TILE_SIZE);
        const density = clamp(Number.isFinite(S.greeneryDensity) ? S.greeneryDensity : 1, 0, 2);
        const coastline = clamp(Number.isFinite(S.coastlineVariation) ? S.coastlineVariation : 1, 0, 2);

        const initial = !Number.isFinite(this._lastCellX);
        const cellChanged = cellX !== this._lastCellX || cellZ !== this._lastCellZ;
        if (initial) {
            this._requestedDensity = density;
            this._requestedCoastline = coastline;
            this._settingsSettle = 0;
            this._rebuild(x, z, density);
            this._lastCellX = cellX;
            this._lastCellZ = cellZ;
            this._lastDensity = density;
            this._lastCoastline = coastline;
        } else {
            if (density !== this._requestedDensity || coastline !== this._requestedCoastline) {
                this._requestedDensity = density;
                this._requestedCoastline = coastline;
                this._settingsSettle = SETTINGS_SETTLE_SECONDS;
            }

            if (this._settingsSettle > 0) {
                // Density and shore-shape sliders can emit many input events
                // per second. Wait for the drag to pause, then pay for one
                // deterministic rebuild at the latest focus and settings.
                const elapsed = Math.max(1 / 60, Number.isFinite(dt) ? Math.max(0, dt) : 0);
                this._settingsSettle -= elapsed;
                if (this._settingsSettle <= 0) {
                    this._rebuild(x, z, this._requestedDensity);
                    this._lastCellX = cellX;
                    this._lastCellZ = cellZ;
                    this._lastDensity = this._requestedDensity;
                    this._lastCoastline = this._requestedCoastline;
                }
            } else if (cellChanged) {
                this._rebuild(x, z, density);
                this._lastCellX = cellX;
                this._lastCellZ = cellZ;
                this._lastDensity = density;
                this._lastCoastline = coastline;
            }
        }

        this.time += Math.max(0, Number.isFinite(dt) ? dt : 0);
        _focus.set(x, z);
        const angle = (S.windDirection * Math.PI) / 180;
        _wind.set(Math.sin(angle), Math.cos(angle));
        for (const item of this.items) {
            item.mesh.isVisible = !!S.showGreenery && item.count > 0;
            this._pushFrameUniforms(item, cameraPos);
        }
    }

    setEnabled(enabled) {
        for (const item of this.items) item.mesh.isVisible = !!enabled && item.count > 0;
    }

    _pushFrameUniforms(item, cameraPos) {
        const m = item.material;
        const sh = this.shadows;
        m.setVector3("cameraPos", cameraPos);
        m.setVector2("vegetationFocus", _focus);
        m.setFloat("vegetationRadius", item.radius);
        m.setFloat("shorelineZ", this.terrain.heightfield.shorelineZ);
        m.setFloat("coastlineVariation", S.coastlineVariation);
        m.setFloat("vegetationTime", this.time);
        m.setVector2("vegetationWindDir", _wind);
        m.setFloat("vegetationWindStrength", S.windStrength);
        m.setVector3("sunDir", this.sky.sunDir);
        m.setColor3("sunRadiance", this.sky.sunRadiance);
        m.setArray4("shR", this.sky.sh);
        bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
        _splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);
        m.setVector4("cascadeSplits", _splits);
        m.setArray4("cascadeParams", sh.paramData);
        m.setFloat("shadowTexel", sh.texelSize);
        m.setFloat("shadowSoftness", 1.35);
        m.setFloat("shadowBias", 0.04);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);

        const p = item.prepassMaterial;
        p.setFloat("vegetationTime", this.time);
        p.setVector2("vegetationWindDir", _wind);
        p.setFloat("vegetationWindStrength", S.windStrength);
        p.setVector2("vegetationFocus", _focus);
        p.setFloat("vegetationRadius", item.radius);
        p.setFloat("shorelineZ", this.terrain.heightfield.shorelineZ);
        p.setFloat("coastlineVariation", S.coastlineVariation);
        for (const d of item.depthMaterials) {
            d.setFloat("vegetationTime", this.time);
            d.setVector2("vegetationWindDir", _wind);
            d.setFloat("vegetationWindStrength", S.windStrength);
            d.setVector2("vegetationFocus", _focus);
            d.setFloat("vegetationRadius", item.radius);
            d.setFloat("shorelineZ", this.terrain.heightfield.shorelineZ);
            d.setFloat("coastlineVariation", S.coastlineVariation);
        }
    }

    _rebuild(focusX, focusZ, density) {
        const lists = [[], [], [], []];
        if (density > 0) {
            scatterCover(lists[0], focusX, focusZ, this.items[0].radius, density, this.terrain);
            scatterScrub(lists[1], focusX, focusZ, this.items[1].radius, density, this.terrain);
            const trees = [];
            scatterTrees(trees, focusX, focusZ, this.items[2].radius, density, this.terrain);
            for (const tree of trees) {
                const oak = hash01(Math.floor(tree.x * 2), Math.floor(tree.z * 2), 701) > 0.38;
                lists[oak ? 3 : 2].push(tree);
            }
        }
        for (let i = 0; i < this.items.length; i++) {
            this._uploadInstances(this.items[i], lists[i]);
        }
    }

    _uploadInstances(item, plants) {
        const required = plants.length * 16;
        if (required > item.transforms.length) {
            let capacity = item.transforms.length;
            while (capacity < required) capacity *= 2;
            item.transforms = new Float32Array(capacity);
            item.mesh.thinInstanceSetBuffer("matrix", item.transforms, 16, false);
        }

        for (let i = 0; i < plants.length; i++) {
            const plant = plants[i];
            _scale.set(plant.scale, plant.scale, plant.scale);
            Quaternion.RotationYawPitchRollToRef(plant.yaw, 0, 0, _rotation);
            _translation.set(plant.x, plant.y, plant.z);
            Matrix.ComposeToRef(_scale, _rotation, _translation, _matrix);
            _matrix.copyToArray(item.transforms, i * 16);
        }

        item.count = plants.length;
        item.mesh.thinInstanceCount = plants.length;
        item.mesh.thinInstanceBufferUpdated("matrix");
    }

    get triangles() {
        if (!S.showGreenery) return 0;
        let total = 0;
        for (const item of this.items) {
            if (item.mesh.isVisible) total += item.mesh.metadata.triangles * item.count;
        }
        return total;
    }

    dispose() {
        for (const item of this.items) {
            item.mesh.dispose();
            item.material.dispose();
            item.prepassMaterial.dispose();
            for (const material of item.depthMaterials) material.dispose();
        }
    }
}

// Broad patches make groves and clearings rather than a uniform plant grid.
function coastalPatch(x, z) {
    return smooth01(0.50 + 0.26 * Math.sin(x * 0.037 + Math.sin(z * 0.026))
        + 0.24 * Math.sin(z * 0.049 - x * 0.018));
}

function scatterCover(out, focusX, focusZ, radius, density, terrain) {
    const spacing = 2.8;
    const buildRadius = radius + REBUILD_MARGIN;
    visitCells(focusX, focusZ, buildRadius, spacing, (gx, gz, x0, z0, d2) => {
        const shore = terrain.shorelineAt(x0) - z0;
        if (shore < 22 || d2 > buildRadius * buildRadius) return;
        const band = smooth01((shore - 22) / 14) * (1 - smooth01((shore - 98) / 38));
        const rx = hash01(gx, gz, 7);
        const rz = hash01(gx, gz, 31);
        const x = x0 + (rx - 0.5) * spacing * 0.76;
        const z = z0 + (rz - 0.5) * spacing * 0.76;
        if (terrain.shorelineAt(x) - z < 22) return;
        const plantDistance = (x - focusX) ** 2 + (z - focusZ) ** 2;
        const patch = coastalPatch(x, z);
        const chance = Math.min(0.94, (0.36 + patch * 0.48) * density * band);
        if (plantDistance > buildRadius * buildRadius || hash01(gx, gz, 101) > chance) return;
        out.push({
            x, z, y: terrain.heightAt(x, z),
            yaw: hash01(gx, gz, 173) * PI2,
            scale: 1.0 + hash01(gx, gz, 239) * 0.8,
        });
    });
    scatterClumps(out, focusX, focusZ, buildRadius, density, terrain, {
        tag: 1201, cellX: 36, cellZ: 30, shoreMin: 28, shoreMax: 98,
        chance: 0.4, offsets: [[-2.2, -1.0], [1.8, -1.4], [-1.4, 2.0], [2.3, 2.1]],
        scaleMin: 1.25, scaleMax: 1.95,
    });
}

function scatterScrub(out, focusX, focusZ, radius, density, terrain) {
    const spacing = 8.5;
    const buildRadius = radius + REBUILD_MARGIN;
    visitCells(focusX, focusZ, buildRadius, spacing, (gx, gz, x0, z0, d2) => {
        const shore = terrain.shorelineAt(x0) - z0;
        if (shore < 34 || shore > 335 || d2 > buildRadius * buildRadius) return;
        const band = smooth01((shore - 34) / 20) * (1 - smooth01((shore - 285) / 50));
        const x = x0 + (hash01(gx, gz, 13) - 0.5) * spacing * 0.68;
        const z = z0 + (hash01(gx, gz, 47) - 0.5) * spacing * 0.68;
        if ((x - focusX) ** 2 + (z - focusZ) ** 2 > buildRadius * buildRadius) return;
        if (hash01(gx, gz, 107) > Math.min(0.90, (0.32 + coastalPatch(x, z) * 0.40) * density * band)) return;
        out.push({
            x, z, y: terrain.heightAt(x, z),
            yaw: hash01(gx, gz, 181) * PI2,
            scale: 1.0 + hash01(gx, gz, 251) * 0.95,
        });
    });
    scatterClumps(out, focusX, focusZ, buildRadius, density, terrain, {
        tag: 2204, cellX: 58, cellZ: 42, shoreMin: 42, shoreMax: 160,
        chance: 0.28, offsets: [[-4.0, -0.6], [3.2, -2.4], [1.2, 3.8]],
        scaleMin: 1.05, scaleMax: 1.7,
    });
}

function scatterTrees(out, focusX, focusZ, radius, density, terrain) {
    const spacing = 15.5;
    const buildRadius = radius + REBUILD_MARGIN;
    visitCells(focusX, focusZ, buildRadius, spacing, (gx, gz, x0, z0, d2) => {
        const shore = terrain.shorelineAt(x0) - z0;
        if (shore < 48 || shore > 310 || d2 > buildRadius * buildRadius) return;
        // Put the strongest tree line behind the dunes, where it frames the
        // rider at normal camera distance. A light falloff beyond the inland
        // treeline avoids filling the whole horizon with tiny repeated pines.
        const band = smooth01((shore - 48) / 26) * (1 - smooth01((shore - 220) / 90));
        const x = x0 + (hash01(gx, gz, 17) - 0.5) * spacing * 0.64;
        const z = z0 + (hash01(gx, gz, 53) - 0.5) * spacing * 0.64;
        if ((x - focusX) ** 2 + (z - focusZ) ** 2 > buildRadius * buildRadius) return;
        if (hash01(gx, gz, 113) > Math.min(0.96, (0.30 + coastalPatch(x, z) * 0.48) * density * band)) return;
        out.push({
            x, z, y: terrain.heightAt(x, z),
            yaw: hash01(gx, gz, 191) * PI2,
            scale: 1.25 + hash01(gx, gz, 263) * 0.85,
        });
    });
    scatterClumps(out, focusX, focusZ, buildRadius, density, terrain, {
        tag: 3220, cellX: 60, cellZ: 48, shoreMin: 56, shoreMax: 190,
        chance: 0.4, offsets: [[-8.6, -1.6], [0.8, -6.0], [8.2, 1.8], [-1.8, 7.2]],
        scaleMin: 1.35, scaleMax: 2.15,
    });
}

/** Add sparse, repeatable plant groups while retaining the existing archetype batches. */
function scatterClumps(out, focusX, focusZ, buildRadius, density, terrain, spec) {
    const maxOffset = spec.offsets.reduce((max, offset) => Math.max(max, Math.hypot(offset[0], offset[1])), 0);
    const visitRadius = buildRadius + maxOffset + Math.hypot(spec.cellX, spec.cellZ) * 0.5;
    const minX = Math.floor((focusX - visitRadius) / spec.cellX);
    const maxX = Math.floor((focusX + visitRadius) / spec.cellX);
    const minZ = Math.floor((focusZ - visitRadius) / spec.cellZ);
    const maxZ = Math.floor((focusZ + visitRadius) / spec.cellZ);

    for (let gz = minZ; gz <= maxZ; gz++) {
        for (let gx = minX; gx <= maxX; gx++) {
            const centerX = (gx + 0.5) * spec.cellX
                + (hash01(gx, gz, spec.tag + 1) - 0.5) * spec.cellX * 0.24;
            const centerZ = (gz + 0.5) * spec.cellZ
                + (hash01(gx, gz, spec.tag + 2) - 0.5) * spec.cellZ * 0.24;
            const centerDistance = Math.hypot(centerX - focusX, centerZ - focusZ);
            if (centerDistance > visitRadius) continue;

            const shore = terrain.shorelineAt(centerX) - centerZ;
            if (shore < spec.shoreMin || shore > spec.shoreMax) continue;
            const shoreFade = smooth01((shore - spec.shoreMin) / 10)
                * (1 - smooth01((shore - spec.shoreMax + 18) / 22));
            if (hash01(gx, gz, spec.tag + 3) > Math.min(0.55, spec.chance * density * shoreFade)) continue;

            const yaw = hash01(gx, gz, spec.tag + 4) * PI2;
            const c = Math.cos(yaw), s = Math.sin(yaw);
            for (let i = 0; i < spec.offsets.length; i++) {
                const offset = spec.offsets[i];
                const jitter = 0.78 + hash01(gx, gz, spec.tag + 11 + i) * 0.44;
                const x = centerX + (offset[0] * c - offset[1] * s) * jitter;
                const z = centerZ + (offset[0] * s + offset[1] * c) * jitter;
                if ((x - focusX) ** 2 + (z - focusZ) ** 2 > buildRadius * buildRadius) continue;

                const plantShore = terrain.shorelineAt(x) - z;
                if (plantShore < spec.shoreMin || plantShore > spec.shoreMax + 8) continue;
                const scaleT = hash01(gx, gz, spec.tag + 29 + i);
                out.push({
                    x, z, y: terrain.heightAt(x, z),
                    yaw: hash01(gx, gz, spec.tag + 41 + i) * PI2,
                    scale: spec.scaleMin + scaleT * (spec.scaleMax - spec.scaleMin),
                });
            }
        }
    }
}

function visitCells(focusX, focusZ, radius, spacing, fn) {
    const minX = Math.floor((focusX - radius) / spacing);
    const maxX = Math.floor((focusX + radius) / spacing);
    const minZ = Math.floor((focusZ - radius) / spacing);
    const maxZ = Math.floor((focusZ + radius) / spacing);
    for (let gz = minZ; gz <= maxZ; gz++) {
        const z = (gz + 0.5) * spacing;
        for (let gx = minX; gx <= maxX; gx++) {
            const x = (gx + 0.5) * spacing;
            fn(gx, gz, x, z, (x - focusX) ** 2 + (z - focusZ) ** 2);
        }
    }
}

function hash01(x, z, salt) {
    let h = Math.imul((x | 0) ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b), 0xc2b2ae35);
    h ^= Math.imul((z | 0) + salt, 0x27d4eb2f);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

function smooth01(v) {
    const t = clamp(v, 0, 1);
    return t * t * (3 - 2 * t);
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// Blender exports use the same local axes and vertex colors as the instanced shader.
function assetGeometry(name) {
    const asset = vegetationAssets[name];
    const data = new VertexData();
    data.positions = asset.positions;
    data.normals = asset.normals;
    data.colors = asset.colors;
    data.indices = asset.indices;
    return data;
}
