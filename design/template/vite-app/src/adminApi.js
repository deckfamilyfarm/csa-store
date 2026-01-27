const base = import.meta.env.VITE_API_BASE || "/api";

export async function adminLogin(username, password) {
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

export async function adminGet(path, token) {
  const response = await fetch(`${base}/admin/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error("Admin request failed");
  return response.json();
}

export async function adminPut(path, token, body) {
  const response = await fetch(`${base}/admin/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error("Admin update failed");
  return response.json();
}

export async function adminPost(path, token, body) {
  const response = await fetch(`${base}/admin/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error("Admin create failed");
  return response.json();
}

export async function adminUploadImage(productId, token, file) {
  const form = new FormData();
  form.append("image", file);
  const response = await fetch(`${base}/admin/products/${productId}/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });
  if (!response.ok) throw new Error("Upload failed");
  return response.json();
}
