/** Keep a jumping rider above the animated water while tracking its height. */
export function syncWaterSurface(character, surfaceY) {
    character.groundY = surfaceY;
    character.position.y = surfaceY + character.jumpHeight;
}
