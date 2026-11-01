import test from 'node:test';
import assert from 'node:assert/strict';
import { syncWaterSurface } from '../src/character/waterSurface.js';
import { S, applyPreset } from '../src/core/settings.js';

test('water follows waves without cancelling an airborne jump', () => {
    const rider = { position: { y: 0 }, groundY: 0, jumpHeight: 1.4 };
    syncWaterSurface(rider, -0.25);
    assert.equal(rider.groundY, -0.25);
    assert.equal(rider.position.y, 1.15);
    rider.jumpHeight = 0;
    syncWaterSurface(rider, 0.8);
    assert.equal(rider.position.y, 0.8);
});

test('quality presets restore their own rendering settings', () => {
    applyPreset('ultra');
    assert.equal(S.resolutionScale, 1);
    assert.equal(S.ssr, true);
    assert.equal(S.shadowResolution, 2048);
    applyPreset('balanced');
    assert.equal(S.resolutionScale, 0.85);
    assert.equal(S.ssr, false);
    assert.equal(S.shadowResolution, 1024);
});
