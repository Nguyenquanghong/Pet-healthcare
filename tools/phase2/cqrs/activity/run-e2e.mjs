// D4 real-stack browser E2E on the dedicated pet-phase2-p1-test project only.
// Selects the isolated activity mode of tools/phase2/e2e-server.mjs (fresh marked
// Clinic schema, V2 rebuild, CLINIC_ACTIVITY_MODE=control, evidence sampler).
process.env.ACTIVITY_D4_E2E='1';
await import('../../run-e2e.mjs');
