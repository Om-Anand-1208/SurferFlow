/**
 * Central tuning + toggle store.
 *
 * `S` is a flat plain object read directly by systems every frame — no getters,
 * no proxies, no allocation. `onChange` lets systems react to edits that need work
 * (rebuilding a render target, re-freezing a material) rather than just being
 * sampled next frame.
 */

/** @type {Record<string, number|boolean|string>} */
export const S = {
    // ---------------------------------------------------------------- quality
    preset: "balanced",
    resolutionScale: 0.85,
    shadowResolution: 1024,

    // ------------------------------------------------------------------- sun
    skyMode: "time of day",
    timeOfDay: 10,
    dayNightCycle: true,
    dayLengthMinutes: 5,
    autoExposure: true,
    sunAzimuth: 150, // degrees, compass bearing of the sun
    // Used when Sky control is set to manual sun.
    sunElevation: 52.0,
    sunIntensity: 4.2,
    sunTempWarm: 0.65, // 0 = neutral white, 1 = full warm low-sun tint
    ambientIntensity: 1.0,
    ambientBlue: 1.0, // strength of the cool shadow shift

    // ------------------------------------------------------------- atmosphere
    fogDensity: 0.0008,
    fogHeightFalloff: 0.045,
    fogStart: 24,
    aerialStrength: 0.75,
    // Degrees. Drives sastrugi shear and dune orientation. Held 70-80 degrees
    // away from `sunAzimuth`: sastrugi ridges run along the wind, so when the
    // two align the sun rakes down every ridge, lights both flanks identically
    // and the fine structure reads as flat ground.
    windDirection: 42,
    windStrength: 1.0,
    /** Far-field mountain range on the skybox. */
    showMountains: false,
    /** Peak height of that range, metres. */
    mountainHeight: 2150,
    /** Strength of the volumetric shafts spilling past dune crests. */
    shaftStrength: 0.10,

    // ------------------------------------------------------------------- snow
    glintIntensity: 0.55,
    glintGrazing: 0.72, // how hard the grazing-angle gate bites
    sssStrength: 1.0,
    sssRadius: 1.0,
    detailNormalStrength: 1.0,
    macroHeightScale: 1.0,
    sastrugiStrength: 1.0,

    // ----------------------------------------------------------- deformation
    deformDepth: 1.0,
    deformBerm: 1.0,
    refillRate: 1.0,
    deformResolution: 1024,

    // ------------------------------------------------------------- snow-surf
    /** Height of the breaking wall thrown by a carve, as a multiple of 1.45 m. */
    wakeHeight: 1.0,
    /** Density of the plume shed off the wake's lip. */
    wakeSpray: 1.0,

    // ------------------------------------------------------------------ water
    oceanWaveHeight: 1.0,
    oceanWaveSets: true,
    oceanWaveSetSeconds: 30,
    oceanWaveSpeed: 1.0,
    oceanFoamStrength: 1.35,
    /** Screen-filtered world-space sand relief and grain contrast. */
    sandDetailStrength: 1.0,
    /** Alongshore-varying damp sand margin, in metres. */
    wetSandWidth: 7.8,
    /** Distance over which nearshore water shifts to deep-ocean color. */
    oceanColorSpan: 125.0,
    /** Alongshore shoreline variation multiplier; 0 gives a straight shore. */
    coastlineVariation: 1.0,
    /** Procedural land-side grass, scrub and coastal trees. */
    showGreenery: true,
    /** Density multiplier for the deterministic vegetation field. */
    greeneryDensity: 1.0,

    // ------------------------------------------------------------------ post
    taa: true,
    ssr: false,
    dof: false,
    bloom: true,
    grain: true,
    sharpen: true,
    tonemap: "agx", // "agx" | "aces" | "none"
    // Coastal daylight multiplier; adaptive exposure scales this at night.
    exposure: 0.16,
    contrast: 1.04,
    bloomStrength: 0.10,
    grainStrength: 0.008,
    sharpenStrength: 0.55,

    // --------------------------------------------------------------- systems
    showTerrain: true,
    showCharacter: true,
    showWake: true,
    showLightShafts: true,
    wireframe: false,
    freezeTime: false,

    // ----------------------------------------------------------------- debug
    debugView: "beauty", // beauty | deform | normals | depth | cascades | footprint | fineNormals
};

/** Quality presets, selected at startup before render targets are built. */
export const PRESETS = {
    ultra: { deformResolution: 2048, shadowResolution: 2048, resolutionScale: 1.0, ssr: true, dof: false },
    high: { deformResolution: 2048, shadowResolution: 2048, resolutionScale: 1.0, ssr: true, dof: true },
    balanced: { deformResolution: 1024, shadowResolution: 1024, resolutionScale: 0.85, ssr: false, dof: false },
};

/** @type {Map<string, Set<(v:any, k:string) => void>>} */
const listeners = new Map();

/**
 * Subscribe to a settings key. Returns an unsubscribe function.
 * @param {string|string[]} keys
 * @param {(v:any, k:string) => void} fn
 */
export function onChange(keys, fn) {
    const list = typeof keys === "string" ? [keys] : keys;
    for (let i = 0; i < list.length; i++) {
        let set = listeners.get(list[i]);
        if (!set) {
            set = new Set();
            listeners.set(list[i], set);
        }
        set.add(fn);
    }
    return () => {
        for (let i = 0; i < list.length; i++) listeners.get(list[i])?.delete(fn);
    };
}

/**
 * Write a settings value and notify subscribers. Never called from the render
 * loop — only from development tooling and preset application.
 * @param {string} k
 * @param {number|boolean|string} v
 */
export function set(k, v) {
    if (S[k] === v) return;
    S[k] = v;
    const set_ = listeners.get(k);
    if (set_) for (const fn of set_) fn(v, k);
}

/** @param {keyof typeof PRESETS} name */
export function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    S.preset = name;
    for (const k in p) set(k, p[k]);
}
