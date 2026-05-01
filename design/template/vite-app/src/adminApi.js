const base = import.meta.env.VITE_API_BASE || "/api";
const inflightGetRequests = new Map();

function getRequestKey(url, token = "") {
  return `${url}::${token}`;
}

async function throwForError(response, fallbackMessage) {
  let detail = "";
  try {
    const payload = await response.json();
    detail = payload?.detail || payload?.error || "";
  } catch (error) {
    try {
      detail = (await response.text()) || "";
    } catch (textError) {
      detail = "";
    }
  }

  const error = new Error(detail || fallbackMessage);
  error.status = response.status;
  throw error;
}

async function fetchJsonGet(url, token, fallbackMessage) {
  const requestKey = getRequestKey(url, token);
  if (inflightGetRequests.has(requestKey)) {
    return inflightGetRequests.get(requestKey);
  }

  const requestPromise = (async () => {
    const response = await fetch(url, {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });
    if (!response.ok) await throwForError(response, fallbackMessage);
    return response.json();
  })();

  inflightGetRequests.set(requestKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    inflightGetRequests.delete(requestKey);
  }
}

export async function adminLogin(username, password) {
  const response = await fetch(`${base}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) await throwForError(response, "Invalid credentials");

  return response.json();
}

export async function adminGet(path, token) {
  return fetchJsonGet(`${base}/admin/${path}`, token, "Admin request failed");
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
  if (!response.ok) await throwForError(response, "Admin update failed");
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
  if (!response.ok) await throwForError(response, "Admin create failed");
  return response.json();
}

export async function adminDelete(path, token) {
  const response = await fetch(`${base}/admin/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) await throwForError(response, "Admin delete failed");
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
  if (!response.ok) await throwForError(response, "Upload failed");
  return response.json();
}

export async function adminDeleteImage(productId, token, payload) {
  const response = await fetch(`${base}/admin/products/${productId}/images/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) await throwForError(response, "Image delete failed");
  return response.json();
}
