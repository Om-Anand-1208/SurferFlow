# SurferFlow

A procedural coastal surfing playground built with **Babylon.js, WebGL 2 and
native GLSL ES 3.00**. Explore a meandering beach, head into the ocean and ride
changing swells through a five-minute day and night cycle.

The coast, water and stars are generated from code. The surfboard, vegetation
and Blender-edited rider use local meshes; no downloaded models or texture assets
are required.

## Features

- An unbounded coast with terrain and ocean geometry generated around the rider.
- Five directional swells, changing wave sets, shoreline foam and a surfer wake.
- Automatic transition from carrying the board on land to standing on it at sea.
- Walking, running, surfing and jumps that retain forward momentum.
- Sunrise, sunset, moonlight and twinkling stars in a five-minute cycle.
- Open beach sand with sea oats, dune scrub, pines and coastal oaks farther inland.
- A Blender-edited rider with board shorts, a sleeveless top, hair and sunglasses.
- Native GLSL shaders, cascaded shadows and temporal antialiasing.

## Run locally

Install Node.js and npm, then run:

```sh
npm ci
npm run dev
```

Open the local address printed by Vite, normally `http://localhost:5173`.
A browser and graphics device with **WebGL 2 support** are required.
The loading screen waits for shader compilation before the scene starts.

### Production build

```sh
npm run build
npm run preview
```

`npm run build` writes the static website to `dist/`. `npm run preview` serves that
build locally; use the address printed in the terminal.

For static hosting, use **`npm run build`** as the build command and **`dist`** as
the output directory. The deployed game does not require a backend server.

## Controls

| Input | Action |
|---|---|
| Click the scene | Capture the pointer for mouse look |
| Mouse / drag | Look around; drag works when pointer lock is unavailable |
| Trackpad two-finger scroll / mouse wheel | Zoom; horizontal scrolling turns the camera |
| Trackpad pinch | Zoom |
| Touchscreen | Drag to look, pinch or use +/− to zoom; use the movement, jump, and speed buttons |
| WASD / arrow keys | Move relative to the camera |
| Shift + movement | Run on land or surf faster |
| Space | Jump on land or water |
| Escape | Release pointer capture |
| Enter the water | Automatically move the surfboard under the feet |
| Release movement while surfing | Stop horizontal movement when grounded |

Moving jumps keep the horizontal velocity at takeoff, even when movement keys
are released in the air. Stationary jumps stay in place. The rider and board lift
together during water jumps. Normal movement controls resume on landing.

There are no number-key spells, hollow barrel-wave obstacles or F1 settings page.
The screen also has no speed streaks, radial speed blur or speed-based FOV widening.

## Ocean and coast

The coast meanders along world X, with water on the positive-Z side of the local
shoreline. Terrain and ocean use player-centred clipmaps: a bounded set of nested
meshes follows the rider instead of storing an entire world.

Five directional swells displace the water. Their heights are mirrored by the CPU
surface query, so the rider and board follow the same waves that are rendered.
Wave sets smoothly alternate between smaller and larger swells every **30 seconds**.
Fine surface detail is filtered at a distance.

Shallow teal water deepens offshore and reflects the sky. A shared swash front
coordinates foam on the water and wet beach sand. Breaking bands, crest foam and
a V-shaped wake provide motion detail without screen-space speed effects.

Sea-side terrain is clipped out of the visible and depth passes and lowered below
wave troughs. Water is rendered from both sides, and reflections exclude the sky
texture's sand-colored ground hemisphere to avoid tan bands on steep wave faces.

The first **22 metres** of beach remain clear of grass. Shrubs and trees begin
farther inland, with deterministic placement in a bounded window around the rider.

## Day and night

The scene starts at **10:00**. A full sunrise, daylight, sunset and moonlit night
lasts **five minutes** by default. The sun and moon follow opposite continuous arcs,
and seeded spherical star positions provide a stable, scattered night sky.

The visible sky, ambient light, water reflections and haze share the same sky
texture. Adaptive exposure eases between day and night, and the clock advances
independently from the movement simulation timestep.

## Rider and rendering

The rider wears a cream sleeveless top, teal board shorts, blue sunglasses and
brown swept hair, with exposed arms, legs and bare feet. Procedural skeleton
animation and planted-foot IK drive walking and running. Hair and accessories
share the body's skinning, shadow and depth passes.

Rendering includes cascaded shadows, a camera depth prepass, temporal antialiasing,
bloom, tone mapping, sharpening and subtle grain. Depth of field is available but
**disabled by default**.

## Blender assets

The editable source files are `assets/surfboard.blend`, `assets/rider.blend` and
`assets/coastal_vegetation.blend`. The rider starts from the original procedural
mesh, retains its skin weights, and has a subtle Blender hair adjustment. Their generated geometry is checked in under
`src/assets/` and uses the existing custom skinning and vegetation shaders.
Run the scripts in `tools/` with Blender in background mode to rebuild the scenes
and exports. The board and vegetation scripts rebuild their scenes, so edit the
scripts for reproducible changes. Export rider changes with
`blender --background assets/rider.blend --python tools/export_rider.py`; preserve
the point attributes that carry the game’s material and skinning data.

## Development

```text
src/
  character/    rider geometry, skeleton, cloth, movement and sand contact
  core/         input, camera, settings, solar clock, loading and performance
  post/         post-processing chain
  render/       sky, shadows and depth prepass
  shaders/      native GLSL surfaces, shared includes and post shaders
  terrain/      analytic coast, clipmap and local deformation
  vfx/          pooled spray particles and wake geometry
  world/        ocean and coastal vegetation
```

Edit `.glsl` shaders directly. Shared libraries are registered as Babylon shader
includes; Vite imports shader strings with `.glsl?raw`. There is no WGSL source,
shader translator or alternate renderer in the application.

Tuning values live in `src/core/settings.js`. The `SurferFlow` handle in the browser
console exposes the running scene for development inspection.

### Dependencies

| Package | Role |
|---|---|
| `@babylonjs/core` | WebGL 2 engine, scene, meshes, materials and math |
| `vite` | Development server, raw shader imports and production bundling; development dependency |

`package.json` defines those dependencies and the npm commands. `package-lock.json`
records resolved versions for reproducible installs. `vite.config.js` holds the
server, build and asset settings. No additional Babylon material package is used.

## License

[MIT](LICENSE)
