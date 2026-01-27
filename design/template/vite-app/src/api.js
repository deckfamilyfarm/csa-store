export async function fetchCatalog() {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/catalog`);
  if (!response.ok) {
    throw new Error("Failed to load catalog");
  }
  return response.json();
}

export async function adminLogin(username, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) {
    throw new Error("Invalid credentials");
  }

  return response.json();
}

export async function userLogin(email, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    throw new Error("Invalid credentials");
  }

  return response.json();
}

export async function fetchMe(token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error("Unauthorized");
  }
  return response.json();
}
