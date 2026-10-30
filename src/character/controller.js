/**
 * Character locomotion + surf physics.
 *
 * This owns motion only — the visual rig, cloth and fur read the state this
 * produces. Two modes share one integrator:
 *
 *  - WALK: camera-relative desired velocity, eased facing, distance-driven gait
 *    phase so footfalls land where the feet actually are (no sliding).
 *  - SURF: camera-relative input, with Shift for faster riding and no idle drift.
 *
 * Blending between them is eased in both directions; there is no snap.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { input } from "../core/input.js";
import { expDamp } from "../core/camera.js";

const _wish = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();

const WALK_SPEED = 2.5;
const RUN_SPEED = 5.4;
const WALK_ACCEL = 26;
const WALK_DECEL = 30;

const SURF_MAX = 19.5;
const SURF_SPEED = 8.0;
const SURF_ACCEL = 22;
const JUMP_SPEED = 6.0;
const GRAVITY = 18.0;

/** Gait: metres of travel per full stride cycle, scaled by speed. */
export function gaitStride(speed) {
    const run = Math.max(0, Math.min(1, (speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED)));
    return 0.95 + 0.45 * run;
}

export class CharacterController {
    /**
     * @param {{ heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:Vector3):Vector3 }} terrain
     * @param {{ isWaterAt(x:number,z:number):boolean }|null} [ocean]
     */
    constructor(terrain, ocean = null) {
        this.terrain = terrain;
        this.ocean = ocean;

        this.position = new Vector3(0, 0, 0);
        this.velocity = new Vector3(0, 0, 0);
        this.prevVelocity = new Vector3(0, 0, 0);
        this.acceleration = new Vector3(0, 0, 0);

        this.facing = 0; // yaw, radians
        this.speed = 0;
        this.speed01 = 0; // normalised against SURF_MAX

        /** 0 = walking, 1 = fully surfing. Eased. */
        this.surf = 0;
        this.inWater = false;
        this.surfActive = false;

        /** Signed lean, -1..1 (right positive), from lateral acceleration. */
        this.lean = 0;
        /** Signed carve amount for wake shaping. Positive = turning right. */
        this.carve = 0;
        this.jumpHeight = 0;
        this.jumpVelocity = 0;
        this.airborne = false;

        // ------------------------------------------------------------- gait
        this.gaitPhase = 0;
        /**
         * True when the legs should be running a gait at all.
         *
         * One flag, read by the figure and by the contact system, because three
         * copies of "is this character walking" is three chances for the feet to
         * disagree with the footprints.
         */
        this.stepping = false;
        /** Set true for exactly one frame when a foot plants. */
        this.footfall = false;
        /** 0 = left foot, 1 = right foot — which foot just planted. */
        this.footIndex = 0;
        /** World position of the foot that just planted. */
        this.footPos = new Vector3();
        /** Impact strength 0..1, scales spray and deformation depth. */
        this.footImpact = 0;

        this.groundY = 0;
        this.groundNormal = new Vector3(0, 1, 0);

        this._prevSpeed = 0;
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        const h = Math.max(0, Math.min(dt, 0.1));
        if (h === 0) { this.footfall = false; return; }

        this.prevVelocity.copyFrom(this.velocity);
        this.inWater = this.ocean
            ? this.ocean.isWaterAt(this.position.x, this.position.z)
            : false;
        // Enter surf mode at the shoreline. The blend below brings the board
        // under the feet without requiring a separate mouse button.
        this.surfActive = this.inWater;

        // Ease the surf blend — entering and exiting are transitions, not switches.
        this.surf = expDamp(this.surf, this.surfActive ? 1 : 0, this.surfActive ? 2.6 : 3.4, h);

        rig.getFlatForward(_fwd);
        rig.getFlatRight(_right);

        // A jump retains takeoff momentum, including after movement is released.
        if (!this.airborne) {
            if (this.surf > 0.5) this._surfStep(h);
            else this._walkStep(h);
        }
        if (!this.airborne && this.inWater && Math.hypot(input.moveX, input.moveZ) < 0.001) {
            this.velocity.x = 0;
            this.velocity.z = 0;
        }

        // ---------------------------------------------------- integrate + snap
        this.position.x += this.velocity.x * h;
        this.position.z += this.velocity.z * h;

        this.groundY = this.ocean?.isWaterAt(this.position.x, this.position.z)
            ? this.ocean.surfaceHeightAt(this.position.x, this.position.z, this.ocean.time + h)
            : this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);
        // Vertical motion is relative to the local sand or wave surface.
        const surfaceY = expDamp(this.position.y - this.jumpHeight, this.groundY, 26, h);
        if (input.jumpPressed && !this.airborne) {
            this.jumpVelocity = JUMP_SPEED;
            this.airborne = true;
        }
        if (this.airborne) {
            this.jumpHeight += this.jumpVelocity * h - 0.5 * GRAVITY * h * h;
            this.jumpVelocity -= GRAVITY * h;
            if (this.jumpHeight <= 0) {
                this.jumpHeight = 0;
                this.jumpVelocity = 0;
                this.airborne = false;
            }
        }
        this.velocity.y = this.jumpVelocity;
        this.position.y = surfaceY + this.jumpHeight;

        // --------------------------------------------------------- bookkeeping
        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        this.speed01 = Scalar.Clamp(this.speed / SURF_MAX, 0, 1);

        this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
        this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;

        // Lateral acceleration → lean. Project accel onto the character's right.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
        const leanWant = Scalar.Clamp(latAcc / 26, -1, 1) * (0.35 + 0.65 * this.surf);
        this.lean = expDamp(this.lean, leanWant, 6.5, h);
        this.carve = expDamp(this.carve, leanWant, 9, h);

        this._gait(h);
    }

    _walkStep(h) {
        const maxSpeed = input.sprint ? RUN_SPEED : WALK_SPEED;

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            _wish.x = (_wish.x / wishLen) * maxSpeed;
            _wish.z = (_wish.z / wishLen) * maxSpeed;

            const dx = _wish.x - this.velocity.x;
            const dz = _wish.z - this.velocity.z;
            const delta = Math.hypot(dx, dz);
            const gain = delta > 0 ? Math.min(1, WALK_ACCEL * h / delta) : 0;
            this.velocity.x += dx * gain;
            this.velocity.z += dz * gain;

            // Face the direction of travel, eased.
            const want = Math.atan2(_wish.x, _wish.z);
            this.facing = angleDamp(this.facing, want, 11, h);
        } else {
            const d = WALK_DECEL * h;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const k = Math.max(0, s - d) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            }
        }
    }

    _surfStep(h) {
        const amount = Math.hypot(input.moveX, input.moveZ);
        if (amount < 0.001) {
            // Releasing movement holds the board at its current X/Z location.
            this.velocity.x = 0;
            this.velocity.z = 0;
            return;
        }
        const maxSpeed = input.sprint ? SURF_MAX : SURF_SPEED;
        _wish.set(
            (_fwd.x * input.moveZ + _right.x * input.moveX) / amount * maxSpeed,
            0,
            (_fwd.z * input.moveZ + _right.z * input.moveX) / amount * maxSpeed
        );
        const dx = _wish.x - this.velocity.x;
        const dz = _wish.z - this.velocity.z;
        const delta = Math.hypot(dx, dz);
        const gain = delta > 0 ? Math.min(1, SURF_ACCEL * h / delta) : 0;
        this.velocity.x += dx * gain;
        this.velocity.z += dz * gain;
        this.facing = angleDamp(this.facing, Math.atan2(_wish.x, _wish.z), 8, h);
    }

    /**
     * Distance-driven gait. Phase advances with ground travelled, not with time,
     * which is what keeps feet planted instead of sliding.
     */
    _gait(h) {
        this.footfall = false;

        // Feet stay on the board while surfing — and for the run-out afterwards.
        //
        // The surf blend eases to zero in a fifth of a second, but the momentum
        // takes two thirds of one to bleed off, and in between the character is
        // travelling at nineteen metres a second. The gait is distance-driven, so
        // it answered that with a twelve-hertz cadence and the legs blurred. A
        // sprint is the fastest thing anyone walks at; above it, glide.
        this.stepping = !this.airborne && this.surf <= 0.5 && this.speed <= RUN_SPEED * 1.2 && this.speed > 0.12;
        if (!this.stepping) {
            this.gaitPhase = 0;
            return;
        }

        const dist = this.speed * h;
        const stride = gaitStride(this.speed);
        const prev = this.gaitPhase;
        this.gaitPhase = (this.gaitPhase + dist / stride) % 1;

        if (this.speed < 0.15) return;

        // Two plants per cycle, at phase 0.0 and 0.5.
        const crossed =
            (prev < 0.5 && this.gaitPhase >= 0.5) || this.gaitPhase < prev;
        if (!crossed) return;

        this.footfall = true;
        this.footIndex = this.gaitPhase < 0.5 ? 0 : 1;
        this.footImpact = Scalar.Clamp(0.35 + this.speed / RUN_SPEED, 0, 1.3);

        // Offset the plant to the correct side of the body.
        const side = this.footIndex === 0 ? -0.17 : 0.17;
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        this.footPos.set(
            this.position.x + rx * side,
            this.position.y,
            this.position.z + rz * side
        );
    }
}

// ------------------------------------------------------------------ helpers

/** Shortest signed delta from a to b, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Framerate-independent easing across the shortest arc. */
export function angleDamp(cur, target, rate, dt) {
    return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
