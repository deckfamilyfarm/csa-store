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

export async function fetchCatalog() {
  return fetchJsonGet(`${base}/catalog`, "", "Failed to load catalog");
}

export async function submitReview({ productId, rating, title, body }, token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/reviews`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ productId, rating, title, body })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to submit review");
  }

  return response.json();
}

export async function fetchMyReviews(productId, token) {
  const url = new URL(`${base}/reviews/mine`, window.location.origin);
  if (productId) {
    url.searchParams.set("productId", String(productId));
  }
  return fetchJsonGet(url.toString(), token, "Unable to load reviews");
}

export async function updateReview(reviewId, payload, token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/reviews/${reviewId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Unable to update review");
  }
  return response.json();
}

export async function deleteReview(reviewId, token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/reviews/${reviewId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Unable to delete review");
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

  if (!response.ok) await throwForError(response, "Invalid credentials");

  return response.json();
}

export async function userLogin(username, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) await throwForError(response, "Invalid credentials");

  return response.json();
}

export async function requestPasswordReset(username) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to request password reset");
  }

  return response.json();
}

export async function resetPasswordWithToken(token, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to reset password");
  }

  return response.json();
}

export async function changePassword(token, currentPassword, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/change-password`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ currentPassword, password })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to change password");
  }

  return response.json();
}

export async function fetchMe(token) {
  return fetchJsonGet(`${base}/auth/me`, token, "Unauthorized");
}
