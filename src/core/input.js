/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock. Space jumps on land and water; Shift increases movement speed.
 */

export const input = {
    // Movement axes, camera-relative, already normalised to a unit disc.
    moveX: 0,
    moveZ: 0,
    moving: false,

    // Accumulated mouse delta since last `endFrame()`, in radians.
    lookX: 0,
    lookY: 0,

    // Zoom, consumed by the camera rig.
    zoomDelta: 0,

    jumpPressed: false, // one press, cleared after the frame
    sprint: false, // Shift on land and water

    locked: false,
};

const keys = Object.create(null);

const LOOK_SCALE = 0.0022;
const touchMove = { x: 0, z: 0, sprint: false };

/**
 * @param {HTMLCanvasElement} canvas
 */
export function initInput(canvas) {
    let dragPointer = null;
    let lastX = 0, lastY = 0;
    let dragDistance = 0;
    let lastPointerType = "mouse";
    const lookTouches = new Map();
    let pinchDistance = 0;
    function touchDistance() {
        const [a, b] = [...lookTouches.values()];
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    }
    canvas.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        lastPointerType = e.pointerType;
        canvas.setPointerCapture(e.pointerId);
        if (e.pointerType === "touch") {
            lookTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (lookTouches.size >= 2) { pinchDistance = touchDistance(); return; }
        }
        dragPointer = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        dragDistance = 0;
    });
    canvas.addEventListener("pointermove", (e) => {
        if (e.pointerType === "touch" && lookTouches.has(e.pointerId)) {
            lookTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (lookTouches.size >= 2) {
                const distance = touchDistance();
                if (pinchDistance > 0 && distance > 0) {
                    input.zoomDelta -= Math.log(distance / pinchDistance) * 2.5;
                }
                pinchDistance = distance;
                return;
            }
        }
        if (input.locked || e.pointerId !== dragPointer) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        dragDistance += Math.abs(dx) + Math.abs(dy);
        input.lookX += dx * LOOK_SCALE;
        input.lookY += dy * LOOK_SCALE;
    });
    const stopDrag = (e) => {
        lookTouches.delete(e.pointerId);
        pinchDistance = touchDistance();
        if (e.pointerId === dragPointer || lookTouches.size === 1) {
            const remaining = lookTouches.entries().next();
            if (!remaining.done) {
                dragPointer = remaining.value[0];
                lastX = remaining.value[1].x;
                lastY = remaining.value[1].y;
            } else dragPointer = null;
        }
    };
    canvas.addEventListener("pointerup", stopDrag);
    canvas.addEventListener("pointercancel", stopDrag);
    canvas.addEventListener("lostpointercapture", stopDrag);
    canvas.addEventListener("click", () => {
        // A drag should not unexpectedly lock the pointer when released.
        if (lastPointerType === "mouse" && !input.locked && dragDistance < 4) {
            try { canvas.requestPointerLock()?.catch(() => {}); } catch { /* drag fallback */ }
        }
    });

    document.addEventListener("pointerlockchange", () => {
        input.locked = document.pointerLockElement === canvas;
        if (!input.locked) {
            // Drop held state so the character doesn't run off while unfocused.
            for (const k in keys) keys[k] = false;
            input.jumpPressed = false;
            input.sprint = false;
        }
    });

    document.addEventListener("mousemove", (e) => {
        if (!input.locked) return;
        input.lookX += e.movementX * LOOK_SCALE;
        input.lookY += e.movementY * LOOK_SCALE;
    });

    // Wheel, two-finger trackpad scroll and browser pinch gestures zoom even
    // when pointer lock is unavailable. Horizontal scroll turns the camera.
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
        input.zoomDelta += e.deltaY * scale * 0.0016;
        if (!e.ctrlKey && !e.metaKey) input.lookX += e.deltaX * scale * LOOK_SCALE;
    }, { passive: false });
    document.getElementById("zoom-in")?.addEventListener("click", () => { input.zoomDelta -= 0.65; });
    document.getElementById("zoom-out")?.addEventListener("click", () => { input.zoomDelta += 0.65; });

    // Each direction tracks its own pointer so two buttons can be held for
    // diagonal movement while another finger controls the camera.
    const moveButtons = [
        ["move-up", 0, 1], ["move-down", 0, -1],
        ["move-left", -1, 0], ["move-right", 1, 0],
    ];
    const heldMoves = new Map();
    function updateTouchMove() {
        let x = 0, z = 0;
        for (const move of heldMoves.values()) { x += move.x; z += move.z; }
        touchMove.x = Math.max(-1, Math.min(1, x));
        touchMove.z = Math.max(-1, Math.min(1, z));
    }
    for (const [id, x, z] of moveButtons) {
        const button = document.getElementById(id);
        button?.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            heldMoves.set(e.pointerId, { x, z, button });
            button.classList.add("active");
            button.setPointerCapture(e.pointerId);
            updateTouchMove();
        });
        const release = (e) => {
            if (heldMoves.get(e.pointerId)?.button !== button) return;
            heldMoves.delete(e.pointerId);
            if (![...heldMoves.values()].some((move) => move.button === button)) button.classList.remove("active");
            updateTouchMove();
        };
        for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) button?.addEventListener(event, release);
    }
    function resetPad() {
        for (const move of heldMoves.values()) move.button.classList.remove("active");
        heldMoves.clear();
        updateTouchMove();
    }

    const jump = document.getElementById("touch-jump");
    jump?.addEventListener("pointerdown", (e) => { e.preventDefault(); input.jumpPressed = true; });
    const sprint = document.getElementById("touch-sprint");
    let sprintPointer = null;
    sprint?.addEventListener("pointerdown", (e) => {
        if (sprintPointer !== null) return;
        e.preventDefault(); sprintPointer = e.pointerId; touchMove.sprint = true;
        sprint.classList.add("active"); sprint.setPointerCapture(e.pointerId);
    });
    function resetSprint(e) {
        if (e && e.pointerId !== sprintPointer) return;
        sprintPointer = null; touchMove.sprint = false; sprint?.classList.remove("active");
    }
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) sprint?.addEventListener(event, resetSprint);

    window.addEventListener("keydown", (e) => {
        if (e.code === "Space" && input.locked) e.preventDefault();
        if (e.repeat) return;
        keys[e.code] = true;
        if (e.code === "Space") input.jumpPressed = true;

    });

    window.addEventListener("keyup", (e) => {
        if (e.code === "Space" && input.locked) e.preventDefault();
        keys[e.code] = false;

    });

    window.addEventListener("blur", () => {
        for (const k in keys) keys[k] = false;
        input.jumpPressed = false;
        input.sprint = false;
        resetPad();
        resetSprint();
        lookTouches.clear();
        dragPointer = null;
        pinchDistance = 0;
    });
}

/** Resolve held keys into movement axes. Called once per frame before update. */
export function pollInput() {
    let x = touchMove.x;
    let z = touchMove.z;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;

    // Clamp to a unit disc so diagonals aren't faster.
    const len = Math.sqrt(x * x + z * z);
    if (len > 1) {
        x /= len;
        z /= len;
    }
    input.moveX = x;
    input.moveZ = z;
    input.moving = len > 0.001;
    input.sprint = touchMove.sprint || !!(keys.ShiftLeft || keys.ShiftRight);
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
    input.zoomDelta = 0;

    input.jumpPressed = false;
}

export function isDown(code) {
    return !!keys[code];
}
