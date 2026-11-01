/**
 * SurferFlow — entry point and frame orchestration.
 *
 * WebGL2 renderer and frame orchestration.
 */

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";

import { registerShaders } from "./shaders/registry.js";
import { S, onChange, applyPreset, PRESETS } from "./core/settings.js";
import {
    sample, checkSpike, stats, mark, installDrawCounter, endFrameDraws,
} from "./core/perf.js";
import { initInput, pollInput, endFrame, input } from "./core/input.js";
import { CameraRig } from "./core/camera.js";
import { CharacterController } from "./character/controller.js";
import { syncWaterSurface } from "./character/waterSurface.js";
import { Character } from "./character/character.js";
import { SandContact } from "./character/sandContact.js";
import { SprayField } from "./vfx/particles.js";
import { SurfWake } from "./vfx/surfWake.js";
import { Sky } from "./render/sky.js";
import { ShadowSystem } from "./render/shadows.js";
import { Terrain } from "./terrain/terrain.js";
import { Ocean } from "./world/ocean.js";
import { CoastalVegetation } from "./world/coastalVegetation.js";
import { DepthPass } from "./render/depthPass.js";
import { PostChain } from "./post/postChain.js";
import { whenReady } from "./core/gpuUtil.js";
import * as loading from "./core/loading.js";

// ------------------------------------------------------- module-scope scratch
const _vel = new Vector3();

async function boot() {
    const requestedQuality = new URLSearchParams(location.search).get("quality");
    if (requestedQuality && Object.hasOwn(PRESETS, requestedQuality)) applyPreset(requestedQuality);
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("view"));

    await loading.phase("creating WebGL2 context", 0.05);

    const engine = new Engine(canvas, false, {
        antialias: false, // TAA handles edges; MSAA here would just cost bandwidth
        stencil: false,
        powerPreference: "high-performance",
    });
    if (engine.webGLVersion < 2) {
        engine.dispose();
        loading.fail("WebGL 2 is not available in this browser.");
        return;
    }

    const applyScale = () => engine.setHardwareScalingLevel(1 / S.resolutionScale);
    applyScale();
    onChange("resolutionScale", applyScale);
    window.addEventListener("resize", () => engine.resize());

    installDrawCounter(engine);
    registerShaders();

    await loading.phase("building scene", 0.12);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    scene.autoClear = true;
    // Do NOT clear depth between rendering groups. Babylon clears depth before
    // every group by default; here group 1 is the opaque scene and group 2 is
    // the alpha-blended water and spray, which must depth-test against it.
    scene.setRenderingAutoClearDepthStencil(1, false);
    scene.setRenderingAutoClearDepthStencil(2, false);
    // No stock lights: every material here computes its own lighting.
    scene.ambientColor = new Color3(0, 0, 0);

    const rig = new CameraRig(scene, canvas);
    scene.activeCamera = rig.camera;

    // ------------------------------------------------------------------ sky
    await loading.phase("integrating atmosphere", 0.2);
    const sky = new Sky(scene);
    sky.mesh.renderingGroupId = 0;
    await sky.solve();

    // Broad coastal ocean with a camera-following clipmap and animated waves.
    const ocean = new Ocean(scene, sky, { shorelineZ: 0, waterLevel: 0 });

    // -------------------------------------------------------------- shadows
    const shadows = new ShadowSystem(scene);

    // The camera-space depth prepass. It is a custom render target, and the
    // scene renders those in registration order — so creating it here, after
    // the cascades and before anything that draws, is the whole of the
    // scheduling.
    const depthPass = new DepthPass(scene);

    // -------------------------------------------------------------- terrain
    await loading.phase("building coastal terrain", 0.34);
    const terrain = new Terrain(scene, sky, shadows, { shorelineZ: ocean.shorelineZ });
    terrain.mesh.renderingGroupId = 1;
    await terrain.build();
    onChange("showTerrain", (v) => (terrain.mesh.isVisible = v));
    depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());
    depthPass.registerCaster(ocean.mesh, ocean.makePrepassMaterial());

    // Share one time-synchronized ground query between the figure, cloth and
    // camera. On the sea side, the water surface (including troughs) owns height.
    let oceanFrameDt = 0;
    const groundAt = (x, z) => ocean.isWaterAt(x, z)
        ? ocean.surfaceHeightAt(x, z, ocean.time + oceanFrameDt)
        : terrain.heightAt(x, z);

    await loading.phase("placing character", 0.62);

    const character = new CharacterController(terrain, ocean);
    character.position.set(0, 0, -4);
    character.position.y = terrain.heightAt(character.position.x, character.position.z);

    // Deterministic grass, dune scrub and wind-shaped coastal pines. Each
    // category is one thin-instanced mesh that follows a bounded focus window.
    const vegetation = new CoastalVegetation(scene, terrain, sky, shadows, depthPass);
    onChange("showGreenery", (v) => vegetation.setEnabled(v));

    // The figure: skeleton, garment simulation, shell fur.
    const figure = new Character(scene, terrain, sky, shadows, character, groundAt);
    onChange("showCharacter", (v) => figure.setVisible(v));
    figure.registerPrepass(depthPass);

    // Shared airborne effects: beach footfalls, surf spray.
    const spray = new SprayField(scene, terrain, sky, shadows, ocean);

    // Feet and the surf groove write into the terrain state buffer through here.
    const contact = new SandContact(character, terrain.deform, figure.figure, spray);

    // The legacy swept wake mesh remains constructed for its particle emitter,
    // but the coast prototype draws the wake as foam on the ocean surface.
    const wake = new SurfWake(scene, sky, shadows, character, spray, terrain, ocean);
    wake.setWallEnabled(false);
    onChange("showWake", (v) => wake.setEnabled(v));
    wake.registerPrepass(depthPass);

    // The rig needs the terrain and current ocean crest under its spring arm.
    rig.groundAt = groundAt;

    const post = new PostChain(scene, rig.camera, depthPass, sky);

    initInput(canvas);

    // ------------------------------------------------------------- warm-up
    // Everything that can compile, compiles here — behind the loading screen.
    await loading.phase("compiling pipelines", 0.78);
    shadows.update(rig.camera, sky.sunDir);
    sky.render(rig, 0);
    await terrain.warmUp();
    terrain.update(rig.camera.position, character.position, 0);
    vegetation.update(0, character.position, rig.camera.position);
    await vegetation.warmUp();
    figure.update(0);
    figure.sync(rig.camera.position);
    await figure.warmUp();
    spray.update(0, rig.camera.position);
    await spray.warmUp();
    await wake.warmUp();
    await whenReady(sky.material, "sky material", [sky.mesh, false]);
    await whenReady(ocean.material, "ocean material", [ocean.mesh, false]);
    await depthPass.warmUp();
    post.update(0, rig.distance);
    const passes = post.passes;
    for (let i = 0; i < passes.length; i++) {
        await whenReady(passes[i], "post:" + passes[i].name);
    }

    await loading.phase("warming render targets", 0.92);
    // A few real frames so every render target is allocated and every pipeline
    // has actually been bound at least once. These manual frames still need the
    // engine lifecycle, so begin/endFrame wrap every render here too.
    for (let i = 0; i < 3; i++) {
        engine.beginFrame();
        try {
            scene.render();
        } finally {
            engine.endFrame();
        }
        await loading.nextFrame();
    }
    // Optional performance readout for profiling without opening devtools.
    if (new URLSearchParams(location.search).has("perf")) {
        const readout = document.createElement("output");
        readout.id = "performance-readout";
        readout.style.cssText = "position:fixed;top:12px;right:12px;z-index:1000;padding:8px;background:#000c;color:#fff;font:12px monospace;white-space:pre";
        document.body.appendChild(readout);
        window.setInterval(() => {
            readout.textContent = `FPS ${stats.fps.toFixed(1)}  1% low ${stats.fpsLow.toFixed(1)}\nFrame ${stats.median.toFixed(1)} ms  p95 ${stats.p95.toFixed(1)} ms\nDraws ${stats.drawCalls}  ${engine.getRenderWidth()}×${engine.getRenderHeight()}`;
        }, 1000);
    }
    // ------------------------------------------------------------- run loop
    let prev = performance.now();
    let time = 0;

    engine.runRenderLoop(() => {
        const now = performance.now();
        const frameMs = now - prev;
        let dtMs = frameMs;
        prev = now;
        const clockDt = S.freezeTime ? 0 : Math.min(dtMs / 1000, 1);
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;
        oceanFrameDt = dt;
        time += dt;

        pollInput();

        // Per-system CPU timings remain available to development tooling.
        const tFrame = performance.now();

        character.update(dt, rig);
        if (ocean.isWaterAt(character.position.x, character.position.z)) {
            // Keep the character visually riding the same animated water mesh.
            // The controller's horizontal physics stays on stable mean sea level.
            syncWaterSurface(character, groundAt(character.position.x, character.position.z));
        }
        // Pose and simulate before the contact pass: the footprints are stamped
        // at the boot's actual planted position, which only exists once the
        // figure has been solved.
        figure.update(dt);
        contact.update(dt);
        const tChar = performance.now();

        _vel.copyFrom(character.velocity);
        rig.update(dt, character.position, _vel, character.lean, character.speed01);

        // Jitters the projection and republishes everything the screen-space
        // passes derive from the camera. Must be after the rig has moved and
        // before anything reads `scene.getTransformMatrix()` — which the depth
        // prepass and the beauty pass both do.
        post.update(dt, rig.distance);
        sky.update(clockDt);
        sky.render(rig, time);
        shadows.update(rig.camera, sky.sunDir);
        terrain.update(rig.camera.position, character.position, dt, ocean.time + dt);
        ocean.update(dt, character.position, rig.camera.position, undefined, character);
        const tTerrain = performance.now();
        vegetation.update(dt, character.position, rig.camera.position);
        const tVegetation = performance.now();
        // After the shadow refit, so the figure's uniforms carry this frame's
        // cascade matrices rather than last frame's.
        figure.sync(rig.camera.position);
        // Before the spray: the wake decides where its own lip is, and the
        // droplets it sheds have to be in the pool before it is uploaded.
        wake.update(dt, rig.camera.position);
        spray.update(dt, rig.camera.position);
        const tVfx = performance.now();

        scene.render();
        post.endFrame();
        const tRender = performance.now();

        mark("cpu character", tChar - tFrame);
        mark("cpu terrain", tTerrain - tChar);
        mark("cpu vegetation", tVegetation - tTerrain);
        mark("cpu wake+spray", tVfx - tVegetation);
        mark("cpu submit", tRender - tVfx);
        mark("cpu total", tRender - tFrame);
        // Babylon's WebGL2 engine does not expose a GPU timestamp counter here.
        stats.gpuMs = 0;

        endFrameDraws();
        stats.triangles =
            (terrain.mesh.metadata ? terrain.mesh.metadata.triangles : 0) +
            (ocean.mesh.metadata ? ocean.mesh.metadata.triangles : 0) +
            vegetation.triangles +
            (S.showCharacter ? figure.triangles : 0) +
            (wake.mesh.isVisible ? wake.mesh.metadata.triangles : 0) +
            spray.liveCount * 2;

        sample(frameMs);
        checkSpike(frameMs);

        endFrame();
    });

    await loading.done();
    document.getElementById("surferflow-hud")?.classList.add("show");

    globalThis.SurferFlow = {
        engine, scene, rig, character, figure, contact, spray, wake,
        terrain, ocean, vegetation, sky, shadows, post, depthPass,
        S, input, perfStats: stats,
    };
}

boot().catch((err) => {
    console.error(err);
    loading.fail("Startup failed — see console.");
});
