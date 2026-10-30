/**
 * Coastal day/night sky. A shared HDR texture supplies the visible dome,
 * ambient SH, water reflections and fog, so every surface follows one clock.
 * The visible sky updates continuously; ambient projections are blended between samples.
 */

import { Vector2, Vector3, Color3 } from "@babylonjs/core/Maths/math";
import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { makeStarField } from "../core/starField.js";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { S } from "../core/settings.js";
import { solarPosition, advanceClock, smooth01 } from "../core/dayNight.js";
import { whenReady } from "../core/gpuUtil.js";

const LUT_W = 512;
const LUT_H = 256;
const SH_W = 64; // low-res copy, read back on the CPU for the SH projection
const SH_H = 32;

/**
 * Converts the `sunIntensity` slider into the shared radiometric scale used by
 * both the sky integral and the direct sun. Its absolute value is arbitrary —
 * exposure handles overall brightness — but it must be *one* number, applied to
 * both, or the sun/sky ratio stops meaning anything.
 */
const SUN_SCALE_BASE = 5.5;

const _dir = new Vector3();

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export class Sky {
    /** @param {import("@babylonjs/core/scene").Scene} scene */
    constructor(scene) {
        this.scene = scene;
        this.engine = scene.getEngine();

        /** Unit vector pointing *toward* the sun. */
        this.sunDir = new Vector3(0, 0.2, 1);
        this.solarDir = new Vector3(0, 0.2, 1);
        this._bakedSolarDir = new Vector3(0, -1, 0);
        this.daylight = 1;
        this.nightAmount = 0;
        this.exposureScale = 1;
        this._solving = false;
        this.clockLabel = document.getElementById("day-clock");
        this._clockMinute = -1;
        this._clockMode = "";
        this._lastIntensity = -1;
        this._lastBakeAt = 0;
        this._prevUpdateAt = performance.now();
        /** Normalised hue of direct sunlight, for tinting effects. */
        this.sunColor = new Color3(1, 0.85, 0.66);
        /**
         * Direct solar irradiance reaching the ground, in the *same units the
         * sky LUT stores radiance in*. Everything downstream reads this rather
         * than an intensity-times-colour pair, because the sun and the sky have
         * to be on one scale or the balance between them is arbitrary — and
         * that balance is the entire cool-shadow / warm-light look.
         */
        this.sunRadiance = new Color3(1, 1, 1);
        /** Shared radiometric scale for the sun and the baked sky. */
        this.sunScale = 1;
        /** Radiance leaving the sand field, solved iteratively. */
        this.groundBounce = new Color3(0, 0, 0);
        /** 36 floats: 9 SH coefficients as vec4, for the shader UBO. */
        this.sh = new Float32Array(36);
        this._targetSH = new Float32Array(36);
        this._hasSH = false;

        this._dirty = true;

        // ------------------------------------------------------------- LUTs
        this.lut = new ProceduralTexture(
            "skyLUT",
            { width: LUT_W, height: LUT_H },
            "skyBake",
            scene,
            {
                generateMipMaps: true,
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.GLSL,
                skipSceneRegistration: true,
            }
        );
        this.lut.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.lut.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.lut.refreshRate = 0; // manual

        this.shLut = new ProceduralTexture(
            "skySH",
            { width: SH_W, height: SH_H },
            "skyBake",
            scene,
            {
                generateMipMaps: false,
                // The 64x32 SH source only needs half precision; Babylon
                // expands this readback to Float32Array before projection.
                // This avoids requiring a 32-bit float render target here.
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.GLSL,
                skipSceneRegistration: true,
            }
        );
        this.shLut.refreshRate = 0;

        // ----------------------------------------------------------- skybox
        this.mesh = CreateBox("sky", { size: 2 }, scene);
        this.mesh.infiniteDistance = false; // positioned manually in the shader
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.isPickable = false;
        this.mesh.renderingGroupId = 0;

        const mat = new ShaderMaterial(
            "skyMat",
            scene,
            { vertex: "sky", fragment: "sky" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection",
                    "cameraPosition",
                    "skyScale",
                    "sunDir",
                    "solarDir", "daylight", "nightAmount",
                    "sunColor",
                    "sunIntensity",
                    "time",
                    "windDir",
                    "cloudAmount",
                    "sunRadiance",
                    "shR",
                    "ambientIntensity",
                    "ridgeAmp",
                    "fogDensity",
                    "fogHeightFalloff",
                    "fogStart",
                    "aerialStrength",
                ],
                samplers: ["skyLUT", "starAtlas"],
                shaderLanguage: ShaderLanguage.GLSL,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.setTexture("skyLUT", this.lut);
        this.starAtlas = RawTexture.CreateRGBATexture(makeStarField(), 2048, 1024,
            scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
        this.starAtlas.wrapU = Texture.WRAP_ADDRESSMODE;
        this.starAtlas.wrapV = Texture.CLAMP_ADDRESSMODE;
        mat.setTexture("starAtlas", this.starAtlas);
        this.mesh.material = mat;
        this.material = mat;

        this._shReadback = null;
        this.syncFromSettings();
        // Register all procedural uniforms before isReady compiles the effect.
        this._setBakeUniforms();
    }

    /**
     * Recompute the sun vector and colour from the settings, and mark the LUT
     * for a rebake if anything actually moved.
     */
    syncFromSettings() {
        const solar = S.skyMode === "manual sun"
            ? { azimuth: S.sunAzimuth, elevation: S.sunElevation }
            : solarPosition(S.timeOfDay);
        const az = solar.azimuth * Math.PI / 180;
        const el = solar.elevation * Math.PI / 180;
        const ce = Math.cos(el);
        this.solarDir.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);
        this.daylight = smooth01(-0.10, 0.18, this.solarDir.y);
        this.nightAmount = 1 - smooth01(-0.18, 0.02, this.solarDir.y);
        // Turn the direct-light direction gradually from sun to moon through
        // twilight; an instantaneous reversal makes shadows jump at the horizon.
        const moonBlend = smooth01(0.02, 0.14, -this.solarDir.y);
        const turn = Math.PI * moonBlend;
        const cTurn = Math.cos(turn), sTurn = Math.sin(turn);
        this.sunDir.set(
            this.solarDir.x * cTurn - this.solarDir.z * sTurn,
            Math.abs(this.solarDir.y),
            this.solarDir.x * sTurn + this.solarDir.z * cTurn
        ).normalize();
        if (this.solarDir.subtractToRef(this._bakedSolarDir, _dir).lengthSquared() > 0.0001
            || S.sunIntensity !== this._lastIntensity) this._dirty = true;
        this.sunScale = S.sunIntensity * SUN_SCALE_BASE;

        // Direct sunlight reddens as it grazes: the lower the sun, the longer
        // the path through the atmosphere and the more of the blue end is
        // scattered out of the beam. At 13 degrees the beam has already lost
        // most of its blue, which is what makes the warm-light / cool-shadow
        // split physical rather than an art choice.
        const zenithDeg = (Math.acos(clamp(this.solarDir.y, -1, 1)) * 180) / Math.PI;

        // Kasten-Young air mass — stays finite at the horizon, unlike 1/cos.
        const denom =
            Math.cos((zenithDeg * Math.PI) / 180) +
            0.50572 * Math.pow(Math.max(1e-3, 96.07995 - zenithDeg), -1.6364);
        const airMass = Math.min(denom > 0 ? 1 / denom : 40, 40);

        // Vertical optical depth: scattering coefficient x scale height.
        const warm = S.sunTempWarm;
        const tauR = [0.0464, 0.108, 0.265];
        const tauM = 0.0252;
        const r = Math.exp(-(tauR[0] * warm + tauM) * airMass);
        const g = Math.exp(-(tauR[1] * warm + tauM) * airMass);
        const b = Math.exp(-(tauR[2] * warm + tauM) * airMass);

        const sunlight = smooth01(-0.035, 0.06, this.solarDir.y);
        const moonlight = this.nightAmount * smooth01(0.0, 0.25, -this.solarDir.y);
        this.sunRadiance.set(
            r * this.sunScale * sunlight + 0.35 * moonlight,
            g * this.sunScale * sunlight + 0.50 * moonlight,
            b * this.sunScale * sunlight + 0.85 * moonlight
        );

        const m = Math.max(r, Math.max(g, b)) || 1;
        this.sunColor.set(r / m, g / m, b / m);
    }

    /** Advance the clock and update the visible sky and ambient lighting. */
    update(dt = 0) {
        if (S.skyMode === "time of day" && S.dayNightCycle) {
            S.timeOfDay = advanceClock(S.timeOfDay, dt, S.dayLengthMinutes);
        }
        this.syncFromSettings();
        const now = performance.now();
        const visualDt = Math.min(0.1, Math.max(0, (now - this._prevUpdateAt) / 1000));
        this._prevUpdateAt = now;
        const targetExposure = 1 + this.nightAmount * 1.8;
        this.exposureScale += (targetExposure - this.exposureScale) * (1 - Math.exp(-visualDt * 1.8));
        // The inexpensive sky gradient is rendered continuously so the visible
        // sky and reflections follow the moving sun without half-second steps.
        if (this.lut.isReady()) {
            this._setBakeUniforms();
            this.lut.render();
        }
        // Ambient coefficients come from a less frequent GPU readback. Ease to
        // the new sample so lighting does not jump on each completed projection.
        const blend = 1 - Math.exp(-visualDt * 4);
        if (this._hasSH) {
            for (let i = 0; i < this.sh.length; i++) {
                this.sh[i] += (this._targetSH[i] - this.sh[i]) * blend;
            }
        }
        if (!this._dirty || this._solving || now - this._lastBakeAt < 500) return false;
        if (!this.lut.isReady() || !this.shLut.isReady()) return false;
        this._lastBakeAt = now;
        this.solve().catch((error) => console.error("Sky update failed", error));
        return true;
    }

    /** Bake shared sky radiance, project ambient SH, then update sand bounce. */
    async solve() {
        if (this._solving) return;
        this._solving = true;
        try {
            this.syncFromSettings();
            await whenReady(this.lut, "skyLUT");
            await whenReady(this.shLut, "skySH");
            this._bakedSolarDir.copyFrom(this.solarDir);
            this._lastIntensity = S.sunIntensity;
            this._dirty = false;
            // Project one low-resolution sample per update. The displayed SH
            // eases towards it in update(), avoiding repeated GPU readbacks.
            this._setBakeUniforms();
            this.shLut.render();
            await this.projectSH();
            if (!this._hasSH) {
                this.sh.set(this._targetSH);
                this._hasSH = true;
            }
            this._updateGroundBounce();
            this._setBakeUniforms();
            this.lut.render();
        } finally {
            this._solving = false;
        }
    }

    /** Radiance leaving the sand, from everything currently landing on it. */
    _updateGroundBounce() {
        // Irradiance arriving on horizontal ground: direct sun (cosine-weighted)
        // plus the whole sky hemisphere, which the SH already integrates.
        const up = this._irradianceUp();
        const c = Math.max(0, this.sunDir.y);
        const er = this.sunRadiance.r * c + up[0];
        const eg = this.sunRadiance.g * c + up[1];
        const eb = this.sunRadiance.b * c + up[2];

        // Lambertian re-emission: L = albedo * E / PI.
        const k = 1 / Math.PI;
        this.groundBounce.set(
            SAND_ALBEDO[0] * er * k,
            SAND_ALBEDO[1] * eg * k,
            SAND_ALBEDO[2] * eb * k
        );
    }

    /** SH irradiance for an up-facing normal. */
    _irradianceUp() {
        const sh = this.sh;
        const out = _irrTmp;
        for (let k = 0; k < 3; k++) {
            // Only the bands that survive n = (0,1,0).
            out[k] =
                sh[0 * 4 + k] * 0.886227 +
                sh[1 * 4 + k] * 2 * 0.511664 +
                sh[6 * 4 + k] * -0.247708 +
                sh[8 * 4 + k] * -0.429043;
        }
        return out;
    }

    _setBakeUniforms() {
        for (const t of [this.lut, this.shLut]) {
            t.setVector3("sunDir", this.solarDir);
            t.setFloat("sunIntensity", this.sunScale);
            // Color3, so setColor3 — setVector3 would read .x/.y/.z off it,
            // find undefined, and write NaN straight into the uniform buffer.
            t.setColor3("groundBounce", this.groundBounce);
        }
    }

    /**
     * Project the baked sky into 9 SH coefficients on the CPU.
     *
     * Done here rather than on the GPU because it is a one-off reduction over
     * 2048 texels — dispatching that would cost more to set up than to run —
     * and because the coefficients need to reach a uniform buffer anyway.
     */
    async projectSH() {
        const data = await this.shLut.readPixels(0, 0);
        if (!data) return;
        const px = /** @type {Float32Array} */ (data);

        const sh = this._targetSH;
        const Y = _shBasis;
        sh.fill(0);

        // Each texel subtends dω = sinθ · (2π/W) · (π/H).
        const dOmega = ((2 * Math.PI) / SH_W) * (Math.PI / SH_H);

        for (let y = 0; y < SH_H; y++) {
            const theta = ((y + 0.5) / SH_H) * Math.PI;
            const st = Math.sin(theta);
            const ct = Math.cos(theta);
            const w = st * dOmega;

            for (let x = 0; x < SH_W; x++) {
                const phi = ((x + 0.5) / SH_W - 0.5) * 2 * Math.PI;
                const dx = st * Math.sin(phi);
                const dy = ct;
                const dz = st * Math.cos(phi);

                // Real SH basis, bands 0..2.
                Y[0] = 0.282095;
                Y[1] = 0.488603 * dy;
                Y[2] = 0.488603 * dz;
                Y[3] = 0.488603 * dx;
                Y[4] = 1.092548 * dx * dy;
                Y[5] = 1.092548 * dy * dz;
                Y[6] = 0.315392 * (3 * dz * dz - 1);
                Y[7] = 1.092548 * dx * dz;
                Y[8] = 0.546274 * (dx * dx - dy * dy);

                const i = (y * SH_W + x) * 4;
                const r = px[i] * w;
                const g = px[i + 1] * w;
                const b = px[i + 2] * w;

                for (let c = 0; c < 9; c++) {
                    sh[c * 4] += r * Y[c];
                    sh[c * 4 + 1] += g * Y[c];
                    sh[c * 4 + 2] += b * Y[c];
                }
            }
        }
    }

    /** @param {import("../core/camera.js").CameraRig} rig */
    render(rig, time) {
        const minute = Math.floor((((S.timeOfDay % 24) + 24) % 24) * 60);
        const mode = S.skyMode === "manual sun" ? "Manual sun"
            : this.nightAmount > 0.7 ? "Night" : this.daylight < 0.7 ? (S.timeOfDay < 12 ? "Sunrise" : "Sunset") : "Day";
        if (this.clockLabel && (minute !== this._clockMinute || mode !== this._clockMode)) {
            this._clockMinute = minute;
            this._clockMode = mode;
            this.clockLabel.textContent = String(Math.floor(minute / 60)).padStart(2, "0")
                + ":" + String(minute % 60).padStart(2, "0") + " · " + mode;
        }
        const a = (S.windDirection * Math.PI) / 180;
        _wind.set(Math.sin(a), Math.cos(a));

        const m = this.material;
        m.setVector3("cameraPosition", rig.camera.position);
        m.setFloat("skyScale", rig.camera.maxZ * 0.5);
        m.setVector3("sunDir", this.sunDir);
        m.setVector3("solarDir", this.solarDir);
        m.setFloat("daylight", this.daylight);
        m.setFloat("nightAmount", this.nightAmount);
        m.setColor3("sunColor", this.sunColor);
        m.setFloat("sunIntensity", this.sunScale);
        m.setFloat("time", time);
        m.setVector2("windDir", _wind);
        m.setFloat("cloudAmount", 0.55);

        // The far range. Lit by the same radiance and the same SH the sand is —
        // see `shadeRidge` in the fragment shader.
        m.setColor3("sunRadiance", this.sunRadiance);
        m.setArray4("shR", this.sh);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setFloat("ridgeAmp", S.showMountains ? S.mountainHeight : 0);

        // The field's own haze, so the range is hazed by the same atmosphere the
        // dunes are and the two meet at one colour rather than two.
        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
    }

    dispose() {
        this.starAtlas.dispose();
        this.lut.dispose();
        this.shLut.dispose();
        this.mesh.dispose();
        this.material.dispose();
    }
}

const _shBasis = new Float32Array(9);
const _irrTmp = new Float32Array(3);
const _wind = new Vector2(0, 1);

/** Warm coastal sand reflects less light than the old high-albedo terrain. */
const SAND_ALBEDO = [0.57, 0.405, 0.225];
