const baseUrl = process.env.API_BASE_URL || "http://localhost:5000/api";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${body?.error || "Unknown error"}`);
  return body;
}

const health = await request("/health");
if (health.status !== "ok") throw new Error("Health check did not return ok.");

const owner = await request("/auth/owner/login", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "owner123" }) });
const ownerData = await request("/bootstrap", { headers: { Authorization: `Bearer ${owner.token}` } });
if (!ownerData.owners.length || !ownerData.pets.length) throw new Error("Owner bootstrap data is incomplete.");

const admin = await request("/auth/admin/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin123" }) });
const adminData = await request("/bootstrap", { headers: { Authorization: `Bearer ${admin.token}` } });
if (!adminData.owners.length) throw new Error("Admin bootstrap data is incomplete.");

const rescue = await request("/public/pets/mochi-rescue-demo");
if (rescue.pet?.name !== "Mochi") throw new Error("Public rescue profile is unavailable.");

console.log("Smoke test passed: health, owner auth, admin auth, bootstrap, and public rescue profile.");
